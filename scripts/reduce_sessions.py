#!/usr/bin/env python3
"""
reduce_sessions.py — shrink a Notera session-export JSON down to only the fields the
admin importer actually uses, and strip junk HTML out of the transcript / SOAP-note text.

Why: the raw export carries many unused fields, and some `transcript` / `soap_note` values
contain an entire HTML web page (scripts, styles, markup) that bloats the file for no value.

The admin importer (packages/backend/src/admin/handler.js  → POST /api/patients/import) reads:
    name        ← session_title | patient_name_fallback | subtitle | "Session <id>"
    transcript  ← transcript.clean_text | transcript.raw_text     (a plain string also works)
    gold_note   ← soap_note.soap_note | assessment | plan | summary (a plain string also works)
    dedupe key  ← heidi_session_id
    (optional)  ← source_url, subtitle, tags

The reduced record keeps the SAME schema shape (so the importer detects the fields):
    {
      "heidi_session_id": "...",
      "session_title": "...",
      "transcript": { "raw_text": "...clean text..." },
      "soap_note":  { "soap_note": "...clean text..." },
      "source_url": "..."            # optional
    }
Only these keys are kept; every other field is dropped and the transcript/soap_note text is
HTML-stripped. transcript/soap_note remain OBJECTS with their original inner keys.

Stdlib only (no pip installs). Python 3.8+.

Usage:
    python scripts/reduce_sessions.py all_sessions_anon.json
    python scripts/reduce_sessions.py in.json -o out.json --indent 2
    python scripts/reduce_sessions.py in.json --keep heidi_session_id session_title transcript soap_note
    python scripts/reduce_sessions.py in.json --max-note-chars 60000   # cap huge notes
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, List, Optional, Tuple

# Fields the reduced output may contain (all flat; importer-compatible).
ALLOWED_FIELDS: Tuple[str, ...] = ("heidi_session_id", "session_title", "transcript", "soap_note", "source_url")
DEFAULT_KEEP: List[str] = ["heidi_session_id", "session_title", "transcript", "soap_note"]

_TAG_RE = re.compile(r"<[a-zA-Z/!][^>]*>")


# ── HTML → plain text (stdlib) ────────────────────────────────────────────────
class _HTMLStripper(HTMLParser):
    """Collect visible text; drop <script>/<style>/<head> content; turn block tags into newlines."""

    _DROP = {"script", "style", "head", "noscript"}
    _BREAK = {"br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "ul", "ol", "table"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._buf: List[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self._DROP:
            self._skip_depth += 1
        elif tag in self._BREAK:
            self._buf.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._DROP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._buf.append(data)

    def text(self) -> str:
        return "".join(self._buf)


def looks_like_html(s: str) -> bool:
    if not s:
        return False
    low = s.lower()
    if any(marker in low for marker in ("<!doctype", "<html", "<head", "<body", "<div", "<span", "<script", "<style")):
        return True
    return len(_TAG_RE.findall(s)) >= 5


def strip_html(s: str) -> str:
    parser = _HTMLStripper()
    try:
        parser.feed(s)
        parser.close()
        out = parser.text()
    except Exception:
        out = _TAG_RE.sub(" ", s)  # fallback: brute-force tag removal
    out = html.unescape(out)
    out = re.sub(r"[ \t ]+", " ", out)
    out = re.sub(r" *\n *", "\n", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


# ── field extraction ──────────────────────────────────────────────────────────
def extract_text(value: Any, keys: Tuple[str, ...]) -> Tuple[str, bool]:
    """Return (clean_text, was_html). Accepts str, dict (join `keys`), or None."""
    if value is None:
        return "", False
    if isinstance(value, str):
        raw = value
    elif isinstance(value, dict):
        parts = [str(value[k]).strip() for k in keys if isinstance(value.get(k), str) and value[k].strip()]
        raw = "\n\n".join(parts)
    else:
        return "", False
    was_html = looks_like_html(raw)
    text = strip_html(raw) if was_html else raw.strip()
    return text, was_html


def pick_name(s: dict) -> str:
    for k in ("session_title", "patient_name_fallback", "subtitle"):
        v = s.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    ident = s.get("id")
    return f"Session {ident}".strip() if ident is not None else "Session"


@dataclass
class Stats:
    total: int = 0
    kept: int = 0
    dropped_empty: int = 0
    html_cleaned: int = 0
    malformed: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    field_counts: dict = field(default_factory=dict)


def reduce_session(s: Any, keep: List[str], min_chars: int, stats: Stats) -> Optional[dict]:
    if not isinstance(s, dict):
        stats.malformed += 1
        return None

    transcript, t_html = extract_text(s.get("transcript"), ("clean_text", "raw_text"))
    note_src = s.get("soap_note") if s.get("soap_note") is not None else (s.get("note") if s.get("note") is not None else s.get("notes"))
    soap_note, n_html = extract_text(note_src, ("soap_note", "assessment", "plan", "summary"))
    if t_html or n_html:
        stats.html_cleaned += 1

    # Nothing usable → drop (matches the importer, and saves space here).
    if len(transcript) < min_chars and len(soap_note) < min_chars:
        stats.dropped_empty += 1
        return None

    # IMPORTANT: keep the ORIGINAL schema shape so the importer detects the fields —
    # transcript stays an object with `raw_text`, soap_note stays an object with `soap_note`.
    out: dict = {}
    if "heidi_session_id" in keep and isinstance(s.get("heidi_session_id"), str) and s["heidi_session_id"]:
        out["heidi_session_id"] = s["heidi_session_id"]
    if "session_title" in keep:
        out["session_title"] = pick_name(s)
    if "transcript" in keep and transcript:
        out["transcript"] = {"raw_text": transcript}
    if "soap_note" in keep and soap_note:
        out["soap_note"] = {"soap_note": soap_note}
    if "source_url" in keep and isinstance(s.get("source_url"), str) and s["source_url"]:
        out["source_url"] = s["source_url"]

    for k in out:
        stats.field_counts[k] = stats.field_counts.get(k, 0) + 1
    return out


def load_sessions(path: Path) -> List[Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in ("sessions", "data"):
            if isinstance(data.get(k), list):
                return data[k]
    raise ValueError("expected a JSON array, or an object with a 'sessions'/'data' array")


def human_mb(n: int) -> str:
    return f"{n / 1_048_576:.2f} MB"


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Reduce a Notera session export to importer-ready fields, stripping junk HTML.")
    ap.add_argument("input", type=Path, help="path to the session-export JSON")
    ap.add_argument("-o", "--output", type=Path, default=None, help="output path (default: <input>.reduced.json)")
    ap.add_argument("--keep", nargs="+", default=DEFAULT_KEEP, metavar="FIELD",
                    help=f"fields to keep (subset of: {', '.join(ALLOWED_FIELDS)}); default: {' '.join(DEFAULT_KEEP)}")
    ap.add_argument("--min-chars", type=int, default=5, help="drop a session if transcript AND note are both shorter than this")
    ap.add_argument("--max-note-chars", type=int, default=0, help="truncate transcript/soap_note to N chars (0 = no cap)")
    ap.add_argument("--indent", type=int, default=2, help="pretty-print indent (default 2, readable like the original; use 0 for smallest compact file)")
    args = ap.parse_args(argv)

    bad = [f for f in args.keep if f not in ALLOWED_FIELDS]
    if bad:
        print(f"error: unknown --keep field(s): {', '.join(bad)} (allowed: {', '.join(ALLOWED_FIELDS)})", file=sys.stderr)
        return 2
    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2

    out_path: Path = args.output or args.input.with_name(args.input.stem + ".reduced.json")
    stats = Stats(bytes_in=args.input.stat().st_size)

    try:
        sessions = load_sessions(args.input)
    except json.JSONDecodeError as e:
        print(f"error: invalid JSON in {args.input}: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"error: could not read {args.input}: {e}", file=sys.stderr)
        return 2

    reduced: List[dict] = []
    for s in sessions:
        stats.total += 1
        try:
            rec = reduce_session(s, args.keep, args.min_chars, stats)
        except Exception as e:  # noqa: BLE001 — never let one bad record abort the run
            stats.malformed += 1
            print(f"  warn: skipped a malformed session ({e})", file=sys.stderr)
            continue
        if rec is None:
            continue
        if args.max_note_chars > 0:
            for k in ("transcript", "soap_note"):
                if k in rec and len(rec[k]) > args.max_note_chars:
                    rec[k] = rec[k][: args.max_note_chars].rstrip() + " …[truncated]"
        reduced.append(rec)
        stats.kept += 1

    try:
        out_path.write_text(json.dumps(reduced, ensure_ascii=False, indent=(args.indent or None)), encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        print(f"error: could not write {out_path}: {e}", file=sys.stderr)
        return 2
    stats.bytes_out = out_path.stat().st_size

    saved = stats.bytes_in - stats.bytes_out
    pct = (saved / stats.bytes_in * 100) if stats.bytes_in else 0.0
    print("── reduce_sessions summary ─────────────────────────────")
    print(f"  input            {args.input}  ({human_mb(stats.bytes_in)})")
    print(f"  output           {out_path}  ({human_mb(stats.bytes_out)})")
    print(f"  sessions total   {stats.total}")
    print(f"  kept             {stats.kept}")
    print(f"  dropped (empty)  {stats.dropped_empty}")
    print(f"  html cleaned     {stats.html_cleaned}")
    print(f"  malformed        {stats.malformed}")
    print(f"  space saved      {human_mb(saved)}  ({pct:.0f}%)")
    print(f"  kept fields      {', '.join(args.keep)}")
    if stats.field_counts:
        print("  field coverage   " + ", ".join(f"{k}={v}" for k, v in stats.field_counts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

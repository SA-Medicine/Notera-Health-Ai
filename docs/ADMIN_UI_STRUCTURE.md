# Admin console — recommended structure, components and how to use them

Why this exists: the first version put every feature behind one "Lab" screen with drawers, so results, comparisons and logs were hard to find. This is the rewritten structure. It separates **two products** that share one site and orders the screens in the order you use them.

## 1. Two areas, never mixed

| Area | Purpose | Touches production? | Where it runs |
|---|---|---|---|
| **Admin** | Watch and control the live product: users, notes, audio, pipeline map, prompts, settings | **Yes** — prompts live in ≤60 s, settings in ≤30 s; every change audited and reversible | Backend on the Google VM (`/api/console/*`) |
| **Harness** | Test and improve the note writer on gold notes, your own transcripts and audio | **No** — separate `notera-lab` container (memory-capped), results stored in its own volume. Production only changes when you press *Promote* | Lab container on the same VM (`/lab/*`, key-protected, admin session required) |

Both are served by one static site + Worker in a separate Cloudflare account, so none of this load reaches the clinician website.

## 2. Navigation (top to bottom = how you use it)

```
Start here                  ← what to do first, live progress per step

ADMIN · MONITOR
  Overview  Users  Notes  Audio  Activity
ADMIN · CONTROL PRODUCTION
  System    Prompts  Settings

HARNESS · TEST AND IMPROVE   (numbered = the order to use them)
  1 · Run & inputs     choose notes / paste transcript / upload audio → run
  2 · Review notes     every generated note BESIDE its gold note, audit, transcript, pipeline log
  3 · Compare runs     per-metric statistics and per-note winners (two runs, same notes)
  3 · Blind judge      order-swapped LLM judge: completeness, accuracy, hallucinations, misses
  4 · Diagnose         overall analysis of the whole run → patterns, stage to blame, recommendations
  5 · Improve          propose a better prompt → validate on unseen notes → gate → promote
  Trends               quality and speed across all runs

TOOLS
  Pipeline log   Test bench (audio through the real pipeline)
```

The sidebar scrolls; the user block stays pinned at the bottom.

## 3. The two kinds of comparison (you asked for both)

| | Per note | Overall |
|---|---|---|
| Question | "What does **this** note lack or get wrong compared with its gold note?" | "What is wrong with the **system**, and what do I change first?" |
| Screen | **Review notes** → *Note vs Gold* (side by side) and *What it lacks / got wrong* (audit) | **Diagnose** (and **Compare runs / Blind judge** for A vs B) |
| Engine | One LLM audit per note against transcript + gold: missing facts, wrong/unsupported claims, padding, structure, strengths, root-cause stage | One LLM diagnosis over many audits + run metrics + **pipeline-log statistics** (verifier removals, cleanup removals, checklist merges, stage times) |
| Output | Verdict, score, lists, most likely stage at fault | Headline, patterns with counts, stage-blame chart, prioritised recommendations with status (open / accepted / done / dismissed) |
| Stored | `analysis/<run>.json` (cached) | `reports/<id>.json` |

## 4. The pipeline "inside" (logs and intermediate data)

Every harness run now stores, for each note, the pipeline log lines and a trace: the writer's raw JSON, the checklist the helper extracted, the verifier's result, the prompt versions and settings used, and per-stage timings. Open **Review notes → Pipeline log** to see them as a four-stage strip (Writer → Checklist → Merge & cleanup → Verifier) plus the raw data and the log. Production notes carry the same prompt/setting trace under **Notes → Pipeline → Produced with**.

## 5. Component → use

| Component | Where | Use it to |
|---|---|---|
| Step cards (Start here) | Start here | See the next thing to do; green tick = done |
| Segmented control | Run & inputs (input type, note selection), Review notes filter | Switch mode without leaving the screen |
| Note picker (search + checkbox list) | Run & inputs → Pick & search | Choose exact gold notes; *Select all shown* respects the search |
| Run table | Run & inputs, Trends | Status, scores, **Review notes**, Re-run, Stop, CSV |
| Note list with traffic lights | Review notes (left) | Worst-first list; green/amber/red from similarity & omission; badge shows audit verdict |
| Side-by-side panes | Review notes, Compare drawer (A / B / Gold), Run & inputs (own transcript) | Read generated vs gold without clicking anything |
| Audit panel | Review notes → *What it lacks / got wrong* | Missing facts, wrong claims, padding, structure, root-cause stage |
| Pipeline strip + raw data | Review notes → *Pipeline log* | See what each stage produced for this note |
| Paired-statistics table | Compare runs | Mean change, notes better/worse, sign-test p, verdict |
| Judge cards + per-note verdict buttons | Blind judge | Wins (order-swapped), hallucination/miss counts, your own A/B/Tie to calibrate (κ) |
| Pattern table, stage-blame chart | Diagnose | Recurring failures and which stage causes them |
| Recommendation cards with status | Diagnose | Track each change: open → accepted → done / dismissed; jump to Prompts / Settings / Improve |
| Gate checklist | Improve | See exactly why a candidate can or cannot be promoted |
| Prompt editor + diff + history | Prompts | Edit, review changes, save a version, roll back |
| Setting rows (value, default, source, Save, Reset) | Settings | Change a model/limit; see what is overridden and by whom |
| Pipeline map + health charts | System | What runs in production and how it is doing |

## 6. Recommended first session

1. **Start here** → follow the highlighted step.
2. **Run & inputs** → *Gold notes → Random 20* → writer model → *Start*. Wait ~2 minutes.
3. **Review notes** → open the red notes first; read *Note vs Gold*, press *Audit this note*, check *Pipeline log*.
4. **Diagnose** → *Generate overall diagnosis* → read patterns → mark recommendations accepted.
5. Apply them: **Prompts** / **Settings**, or **Improve** for the writer prompt.
6. **Run & inputs** → *Re-run* the same notes → **Compare runs** → did it help? **Blind judge** for a second opinion.
7. When a change proves itself on unseen notes, it is already live (Prompts/Settings) or promoted (Improve). Watch **System** and **Trends**.

## 7. Known limits

* Only the writer prompt has the automated improve loop; checklist and verifier prompts are edited by hand in Prompts.
* The audit/diagnosis use gemini-2.5-pro and cost a few cents per run; they are never run automatically.
* Gold notes are one clinician's style; similarity and omission are proxies. Use audits and the judge, and keep a clinician in the loop for anything promoted.

"""
Notera-Health-Ai — Python NER sidecar (doc 06 §3, 07 §4)

FastAPI service that extracts structured medical entities from a transcript:
medications (drug/dose/frequency/route via Med7), diseases + chemicals (scispaCy
bc5cdr), and negation/section context (medspaCy ConText). Entities do double duty:
they GROUND Gemini's prompt and VALIDATE its output (the med/dose cross-check).

All models are free/open and run locally — no PHI leaves this service (doc 04 §1).
Models are loaded lazily and cached; missing models degrade gracefully so the
service still boots (useful in CI / before model wheels are installed).

Run locally:  uvicorn main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("notera-ner")

app = FastAPI(title="Notera-Health-Ai NER", version="1.0.0")

# Which spaCy pipelines to try, in priority order. Each is optional at runtime.
MODELS = {
    "med7": os.getenv("MED7_MODEL", "en_core_med7_lg"),      # medications: drug/dose/freq/route
    "scispacy": os.getenv("SCISPACY_MODEL", "en_ner_bc5cdr_md"),  # diseases + chemicals
}


class NerRequest(BaseModel):
    text: str


class Entity(BaseModel):
    text: str
    label: str
    start: int
    end: int
    source: str
    negated: Optional[bool] = None


class NerResponse(BaseModel):
    entities: List[Entity]
    models_loaded: List[str]


@lru_cache(maxsize=1)
def _load_pipelines():
    """Load available spaCy pipelines once (cold start). Returns {source: nlp}."""
    pipelines = {}
    try:
        import spacy  # noqa: WPS433
    except Exception as exc:  # spaCy not installed
        log.warning("spaCy unavailable: %s", exc)
        return pipelines

    for source, model_name in MODELS.items():
        try:
            pipelines[source] = spacy.load(model_name)
            log.info("Loaded %s (%s)", model_name, source)
        except Exception as exc:  # model wheel not installed
            log.warning("Could not load %s (%s): %s", model_name, source, exc)

    # medspaCy adds negation/section context on top of a base pipeline (doc 06 §3).
    if pipelines:
        try:
            import medspacy  # noqa: WPS433
            from medspacy.context import ConTextComponent  # noqa: F401

            base = next(iter(pipelines.values()))
            if "medspacy_context" not in base.pipe_names:
                base.add_pipe("medspacy_context")
                log.info("Added medspaCy ConText (negation) to base pipeline")
        except Exception as exc:
            log.warning("medspaCy context unavailable: %s", exc)

    return pipelines


def _is_negated(ent) -> Optional[bool]:
    # medspaCy sets ._.is_negated when ConText is active.
    try:
        return bool(ent._.is_negated)  # type: ignore[attr-defined]
    except Exception:
        return None


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "notera-ner", "models_loaded": list(_load_pipelines().keys())}


@app.post("/ner", response_model=NerResponse)
def ner(req: NerRequest):
    pipelines = _load_pipelines()
    entities: List[Entity] = []
    seen = set()  # dedupe identical (text, label, start)

    for source, nlp in pipelines.items():
        try:
            doc = nlp(req.text)
        except Exception as exc:
            log.warning("Pipeline %s failed on input: %s", source, exc)
            continue
        for ent in doc.ents:
            key = (ent.text.lower(), ent.label_, ent.start_char)
            if key in seen:
                continue
            seen.add(key)
            entities.append(
                Entity(
                    text=ent.text,
                    label=ent.label_,
                    start=ent.start_char,
                    end=ent.end_char,
                    source=source,
                    negated=_is_negated(ent),
                )
            )

    return NerResponse(entities=entities, models_loaded=list(pipelines.keys()))

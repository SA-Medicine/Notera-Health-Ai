# Data

The crown jewel (doc `02`). `(transcript → gold note)` pairs are a ready-made
supervised dataset. Treat it as such: version it, back it up, never train on the
frozen test split.

```
data/
├── gold/            # source pairs: transcript + gold note (split at "Subjective:")
├── out/             # BUILD OUTPUT (git-ignored) — structured dataset + tuning files
└── build_dataset.mjs
```

## Build

```bash
node data/build_dataset.mjs
```

Produces in `data/out/`:

| File | Purpose |
|------|---------|
| `dataset.json` | every pair, structured into schema v1.0.0 |
| `train.jsonl` / `val.jsonl` / `test.jsonl` | supervised-tuning messages format (doc 02 §7) |
| `splits.json` | frozen split manifest — **never train on `test_ids`** |

## PHI

`gold/` here is treated as consented sample data. In a real pipeline, run the
de-identifier (`backend/src/deid`) before anything leaves the controlled
environment (doc `02 §5`, `04 §1`). The `out/` folder is git-ignored so structured
PHI is never committed.

## Flywheel

Every clinician-approved note in production (`consults/*/finals`) + its transcript
is a new gold pair. Export those (de-identified) into `gold/` periodically to grow
the dataset — the moat (doc `02 §8`, `03 §5`).

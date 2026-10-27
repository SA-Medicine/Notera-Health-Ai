# Audit tools (lab only)

Scripts used for the pipeline audit of 2026-10-27 (see `docs/AUDIT_REVIEW_AND_PLAN_2026-10-27.md`). They run inside the lab container (`notera-lab`, paths start with `/app` and `/lab-data`), on the output of `tools/gold-eval.mjs`.

| Script | What it does |
|---|---|
| `score-multi.mjs <runs...>` | Scores finished gold runs TOGETHER with shuffled notes: pro judge 3 passes (consensus) and fixed-fact recall. Writes `<run>-j3.json` and `<run>.recall.json`. Use this, not one run after another: the first run judged was always favoured. |
| `factrecall.mjs build` / `score` | Builds the fixed fact list (`/lab-data/gold-facts.json`; `GOLD_SET=` and `FACTS_FILE=` for another set) and scores recall on it. |
| `compare.mjs <runs-j3...>` | One table: score, critical misses (with and without synthetic-date artifacts), wrong lines, time, calls, tokens, cost, recall. |
| `paired.mjs <controls,comma> <arm>` | Per-note paired difference of an arm against its same-time control(s), with standard error. |
| `crit2.mjs`, `rejudge.mjs` | Which critical misses recur across runs; how noisy the judge alone is. |
| `taxonomy.mjs` | The paper's error taxonomy applied to the judge's wrong claims. |
| `timing.mjs`, `logstats.mjs`, `quick.mjs` | Time per stage, grounding and dose statistics from the logs, a one-line run summary. |
| `negeval.mjs`, `planeval.mjs` | Offline checks of `negationGuard.js` and `planActionCheck.js` on finished notes. |

Run each variant at the same time as a control (`--env=KEY=V` on `gold-eval`), at least 30 notes, then `score-multi` all runs together, then `compare` and `paired`. A difference smaller than about 2 standard errors is noise.

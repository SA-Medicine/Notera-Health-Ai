# Where the earlier "90+" came from, and what it takes to get it back

## 1. What the 90+ actually was

Not an absolute accuracy. It was the **Testing Lab comparator**: `overall_score` 0–100 from an LLM that reads the Notera note and the clinician's gold note side by side and rates how close they are (Faithfulness, Completeness, Structure, Clarity, each 0–5 for both notes, plus a verdict `notera_better | gold_better | equivalent`). Source: `COMPARATOR_SYS` in `packages/backend/src/admin/handler.js`; stored as `eval/results/<run>/<fixture>.compare.json` (642 files). I re-implemented it byte-for-byte in the lab (`POST /lab/parity`) so every number below is on **that** scale. It is a different, more lenient scale from the strict audit I used earlier (62).

What the history really says (all 642 stored scores): the old multi-agent pipeline scored **86–89 on every large run** (n = 24–96), with the best 11-fixture runs at 92–93 and **individual notes often 88–92**. The run behind your last good result (`run_2026-09-01_07-16-58`, 24 fixtures) averaged **89.1**.

## 2. Is the judge the reason it dropped? No

I re-scored the old stored notes with today's comparator: 89.1 → **90.2**, 89.3 → 89.5, 86.8 → 87.4. The judge has not drifted; the old notes still score 87–90.

## 3. Why today's runs are lower — measured on the same 24 fixtures, same judge

| Pipeline / model | Parity score (24 fixtures) | At 90+ | Time per note |
|---|---|---|---|
| **Old notes, stored (multi-agent v1 on gemini-3.7-flash, Sep 1)** | 90.2 (89.1 when scored then) | 20/24 | ~1–2 min |
| Old code (commit af75ad3) **re-run today**, Vertex gemini-3.7-flash, 6 of the fixtures | 77.8 (it scored 86.7 on those 6 then) | 1/6 | ~80 s |
| Current multi-agent v1 code, gemini-3.7-flash, production time caps | 75.0 | 3/23 | 82 s |
| Current multi-agent v1, long time caps | 81.4 | 6/24 | 62 s |
| Current multi-agent v1, gemini-2.5-flash | 70.8 | 2/22 | 60 s |
| **v2 (production design) + gemini-2.5-flash** | 85.3 | 8/23 | 6 s |
| **v2 + gemini-3.7-flash** | **87.3** | **14/22** | 10 s |
| v2 + 3.7-flash + extended recall | 82.0 | 9/24 | 11 s |

Findings:
1. **Agents are not what lifts the score.** Re-running the old multi-agent code today does *not* reproduce its Sep-1 numbers (77.8 vs 86.7 on the same fixtures; one fixture swung 92 → 60 between identical runs). With a 6–24 note sample, single fixtures move 10–30 points run to run, so "a run that scored 90" is largely luck of the draw plus the model.
2. **The model is the lever.** The old results used `gemini-3.7-flash` through AI Studio. Moving the v2 writer from `gemini-2.5-flash` to `gemini-3.7-flash` is the only change that moved every scale in the right direction.
3. The "proper agents" pipeline (v1) is now both slower (60–80 s, ~100k tokens per note) and *lower* than v2 on the same notes with the same model, so I did not restore it.
4. The extended-recall agent I added (history/findings/symptoms merged by code) **hurt** (82.0) — it adds details the clinician would not write. It stays off.

## 4. Same test on 50 different notes (current production design)

| | Parity (old comparator) | At 90+ | Strict gold-referenced audit | Completeness (notera vs gold) | p50 |
|---|---|---|---|---|---|
| v2 + gemini-2.5-flash (production today) | 83.1 | 19/50 (38 %) | 62.0 | 3.76 vs 4.94 | 5.9 s |
| **v2 + gemini-3.7-flash** | **85.4** | **25/50 (50 %)** | **67.7** | **4.04 vs 4.98** | 10.5 s |

So switching the writer model gives **+2.3 parity, +5.7 on the strict audit, and half of all notes at 90+**, at about 2× the latency. It does **not** reach a 90 *mean*; the old pipeline's stored 89–90 mean is within the noise of this (87.3 on the 24 fixtures vs 90.2 stored).

## 5. What I changed

* Parity score (the old comparator) added to the lab and the harness (`--parity`), plus `scripts/rescore-old.mjs` to re-score any old run.
* `gemini-3.7-flash` added to the model lists in **Settings → Writer model** and the lab. **Production is unchanged** (still gemini-2.5-flash).
* Reliability fix needed for the stronger model: on 3.7-flash 1 of 24 notes returned invalid JSON and failed. The writer now retries once (temperature 0, fallback model) before failing.
* Drug-name guard and empty-diagnosis rule from the previous round: parity 83.4 vs 83.1 (no change), kept.
* Lab compose now sets long LLM timeouts (the old multi-agent path needs them); production keeps its own caps.

## 6. Recommendation

Set **Settings → Writer model = gemini-3.7-flash** (one click, reversible, takes effect in ~30 s) to get the measured gain. Cost: roughly 2× latency and higher token price; an earlier commit noted 3.7 was slow under concurrent load on Vertex, so watch **System → p95 latency** for a day and roll back from the same screen if needed. Do not bring back the old multi-agent pipeline: the same model through the current v2 design beats it today at one-tenth the time and tokens.

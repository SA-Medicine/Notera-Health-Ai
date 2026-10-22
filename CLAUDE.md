# Notera Health AI — project rules

## HARD RULE: Style Spec v2 is LOCKED (v1 set by the owner 2026-10-20; v2 approved 2026-10-22)
The production note format (the doctor-approved spec in `docs/STYLE_SPEC_V2_LOCKED.md`) must **not** be changed, "improved" or tuned until the owner explicitly says so.
* Do not edit: `packages/backend/prompts/writer-v5.txt`, any prompt default in `generateNoteV2.js` (`PROMPT_REGISTRY`), `postGuards.js`, `renderMarkdown.js`, `refNames.js`, `specLock.js`, `planJoin.js`, `planSweep.js`, `qualityGuards.js`, `laterality.js`, `adviceLines.js`, `writerGuard.js`, `topicGroup.js`, `groundingAgent.js`, `conditionGuard.js`, or the shipped defaults of spec-shaping settings in `runtimeConfig.js`.
* Do not run or apply prompt upgrades, diagnosis loops, few-shot bank rebuilds or tuning against production behaviour. Gold-note scores (older gold notes use a different style) are information only — never a target.
* New work (Notera Studio, evaluator, review queue, proposals, tuning exports) is built **around** the pipeline and may only read from it or run in shadow mode. Doctor suggestions become *proposals*; they are never auto-applied.
* `node scripts/spec-lock.mjs` and `test/specLock.test.mjs` must pass. Unlocking requires the owner's explicit instruction and the phrase `UNLOCK STYLE SPEC v1`.

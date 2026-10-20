# Notera Studio

A **separate service and site** for judging notes the way a doctor does, collecting the training doctor's corrections, and proposing future style rules.
It is built *around* the production pipeline and never changes how notes are produced: the approved note format is the **locked Style Spec v1** ([STYLE_SPEC_V1_LOCKED.md](STYLE_SPEC_V1_LOCKED.md)).

| | |
|---|---|
| Doctor / owner site | https://studio.aitoolsfordoctor.com (Cloudflare Worker `notera-studio`, `apps/studio-site`) |
| Service | container `notera-studio` on the Google VM (`docker-compose.studio.yml`, code in `packages/backend/studio/`), reached only through the Worker and Caddy `/studio/*` with the secret `X-Studio-Key` |
| Data | Postgres schema `studio` (same database; the product schemas are **read-only** for Studio) |
| Sign-in | the person's normal Notera account. The Worker verifies the session with the product API, then adds the user id and role. Owner = product role `admin`; reviewer = a row in `studio.reviewers` |
| Training doctor | account "Seema Aggarwal" is seeded as reviewer (`STUDIO_REVIEWER_NAMES` in `.env.studio`) |

## What the doctor does
1. Signs in at the Studio URL with her Notera account. Every note she creates in Notera appears in **Notes to review** within a minute (polled from `clinical.drafts`; nothing is changed in the product).
2. Opens a note: the note beside its transcript. Each line is coloured by the **evidence map** (supported / partly / not found / unverified); a click shows the transcript sentence it came from.
3. **Your review:** rates 8 points 1–5 (PDQI-9 adapted), overall, "would you sign it", flags real errors with the CREOLA taxonomy (wrong: made up / flipped denial / invented cause / mixed topic; missing: current issue / history / plan; minor or major) and writes what Notera should do differently. The AI reviewer's scores appear only after she saves (blind first).
4. **Edit the note:** her version is compared with Notera's; a model states the preferences behind her edits as general, patient-free rules.
5. **Teach Notera:** an interview of 4–6 questions about this very note (with the exact line quoted); her answers become proposed rules.
6. The AI review & style check tab shows the AI reviewer's errors and the deterministic Style Spec v1 check.

## What the owner sees
All notes, **Proposals** (accept / park / reject — recorded for the next spec version, never applied while the spec is locked), **Dashboard** (style check since the spec, doctor ratings, "would sign" rate, edit rate, major errors per note, AI-vs-doctor agreement, rules most often broken), the **Style Spec**, **Corpus** cohorts, and **Tools**: reviewers, send a training case to the doctor, force a refresh, tuning export, and the regression gate.

## Components (`packages/backend/studio/`)
| File | Purpose |
|---|---|
| `conformance.js` | Deterministic Style Spec v1 checks (20 checks) on the rendered note; `spec/style-spec-v1.json` holds the rules |
| `evaluator.js` | Doctor-centred LLM reviewer: PDQI-9-adapted rubric + CREOLA error taxonomy; judged against the transcript only, never against another doctor's note |
| `evidence.js` | Evidence-linked review (shadow): each line to its transcript quote; a quote not found verbatim is downgraded to "unverified" |
| `teach.js` | Teach Notera questions and answers -> proposals |
| `editLearning.js` | Draft vs edited diff and inferred preference proposals (PRELUDE/CIPHER idea) |
| `ingest.js` | Queue ingestion, background AI review (one at a time), detection of edits made inside the product (draft -> final) |
| `corpus.js`, `tuning.js` | Style/date cohort index of the reference notes (analysis only) and tuning-file export (starts no job) |
| `gate.js` | Regression gate: frozen transcripts -> current pipeline -> Style Spec check |

Notes created before the approved format went live (2026-10-20) are marked **legacy**: they are kept in the queue but left out of the format statistics and are reviewed by AI only on request.

## Safety
* Studio only writes to schema `studio`; it reads `clinical.*` and `auth.users`.
* Proposals, ratings and edits never alter production prompts, settings or notes. The lock refuses prompt/setting changes (HTTP 423) and `test/specLock.test.mjs` fingerprints the spec code.
* Transcripts are shown only to the signed-in reviewer assigned to the note and to the owner; every note view, review save and proposal decision is written to `studio.audit`.
* The corpus index does not feed the production pipeline: older reference notes use other styles and are information only.

## Operations
* Deploy the service: `docker compose -f docker-compose.studio.yml up -d --build` (needs `.env.production` and `.env.studio` with `STUDIO_KEY`, `STUDIO_REVIEWER_NAMES`; never committed).
* Deploy the site: `apps/studio-site` -> `npx wrangler deploy`; the same key is stored as the Worker secret `STUDIO_KEY`.
* Caddy: `handle_path /studio/*` -> `notera-studio:8080` (a Caddy container restart is needed after the Caddyfile changes because it is a single-file bind mount).
* Regression gate: Studio -> Tools -> Run the gate, before any release.
* Tuning experiment: Tools -> Tuning export writes Vertex AI supervised-tuning files; starting a tuning job and adopting a tuned model require unlocking the Style Spec first.

## The Style Interview (all invited accounts)
A long, detailed, three-part interview about exactly how each doctor wants notes written. It is the "what do you want, in your own words" counterpart of the per-note review.

| Part | Title | Questions | What it covers |
|---|---|---|---|
| 1 | You and your notes | 27 | practice and visit types, who reads the notes, what is edited today, length and abbreviation comfort, trust and safety |
| 2 | Section by section | 49 + follow-ups | Subjective, Past Medical History, Objective, Assessment & Plan, language and layout; side-by-side examples to choose between |
| 3 | **The defining part** | 42 + follow-ups | priorities (ranked), trade-offs, deal-breakers, hard "Always/Never" rules, the perfect note, special situations, and a **rule-by-rule review of the approved Style Spec v1** (keep / change / drop) |

* **Who gets it:** every active account created before 2026-10-20 23:59 UTC that did not sign up by itself (the administrator and the clinician accounts created by the owner). Self sign-ups and later accounts are **not** invited automatically; the owner can invite any account by email (Studio -> Interviews). Invited accounts see **only** the interview in Studio; reviewers also see their notes; the owner sees everything.
* **How it works:** parts open in order; answers autosave as they are typed; required questions must be answered to submit; a submitted part can be reopened. After Part 1 and Part 2 the model reads that person's answers and adds 6-8 **personalised follow-up questions** to the next part.
* **What is stored** (schema `studio`): `interviewees`, `interviews` (answers per part), `style_profiles`, `interview_synthesis`. After Part 3 a **Style Profile** is synthesised (priorities, rules per section, hard rules, terminology, trade-offs, review of the approved format, contradictions, open questions) and the doctor **confirms it statement by statement** (right / not quite / wrong + correction). Changes asked for in the rule review and corrections become **proposals**; nothing is applied.
* **Owner views:** everyone's progress, every answer, a Markdown/JSON export per person, and **Compare doctors** (answer distributions for every choice question plus a written view of agreements, conflicts and rules most would accept) — the basis for restructuring the system later.
* **Safe by design:** answering never changes how notes are produced; the Style Spec v1 stays locked.

### Where the interview shows up for the doctors
* **Main Notera app (the white workspace):** invited accounts see a **"Style interview" item in the sidebar** (with a blue dot until finished) and a **dismissible banner** at the top of the workspace ("Start / Continue the interview", or "review and confirm your profile"). The banner is also shown on the History page. Accounts that are not invited see nothing. The product backend answers `GET /api/studio/invite` (read-only; signed-in account only).
* The link opens **Studio** (`https://studio.aitoolsfordoctor.com/#/interview`), where the doctor signs in with the same email and password. (A one-click hand-off without a second sign-in would need a change to the product's session code and was deliberately not added.)
* Studio itself shows invited accounts only the interview.

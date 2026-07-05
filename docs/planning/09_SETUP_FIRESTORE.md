# 09 — Setup: Firestore (Firebase) data layer

Firestore is our system of record: transcripts, extracted entities, draft notes, final approved notes, clinician edits, and the audit log. It's managed, scales automatically, and is BAA-eligible on Google Cloud.

---

## 1. Create the database

```bash
# Firestore is part of GCP/Firebase — enable and create in Native mode
gcloud services enable firestore.googleapis.com
gcloud firestore databases create --location=us-central1
```

Or via the Firebase console: create a project (link it to the same GCP project), add Firestore in **Native mode**, pick your region.

Backend access (from Cloud Run) uses the service account automatically:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:BACKEND_SA_EMAIL" \
  --role="roles/datastore.user"
```

---

## 2. Data model (collections)

Keep it aligned to the data contracts in `01 §4`. Suggested layout:

```
consults/{consultId}
  ├─ specialty, noteType, clinicianId, status, createdAt
  ├─ audioUri            (gs://... , optional)
  ├─ transcript          { turns:[{speaker,text,ts}] }
  ├─ entities            [ {text,label,start,end,source} ]   ← from NER
  ├─ deidMap             (encrypted / restricted) name↔token map for re-identify
  │
  ├─ subcollection: drafts/{draftId}
  │     modelVersion, schemaVersion, note(JSON), confidence, createdAt
  │
  ├─ subcollection: finals/{finalId}
  │     note(JSON), approvedBy, approvedAt
  │
  └─ subcollection: feedback/{feedbackId}
        draftId, finalId, edits(diff), clinicianId, createdAt

auditLog/{eventId}
  consultId, actor, action, target, timestamp   (append-only)

models/{modelVersion}
  type, dataVersion, schemaVersion, evalScore, promotedAt   ← model registry (03)
```

**Why this shape:** one consult is the root; drafts/finals/feedback hang off it so the full history of a note is together. `feedback` (draft→final edits) is the training-flywheel signal (`02 §8`, `03 §5`).

---

## 3. The `finals` are your growing gold set

Every approved note in `consults/*/finals` + its transcript is a new `(transcript → gold note)` pair. Periodically export these (de-identified) to grow the training/eval dataset (`03 §7`). Design for this from day one: keep `transcript`, `entities`, and `finals.note` all retrievable per consult.

---

## 4. Security rules & access

- **Never expose Firestore directly to the browser for PHI.** The Next.js app talks to the **Cloud Run backend**, which talks to Firestore. Lock client SDK write/read of PHI collections off.
- If you do use the Firebase client SDK for anything, write strict **Security Rules** (auth required, per-role, per-clinician).
- Enforce **least privilege**: clinicians see their consults; admins see aggregates; the model pipeline uses a service account.

Example (deny-all client access to PHI, force it through backend):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /consults/{doc=**} { allow read, write: if false; } // backend-only
    match /auditLog/{doc}    { allow read, write: if false; }
  }
}
```

---

## 5. Audit log (compliance requirement)

Write an append-only `auditLog` entry for every PHI access and every note state change (created, viewed, edited, approved). This is required for HIPAA (`04 §1`) and invaluable for debugging. Never update/delete audit entries.

---

## 6. Compliance notes

- Firestore + GCS are **BAA-eligible** — confirm they're in your Google Cloud BAA before real PHI.
- Encryption at rest is on by default; keep it in an approved region for data residency.
- The `deidMap` (identifiers ↔ tokens for re-identification after the AI Studio Gemini call) is the most sensitive field — restrict it hardest, or store it in a separate, tighter-controlled collection/Secret Manager. This is what lets you keep PHI out of the AI Studio endpoint (`04`).
- Support **deletion** (right-to-erasure): be able to delete a patient's consult(s) and derived data.

---

## 7. Checklist

- [ ] Firestore created (Native mode), region set, BAA-covered.
- [ ] Backend SA has `datastore.user`; browser has no direct PHI access.
- [ ] Collections match the data contracts (`01 §4`).
- [ ] Security Rules deny client PHI access.
- [ ] Append-only audit log wired on every PHI action.
- [ ] `deidMap` locked down; re-identify step works.
- [ ] Export path for `finals` → training dataset defined.

> Next: `10_NEXTJS_FRONTEND.md` — the scalable UI on top of all this.

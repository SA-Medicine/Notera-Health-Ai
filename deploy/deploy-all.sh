#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Notera-Health-Ai — one-shot deploy to Cloud Run (doc 07, 10)
# All-GCP: web (public) → backend (private) → NER (private) + Firestore + ASR.
# Run from the repo root:  PROJECT_ID=xxx REGION=us-central1 deploy/deploy-all.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
REPO="scribe"
IMG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

echo "▶ Project ${PROJECT_ID} / ${REGION}"
gcloud config set project "${PROJECT_ID}"
gcloud config set run/region "${REGION}"

# ── 1. Enable APIs (doc 07 §1) ───────────────────────────────────────────────
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com speech.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com

# ── 2. Artifact Registry + Firestore ─────────────────────────────────────────
gcloud artifacts repositories describe "${REPO}" --location="${REGION}" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "${REPO}" --repository-format=docker --location="${REGION}"
gcloud firestore databases describe >/dev/null 2>&1 || \
  gcloud firestore databases create --location="${REGION}"

# ── 3. Secrets (doc 07 §2) — set GEMINI key once ─────────────────────────────
if ! gcloud secrets describe gemini-api-key >/dev/null 2>&1; then
  echo -n "${GEMINI_API_KEY:?set GEMINI_API_KEY for first deploy}" | gcloud secrets create gemini-api-key --data-file=-
fi

# ── 4. NER sidecar (private, 2Gi) ────────────────────────────────────────────
echo "▶ Building NER sidecar…"
gcloud builds submit ner --tag "${IMG}/ner"
gcloud run deploy scribe-ner --image "${IMG}/ner" \
  --no-allow-unauthenticated --min-instances=0 --max-instances=5 --memory=2Gi --cpu=2 --concurrency=10
NER_URL="$(gcloud run services describe scribe-ner --format='value(status.url)')"

# ── 5. Backend (private) — built from REPO ROOT so schema/ is in context ──────
echo "▶ Building backend…"
gcloud builds submit --config deploy/cloudbuild.backend.yaml .
gcloud run deploy scribe-backend --image "${IMG}/backend" \
  --no-allow-unauthenticated --min-instances=0 --max-instances=10 --memory=1Gi --cpu=1 --concurrency=40 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars "NODE_ENV=production,LLM_BACKEND=ai_studio,FIRESTORE_DRIVER=firestore,NER_URL=${NER_URL},NER_USE_IAM=true,REQUIRE_AUTH=true"
BACKEND_URL="$(gcloud run services describe scribe-backend --format='value(status.url)')"

# ── 6. IAM: backend SA may invoke NER + Speech + Firestore ───────────────────
BACKEND_SA="$(gcloud run services describe scribe-backend --format='value(spec.template.spec.serviceAccountName)')"
gcloud run services add-iam-policy-binding scribe-ner --member="serviceAccount:${BACKEND_SA}" --role="roles/run.invoker"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${BACKEND_SA}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${BACKEND_SA}" --role="roles/speech.client"

# ── 7. Web (public; auth happens in-app) ─────────────────────────────────────
echo "▶ Building web…"
gcloud builds submit web --tag "${IMG}/web"
gcloud run deploy scribe-web --image "${IMG}/web" \
  --allow-unauthenticated --min-instances=0 --max-instances=10 \
  --set-env-vars "NODE_ENV=production,BACKEND_URL=${BACKEND_URL},USE_ID_TOKEN=true"

# Let the web SA invoke the private backend.
WEB_SA="$(gcloud run services describe scribe-web --format='value(spec.template.spec.serviceAccountName)')"
gcloud run services add-iam-policy-binding scribe-backend --member="serviceAccount:${WEB_SA}" --role="roles/run.invoker"

# ── 8. Firestore security rules (doc 09 §4) ──────────────────────────────────
echo "▶ Apply deploy/firestore.rules via Firebase console or 'firebase deploy --only firestore:rules'."

echo "✅ Deployed. Web: $(gcloud run services describe scribe-web --format='value(status.url)')"

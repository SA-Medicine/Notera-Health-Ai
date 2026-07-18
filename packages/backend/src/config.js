// Notera-Health-Ai — backend config (env-driven; secrets via Secret Manager)
'use strict';

export const config = {
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Comma-separated bearer tokens the Next.js server presents (dev). In prod the
  // backend is private (Cloud Run IAM) and callers use Google ID tokens instead.
  serviceTokens: (process.env.SERVICE_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean),
  requireAuth: String(process.env.REQUIRE_AUTH || (process.env.NODE_ENV === 'production')) === 'true',
  llmBackend: process.env.LLM_BACKEND || 'ai_studio',
  nerUrl: process.env.NER_URL || 'http://localhost:8000',
  firestoreDriver: process.env.FIRESTORE_DRIVER || 'memory',
  pipelineVersion: process.env.PIPELINE_VERSION || 'notera-pipeline-v31',
};

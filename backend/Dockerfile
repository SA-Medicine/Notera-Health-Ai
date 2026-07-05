# Notera-Health-Ai — Backend/API image (Cloud Run)
# ⚠️ Build from the REPO ROOT so the shared schema/ folder is in context:
#   gcloud builds submit --config deploy/cloudbuild.backend.yaml .
# (backend imports ../../../schema — schema must sit beside backend in the image)
FROM node:20-slim
WORKDIR /app

# Install backend deps first (better layer caching)
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# Copy shared schema + backend source
COPY schema ./schema
COPY backend ./backend

WORKDIR /app/backend
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]

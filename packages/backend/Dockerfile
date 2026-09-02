# Notera backend — production image (Express, ESM, Node 20).
# Build from the REPO ROOT:  docker build -f packages/backend/Dockerfile -t notera-backend .
FROM node:20-slim AS build
WORKDIR /app
# bcrypt needs build tools to compile its native binding
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json turbo.json ./
COPY packages ./packages
COPY schema ./schema
COPY db ./db
RUN npm ci --omit=dev --workspace @notera/backend || npm install --omit=dev --workspace @notera/backend

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg: standardize browser WebM/Opus/Ogg/MP4/WAV to 16 kHz mono PCM WAV for local ASR.
# Python venv: isolates faster-whisper from the Node app dependency tree.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/notera-asr-venv \
  && /opt/notera-asr-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/notera-asr-venv/bin/pip install --no-cache-dir "faster-whisper>=1.2.0,<2"
ENV ASR_PYTHON=/opt/notera-asr-venv/bin/python
# non-root runtime user
RUN useradd -m -u 10001 notera
COPY --from=build --chown=notera:notera /app /app
RUN mkdir -p /app/.cache/huggingface && chown -R notera:notera /app/.cache
USER notera
WORKDIR /app/packages/backend
EXPOSE 8080
CMD ["node", "server.js"]

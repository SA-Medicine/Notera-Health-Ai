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
# ffmpeg: decode browser WebM/Opus/Ogg/MP4/WAV to 16 kHz mono PCM before handing the audio
# to Google Speech-to-Text. This is what gives a recording an EXACT duration (MediaRecorder
# containers carry none) and what lets long audio be split into windows that fit the API's
# synchronous limit.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# non-root runtime user
RUN useradd -m -u 10001 notera
COPY --from=build --chown=notera:notera /app /app
USER notera
WORKDIR /app/packages/backend
EXPOSE 8080
CMD ["node", "server.js"]

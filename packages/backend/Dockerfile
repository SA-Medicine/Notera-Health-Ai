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
# non-root runtime user
RUN useradd -m -u 10001 notera
COPY --from=build --chown=notera:notera /app /app
USER notera
WORKDIR /app/packages/backend
EXPOSE 8080
CMD ["node", "server.js"]

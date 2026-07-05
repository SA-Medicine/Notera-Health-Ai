# Notera-Health-Ai — Web (Next.js standalone) image (Cloud Run, public; doc 10 §7)
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build   # next.config: output: "standalone"

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]

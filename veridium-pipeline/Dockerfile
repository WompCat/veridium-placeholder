# Veridium: Node/Express + sqlite. The sqlite file lives on a persistent volume at DB_PATH.

# Install production dependencies with a compiler toolchain available, in case better-sqlite3
# has no prebuilt binary for this platform and has to build from source.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DB_PATH=/var/data/veridium.db
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4000
# Opening the store applies any new migrations; the seed is idempotent (creates Obscurity
# Esports only if it's missing). Then the server takes over the process.
CMD ["sh", "-c", "node_modules/.bin/tsx src/seed.ts && exec node_modules/.bin/tsx src/server.ts"]

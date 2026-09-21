# askBack — WhatsApp bot + admin panel (single Node process)
# Node 20+ is required (see package.json engines).
FROM node:22-bookworm-slim

# better-sqlite3 compiles a native addon; python3 + build tools are needed at
# install time. ffmpeg-static ships its own binary, so no system ffmpeg needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Runtime data lives in these folders — mounted as volumes in compose so they
# survive redeploys (WhatsApp login, uploaded files). The SQLite file (data.db)
# sits in /app and is persisted via the app-data volume below.
RUN mkdir -p /app/auth_info /app/uploads

EXPOSE 3000

# Health checks are managed by Coolify from outside the container.
# The app exposes GET /health → { ok: true }.
HEALTHCHECK NONE

CMD ["node", "server.js"]

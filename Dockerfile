# askBack — WhatsApp bot + admin panel (single Node process)
# Node 20+ is required (see package.json engines).
FROM node:20-bookworm-slim

# better-sqlite3 compiles a native addon; python3 + build tools are needed at
# install time. ffmpeg-static ships its own binary, so no system ffmpeg needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
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

# Simple healthcheck against the app's own endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

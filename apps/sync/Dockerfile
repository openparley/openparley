# OpenParley Sync (self-hosted team server). Build from the repository root:
#   docker build -f apps/sync/Dockerfile -t openparley-sync .
#   docker run -d -p 127.0.0.1:3001:3001 -v openparley:/data -e PUBLIC_URL=https://parley.example.com -e TRUST_PROXY=1 openparley-sync
# (behind a reverse proxy on the same host; drop TRUST_PROXY if the port is reachable directly)
FROM oven/bun:1.4-slim

WORKDIR /app
# Only the open core: this image must never contain ee/.
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
# Checkouts can carry owner-only modes; the app runs as an unprivileged user.
RUN chmod -R a+rX /app && bun install --frozen-lockfile && bun run --filter @openparley/overlay build

RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production PORT=3001 DATABASE_PATH=/data/openparley.db
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/health`); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "apps/sync/src/main.ts"]

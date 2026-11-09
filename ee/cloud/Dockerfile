# OpenParley Cloud. Build from the repository root:
#   docker build -f ee/cloud/Dockerfile -t openparley-cloud .
FROM oven/bun:1.4-slim

WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY ee ee
# Checkouts can carry owner-only modes; the app runs as an unprivileged user.
RUN chmod -R a+rX /app && bun install --frozen-lockfile && bun run --filter @openparley/overlay build

RUN mkdir -p /data && chown bun:bun /data
USER bun
# Always runs behind a reverse proxy (Traefik on Coolify), which sets X-Forwarded-For.
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 4000

# The Cloud routes by hostname: /health exists only on the control plane host.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/health`, { headers: { host: `cloud.${process.env.CLOUD_DOMAIN || 'localhost'}` } }); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "ee/cloud/src/main.ts"]

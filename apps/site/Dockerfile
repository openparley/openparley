# Landing page and docs (static). Build from the repository root:
#   docker build -f apps/site/Dockerfile -t openparley-site .
FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
# Checkouts can carry owner-only modes; the app runs as an unprivileged user.
RUN chmod -R a+rX /app && bun install --frozen-lockfile && bun run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/site/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

# The suite's one image: the web app, and (with another command) the nightly backup.
# Built on the owner's server by deploy/install.sh and deploy/update.sh.

FROM node:22-alpine AS deps
RUN npm install -g pnpm@12.5.1 && apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Keeps the build inside a 2-4 GB server.
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm build

FROM node:22-alpine AS runtime
# pg_dump/pg_restore 16 for backups and update rollbacks; tini reaps child processes.
RUN apk add --no-cache postgresql16-client tini tar gzip
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 SUITE_FILES_DIR=/data/files
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/modules ./modules
COPY --from=build --chown=node:node /app/scripts/migrate.mjs /app/scripts/backup.mjs /app/scripts/reset-link.mjs ./scripts/
COPY --from=build --chown=node:node /app/lib/s3-sigv4.mjs ./lib/s3-sigv4.mjs
# The server bundles its Postgres driver; the scripts above import it directly
# (it has no dependencies of its own).
COPY --from=deps --chown=node:node /app/node_modules/postgres/ ./node_modules/postgres/
RUN mkdir -p /data/files /backups && chown node:node /data/files /backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Migrations first (core, then each installed module), then the server.
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]

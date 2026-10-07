# The business brain: GBrain (https://github.com/garrytan/gbrain, MIT), pinned.
# An optional service: docker compose starts it only with the "brain" profile
# (docs/apps/assistant.md, "Switch the brain on"). Keyword-only: no embedding,
# expansion or chat key is ever given to it, so no business text leaves the server.
#
# Same pins as the AHL brain host (services/brain-host/deploy/install.sh in the
# AHL repo): Bun 1.4.2 and GBrain v0.60.96.0 at commit 9dbc00c.

FROM oven/bun:1.4.2-slim
ARG GBRAIN_REPO=https://github.com/garrytan/gbrain.git
ARG GBRAIN_TAG=v0.60.96.0
ARG GBRAIN_COMMIT=9dbc00c7c025420a7c2846ac55b56b937f09bceb
RUN apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates tini curl \
  && rm -rf /var/lib/apt/lists/*
# The repo's own lockfile pins every dependency; lifecycle scripts stay off
# (GBrain's postinstall only runs migrations, which `gbrain init` does).
RUN git clone --quiet --filter=blob:none "$GBRAIN_REPO" /opt/gbrain \
  && git -C /opt/gbrain -c advice.detachedHead=false checkout --quiet "$GBRAIN_COMMIT" \
  && test "$(git -C /opt/gbrain rev-parse HEAD)" = "$GBRAIN_COMMIT" \
  && cd /opt/gbrain && bun install --frozen-lockfile --production --ignore-scripts --silent \
  && rm -rf /opt/gbrain/.git \
  && printf '#!/bin/sh\nexec bun /opt/gbrain/src/cli.ts "$@"\n' > /usr/local/bin/gbrain && chmod 0755 /usr/local/bin/gbrain \
  && gbrain --version | grep -q "${GBRAIN_TAG#v}"
COPY entrypoint.sh /usr/local/bin/brain-entrypoint
RUN chmod 0755 /usr/local/bin/brain-entrypoint && mkdir -p /data && chown bun:bun /data
USER bun
ENV GBRAIN_HOME=/data HOME=/data GBRAIN_SELF_UPGRADE_MODE=off BRAIN_PORT=7410
VOLUME ["/data"]
EXPOSE 7410
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD curl -fsS "http://127.0.0.1:${BRAIN_PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/brain-entrypoint"]

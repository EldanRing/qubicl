FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

ARG QUBICL_VERSION=development
ARG QUBICL_REVISION=unknown
ARG QUBICL_CREATED=unknown
ARG QUBICL_SOURCE=https://github.com/EldanRing/qubicl
ARG QUBICL_ASSET_MANIFEST_SHA256=unknown

LABEL org.opencontainers.image.title="Qubicl dashboard" \
      org.opencontainers.image.description="Read-only static interface for the Qubicl host management service" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="$QUBICL_SOURCE" \
      org.opencontainers.image.url="$QUBICL_SOURCE" \
      org.opencontainers.image.version="$QUBICL_VERSION" \
      org.opencontainers.image.revision="$QUBICL_REVISION" \
      org.opencontainers.image.created="$QUBICL_CREATED" \
      dev.qubicl.dashboard-protocol-version="1" \
      dev.qubicl.asset-manifest-sha256="$QUBICL_ASSET_MANIFEST_SHA256"

WORKDIR /app
RUN apk upgrade --no-cache libcrypto3 libssl3 \
 && rm -rf \
    /opt/yarn-v1.22.22 \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm \
 && rm -f \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/pnpm \
    /usr/local/bin/pnpx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

COPY --chown=node:node server.mjs asset-manifest.json /app/
COPY --chown=node:node public/ /app/public/
COPY LICENSE /usr/share/doc/qubicl/LICENSE

USER node
EXPOSE 3213
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3213/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/server.mjs"]

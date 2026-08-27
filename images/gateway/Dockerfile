FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

ARG QUBICL_VERSION=development
ARG QUBICL_REVISION=unknown
ARG QUBICL_CREATED=unknown
ARG QUBICL_SOURCE=https://github.com/EldanRing/qubicl

LABEL org.opencontainers.image.title="Qubicl gateway" \
      org.opencontainers.image.description="Authenticated local gateway for Qubicl computers" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="$QUBICL_SOURCE" \
      org.opencontainers.image.url="$QUBICL_SOURCE" \
      org.opencontainers.image.version="$QUBICL_VERSION" \
      org.opencontainers.image.revision="$QUBICL_REVISION" \
      org.opencontainers.image.created="$QUBICL_CREATED" \
      dev.qubicl.gateway-protocol-version="2" \
      dev.qubicl.viewer-authentication="header-v1"

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
COPY --chown=node:node gateway.mjs /app/gateway.mjs
COPY LICENSE THIRD_PARTY_NOTICES.txt /usr/share/doc/qubicl/

USER node
EXPOSE 3211
ENTRYPOINT ["node", "/app/gateway.mjs"]

# syntax=docker/dockerfile:1.7

FROM node:24.21.0-trixie-slim@sha256:b64fccfbcd1ae10d11b969a868b50e1c2530a7054813d5cdea04ac3bce551697 AS tools

ARG TARGETPLATFORM
ENV COREPACK_HOME=/opt/corepack
WORKDIR /src

RUN test "$TARGETPLATFORM" = "linux/amd64" \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.7.0 --activate

FROM tools AS frontend-deps
COPY frontend/ /src/frontend/
WORKDIR /src/frontend
RUN pnpm install --frozen-lockfile

FROM tools AS python-build
COPY --from=frontend-deps /src/frontend/node_modules /src/frontend/node_modules
COPY frontend/package.json /src/frontend/package.json
COPY frontend/scripts/build-investment-python-sidecar.ts frontend/scripts/investment-backend-package-policy.ts frontend/scripts/investment-container-test-payloads.ts /src/frontend/scripts/
COPY frontend/config/investment-python-runtime-lock.json /src/frontend/config/
COPY frontend/config/investment-python-requirements/ /src/frontend/config/investment-python-requirements/
COPY backend/dsh-trading-core/ /src/backend/dsh-trading-core/
COPY backend/market-watch/ /src/backend/market-watch/
COPY backend/industry-chain/ /src/backend/industry-chain/
COPY containers/investment-sidecar-cache.mjs /src/containers/
WORKDIR /src/frontend
ARG SIDECAR_CACHE_KEY=
# Cache contents are optional and never become an image layer. Invalid entries rebuild normally.
RUN --mount=type=bind,source=.investment-sidecar-cache,target=/cache \
    node /src/containers/investment-sidecar-cache.mjs restore /cache "$SIDECAR_CACHE_KEY" /opt/investment-python \
    || CI=true pnpm run investment:sidecar:build --target linux-x64 --output /opt/investment-python --cache /opt/python-download-cache

FROM frontend-deps AS frontend-build
RUN pnpm run build:lib && pnpm run build:web
RUN node --import tsx/esm scripts/build-investment-container-app.ts --output /opt/dsh

FROM tools AS runtime-files
COPY containers/prepare-runtime-openssl.mjs containers/runtime-openssl-lock.json /src/containers/
RUN install -d -m 0700 -o 10001 -g 10001 /opt/runtime-root/var/lib/dsh
RUN node containers/prepare-runtime-openssl.mjs /opt/runtime-openssl

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d AS runtime

ARG VCS_REF=unknown
ENV DSH_HOME=/var/lib/dsh \
    HOME=/var/lib/dsh \
    NODE_ENV=production \
    PORT=3080 \
    TIMEZONE=Asia/Shanghai \
    TZ=Asia/Shanghai
LABEL org.opencontainers.image.source="https://github.com/PABIPRG/pa-investment-research" \
      org.opencontainers.image.revision="$VCS_REF"

COPY --from=runtime-files --chown=0:0 /opt/runtime-openssl/ /
COPY --from=frontend-build --chown=0:0 /opt/dsh /opt/dsh
COPY --from=python-build --chown=0:0 /opt/investment-python /opt/investment-python
COPY --from=runtime-files --chown=10001:10001 /opt/runtime-root/var/lib/dsh /var/lib/dsh
COPY --chown=0:0 containers/ /opt/container/

EXPOSE 3080
USER 10001:10001
ENTRYPOINT ["/nodejs/bin/node", "/opt/container/investment-entrypoint.mjs"]

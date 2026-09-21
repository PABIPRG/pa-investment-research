# syntax=docker/dockerfile:1.7

FROM node:24.21.0-trixie-slim@sha256:b64fccfbcd1ae10d11b969a868b50e1c2530a7054813d5cdea04ac3bce551697 AS build

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

COPY . .
WORKDIR /src/frontend
RUN pnpm install --frozen-lockfile
RUN pnpm run build:lib && pnpm run build:web
# Run the final pnpm command non-interactively before production deploy changes the shared modules state.
RUN CI=true pnpm run investment:sidecar:build --target linux-x64 --output /opt/investment-python --cache /opt/python-download-cache
RUN node --import tsx/esm scripts/build-investment-container-app.ts --output /opt/dsh

FROM scratch AS npm-release
# Node 24.21.0 bundles npm 11.19.0 with vulnerable brace-expansion, ip-address and tar.
ADD --checksum=sha256:9f58bff01604cb1b14008fef14dceb14d836a49225e45c6c2e37de3be3e707f0 https://registry.npmjs.org/npm/-/npm-11.19.1.tgz /npm.tgz

FROM node:24.21.0-trixie-slim@sha256:b64fccfbcd1ae10d11b969a868b50e1c2530a7054813d5cdea04ac3bce551697 AS runtime

ARG VCS_REF=unknown
ENV DSH_HOME=/var/lib/dsh \
    NODE_ENV=production \
    PORT=3080 \
    TIMEZONE=Asia/Shanghai \
    TZ=Asia/Shanghai
LABEL org.opencontainers.image.source="https://github.com/PABIPRG/pa-investment-research" \
      org.opencontainers.image.revision="$VCS_REF"

RUN --mount=type=bind,from=npm-release,source=/npm.tgz,target=/tmp/npm.tgz \
    npm install --global --offline --ignore-scripts --no-audit --no-fund --cache /tmp/npm-update-cache /tmp/npm.tgz \
    && test "$(npm --version)" = "11.19.1" \
    && rm -rf /tmp/npm-update-cache

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 dsh \
    && useradd --uid 10001 --gid dsh --home-dir /var/lib/dsh --no-create-home --shell /usr/sbin/nologin dsh \
    && mkdir -p /opt/container \
    && install -d -m 0700 -o dsh -g dsh /var/lib/dsh

COPY --from=build --chown=root:root /opt/dsh /opt/dsh
COPY --from=build --chown=root:root /opt/investment-python /opt/investment-python
COPY --chown=root:root containers/ /opt/container/
RUN chmod 0555 /opt/container/*.mjs

EXPOSE 3080
USER dsh
ENTRYPOINT ["/opt/container/investment-entrypoint.mjs"]

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
RUN install -d -m 0700 -o 10001 -g 10001 /opt/runtime-root/var/lib/dsh

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

COPY --from=build --chown=0:0 /opt/dsh /opt/dsh
COPY --from=build --chown=0:0 /opt/investment-python /opt/investment-python
COPY --from=build --chown=10001:10001 /opt/runtime-root/var/lib/dsh /var/lib/dsh
COPY --chown=0:0 containers/ /opt/container/

EXPOSE 3080
USER 10001:10001
ENTRYPOINT ["/nodejs/bin/node", "/opt/container/investment-entrypoint.mjs"]

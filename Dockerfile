# syntax=docker/dockerfile:1.7

FROM node:24.8.0-bookworm-slim@sha256:81a8fcfa2aa85bc07d22d9ddff227d0a52cfc3b08e571a21b16efc9153842106 AS build

ARG TARGETPLATFORM
ENV COREPACK_HOME=/opt/corepack
WORKDIR /src

RUN test "$TARGETPLATFORM" = "linux/amd64" \
    && apt-get update \
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

FROM node:24.8.0-bookworm-slim@sha256:81a8fcfa2aa85bc07d22d9ddff227d0a52cfc3b08e571a21b16efc9153842106 AS runtime

ARG VCS_REF=unknown
ENV DSH_HOME=/var/lib/dsh \
    NODE_ENV=production \
    PORT=3080 \
    TIMEZONE=Asia/Shanghai \
    TZ=Asia/Shanghai
LABEL org.opencontainers.image.source="https://github.com/PABIPRG/pa-investment-research" \
      org.opencontainers.image.revision="$VCS_REF"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 dsh \
    && useradd --uid 10001 --gid dsh --home-dir /var/lib/dsh --no-create-home --shell /usr/sbin/nologin dsh \
    && mkdir -p /opt/container \
    && install -d -m 0700 -o dsh -g dsh /var/lib/dsh

COPY --from=build --chown=root:root /opt/dsh /opt/dsh
COPY --from=build --chown=root:root /opt/investment-python /opt/investment-python
COPY --chown=root:root containers/ /opt/container/
RUN chmod 0555 /opt/container/*.mjs \
    && ln -s /opt/container/investment-entrypoint.mjs /usr/local/bin/dsh-investment-entrypoint

EXPOSE 3080
USER dsh
ENTRYPOINT ["/usr/local/bin/dsh-investment-entrypoint"]

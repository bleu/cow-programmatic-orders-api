FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@10

WORKDIR /usr/src/app

# ---- build stage ----
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

COPY . .

# ---- production image ----
FROM base

RUN apk add --no-cache curl

ENV NODE_ENV=production

COPY --from=build /usr/src/app ./
RUN pnpm install --frozen-lockfile \
    # Run as the non-root `node` user (uid 1000, shipped by node:22-alpine).
    # Ponder writes its cache under the workdir and pnpm reads /pnpm at runtime,
    # so both must be owned by `node`.
    && chown -R node:node /usr/src/app /pnpm

USER node

# /readyz, not Ponder's /ready: /ready returns 200 forever once historical sync
# finishes, so a stalled realtime subscription still reports healthy. /readyz also
# checks that each chain's newest synced block is keeping up with wall-clock.
# Note: Docker never restarts a container for failing its healthcheck — the
# `autoheal` label on the ponder service is what turns unhealthy into a restart.
HEALTHCHECK \
    --start-period=24h \
    --start-interval=1s \
    --interval=30s \
    --timeout=10s \
    --retries=3 \
    CMD curl -f http://localhost:3000/readyz || exit 1

EXPOSE 3000/tcp

CMD ["pnpm", "start"]

ARG PIPELINE_BUILD_TAG="unknown"
ENV APP_REVISION=$PIPELINE_BUILD_TAG

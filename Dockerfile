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

HEALTHCHECK \
    --start-period=24h \
    --start-interval=1s \
    --retries=3 \
    CMD curl -f http://localhost:3000/ready || exit 1

EXPOSE 3000/tcp

CMD ["pnpm", "start"]

ARG PIPELINE_BUILD_TAG="unknown"
ENV APP_REVISION=$PIPELINE_BUILD_TAG

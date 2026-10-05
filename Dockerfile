# syntax=docker/dockerfile:1

# Node 24.15 is the floor in package.json "engines"; 24 is the matching LTS line.
ARG NODE_VERSION=24
# Kept in step with "packageManager" in package.json.
ARG PNPM_VERSION=11.11.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV CI=true
WORKDIR /app
# corepack rather than `npm i -g pnpm`: it is already in the image, and it reads
# the version pinned in package.json "packageManager" anyway.
RUN corepack enable && corepack install --global "pnpm@${PNPM_VERSION}"

# ---------------------------------------------------------------------------
# Build the viewer. Split from the dependency install so editing web/ does not
# invalidate the (slow) pnpm install layer.
# ---------------------------------------------------------------------------
FROM base AS build
# `pnpm fetch` fills the store from the lockfile without linking anything, which
# is the step BuildKit can cache across builds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir=/pnpm/store

COPY tsconfig.json vite.config.ts index.html ./
COPY web ./web
COPY public ./public
# pnpm-workspace.yaml's allowBuilds entry is what lets stashcat-api run its
# `prepare` script; without the compiled dist/ the server cannot import it.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    && pnpm build

# ---------------------------------------------------------------------------
# Runtime: production dependencies plus the source that serves them.
# ---------------------------------------------------------------------------
FROM base AS runtime
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# NODE_ENV is set *after* the install on purpose. pnpm compiles the git-hosted
# stashcat-api by running npm inside a temporary copy of it, and that nested
# npm install honours NODE_ENV=production by skipping dev dependencies -- which
# leaves `tsc` missing and fails the build with "tsc: not found".
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    && pnpm prune --prod \
    && pnpm store prune --store-dir=/pnpm/store
ENV NODE_ENV=production \
    SCHULCLOUD_ARCHIVE_DIR=/data \
    PORT=4317 \
    HOST=0.0.0.0

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node src ./src

# Created in the image so a fresh named volume inherits its ownership; a bind
# mount needs the same uid on the host side (see README).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4317

# /api/summary is a cheap read that also proves the SQLite file opened, so this
# catches a volume that is not writable as well as a dead server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/summary').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/cli.mjs", "serve"]
# This dockerfile builds an image for the backend package.
# It should be executed with the root of the repo as docker context.
#
# Before building this image, be sure to have run the following commands in the repo root:
#
# yarn install --immutable
# yarn tsc
# yarn build:backend
#
# Host build steps (yarn install, yarn build:backend) must use the same
# Node version as the FROM image below. Mismatched versions break native modules.
#
# Once the commands have been run, you can build the image using `yarn build-image`
#
# Two stages: native modules (isolated-vm, better-sqlite3) are compiled in `deps`,
# which has python3/g++/make. The final image only gets the compiled node_modules,
# so no compiler toolchain ships to production.

# ---------- Stage 1: install production dependencies (with build tools) ----------
FROM node:24-trixie-slim AS deps

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    # python3 + g++ + make: native modules (isolated-vm for the scaffolder) may compile on linux/arm64
    apt-get install -y --no-install-recommends python3 g++ make && \
    rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /app

COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .yarnrc.yml ./
COPY --chown=node:node backstage.json ./

ENV NODE_ENV=production

# The skeleton contains the package.json of each package in the monorepo,
# and along with yarn.lock and the root package.json, that's enough to run yarn install.
COPY --chown=node:node yarn.lock package.json packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# ---------- Stage 2: runtime (no compilers) ----------
FROM node:24-trixie-slim

# Pull in Debian security fixes released since the base image was built.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get upgrade -y --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Remove the package managers bundled in the Node base image (npm, npx, corepack, yarn v1).
# The backend runs with plain `node`; these are unused at runtime but ship their own
# outdated dependencies (e.g. brace-expansion, undici) that image scanners flag.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# From here on we use the least-privileged `node` user to run the backend.
USER node
WORKDIR /app

ENV NODE_ENV=production

# Dependencies (already compiled) + yarn files from the deps stage
COPY --from=deps --chown=node:node /app ./

# This will include the examples, if you don't need these simply remove this line
COPY --chown=node:node examples ./examples

# Then copy the rest of the backend bundle, along with any other files we might want.
COPY --chown=node:node packages/backend/dist/bundle.tar.gz app-config*.yaml ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]

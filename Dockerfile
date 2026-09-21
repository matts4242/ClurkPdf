# Images for the Compose deployment in `deploy/compose/`.
#
# Three targets share one dependency install and one build:
#
#   api    the Express server, production dependencies only
#   web    nginx serving the built browser bundle and proxying to the api
#   (both are built from the same `build` stage, so the work happens once)
#
# Debian rather than Alpine: `@napi-rs/canvas` renders every page image, and
# its glibc builds are the ones this project has actually been run against.

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is reused until a dependency changes.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS build
WORKDIR /app

# The client bundle is compiled, so anything it reads from the environment is
# baked in here rather than read at run time.
#
# VITE_SERVER_ORIGIN is empty on purpose: every request then goes to whatever
# origin served the page, which is what a deployment behind one proxy wants.
ARG VITE_SERVER_ORIGIN=""
ARG VITE_PAGE_DPI=150
ENV VITE_SERVER_ORIGIN=${VITE_SERVER_ORIGIN}
ENV VITE_PAGE_DPI=${VITE_PAGE_DPI}

# `prisma generate` runs during the build and Prisma 7 resolves the connection
# string from prisma.config.ts even when it is only generating. Nothing
# connects, so the value need only parse.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ---------------------------------------------------------------------------
# Production dependencies
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# `--ignore-scripts` skips @prisma/client's postinstall, which would try to
# generate a client from a schema this stage does not have. The generated
# client is copied in from the build instead.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS api
WORKDIR /app

ENV NODE_ENV=production

# Written to by the running server, so they belong to the account it runs as.
# A named volume mounted over either of these inherits this ownership when
# Docker first creates it, which is what keeps the server able to write.
RUN mkdir -p /data/uploads /data/tesseract \
    && chown -R node:node /data

COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules

# The schema engine `prisma migrate deploy` runs, taken from the build's
# install because the production one skipped the postinstall that downloads it.
# Without this the migrate container fetches 23MB from binaries.prisma.sh on
# every `up`, and an airgapped deployment never gets past migrations. Both
# stages are the same base image, so it is the same binary either way.
COPY --from=build --chown=node:node /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

COPY --chown=node:node package.json ./
COPY --chown=node:node server/package.json ./server/

# The compiled server, and the Prisma client generated beside it.
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/generated ./server/generated

# The schema, its migrations and the config `prisma migrate deploy` reads.
COPY --from=build --chown=node:node /app/server/prisma ./server/prisma
COPY --from=build --chown=node:node /app/server/prisma.config.ts ./server/

USER node
WORKDIR /app/server

EXPOSE 3001

# Node 22 has fetch built in, so the check needs nothing installed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# Web
# ---------------------------------------------------------------------------

FROM nginx:1.27-alpine AS web

COPY --from=build /app/client/dist /usr/share/nginx/html

# `templates`, not `conf.d`: the image's entrypoint runs envsubst over this
# directory at startup, which is what fills in the upload limit and the API
# port. Dropped straight into conf.d the `${...}` placeholders would reach
# nginx verbatim and it would refuse to start.
COPY deploy/compose/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget --quiet --spider http://127.0.0.1/ || exit 1

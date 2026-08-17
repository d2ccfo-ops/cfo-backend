# One image, three jobs: the API (dist/index.js), the worker (dist/worker.js)
# and migrations (npx prisma migrate deploy). Cloud Run runs the first two as
# separate services off this same digest, which is the point — the API and the
# worker can never drift to different versions of the calc code, because there
# is only one version to deploy.
#
# WHY DEV DEPENDENCIES ARE NOT PRUNED. `npm prune --omit=dev` would drop the
# `prisma` CLI, and with it the ability to run `prisma migrate deploy` from
# this image. That trade — ~250MB against being able to migrate from the same
# artifact that is running — is worth taking while this is a one-person
# deployment. The image never leaves Google's network anyway: Cloud Build
# builds it inside GCP and Cloud Run pulls it from Artifact Registry in the
# same region, so its size costs nobody's upload bandwidth.
#
# Debian slim, not Alpine: Prisma's query engine is compiled against glibc and
# openssl. Alpine (musl) needs a different engine binary and a different set of
# apt packages, and gets you nothing here.
FROM node:22-slim

# Prisma's engine dlopen()s libssl at runtime. node:22-slim does not ship it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# package*.json first, on its own layer. Docker reuses this layer on every
# build where dependencies did not change, so a src/ edit rebuilds in seconds
# instead of reinstalling ~400 packages.
COPY package.json package-lock.json ./
RUN npm ci

# Before src/, because the generated client is imported by almost every file
# in src/ — generate has to have happened by the time tsc runs.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production

# WHICH COMMIT IS THIS.
#
# A tag says v23. It does not say which source produced v23, and after a
# rebuild-and-retag — or the mis-build on 2026-08-17 where the console image was
# accidentally built from this directory — the tag is actively misleading. The
# sha is baked in at build time and surfaced by /health, so the running
# container answers the question itself instead of anyone inferring it from
# whatever the working tree happens to say now.
#
# Deliberately LAST, after every COPY. An ARG that changes on every commit
# invalidates every layer beneath it, so putting it near the top would turn
# each build into a full npm ci.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

# Not EXPOSE-d on a fixed port deliberately. Cloud Run injects PORT (8080) and
# config/env.ts coerces it, so the container binds whatever the platform asks
# for rather than a number hard-coded here.
CMD ["node", "dist/index.js"]

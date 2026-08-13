# Vyapar Sathi API.
#
# Single stage on purpose. A multi-stage build would shave a couple of hundred
# megabytes, but `npm start` runs `prisma migrate deploy` before booting, which
# needs the Prisma CLI — a dev dependency. Splitting stages to drop dev deps and
# then copying the CLI back in is more moving parts than the saving is worth for
# one small service.
#
# The frontend is NOT in this image. It builds to static files and goes to a
# static host; see docs/DEPLOYMENT.md.

FROM node:22-slim AS runtime

# Prisma's query engine needs OpenSSL, which the slim image omits.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a code-only change reuses this layer.
# `npm ci` respects the lockfile exactly. --include=dev because the build needs
# TypeScript and the start command needs the Prisma CLI.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# The schema must be present before `prisma generate`, which `npm run build`
# calls, and again at runtime for `migrate deploy`.
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# Documentation only — the platform maps its own port. server.ts reads PORT.
EXPOSE 4000

# Applies any pending migration, then boots. Running migrations here rather
# than in a separate release step keeps a deploy atomic from the operator's
# point of view: if the migration fails, the container does not start and the
# previous one keeps serving.
CMD ["npm", "start"]

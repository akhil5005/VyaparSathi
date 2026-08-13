# Vyapar Sathi — API and web app in one image, served from one origin.
#
# Single origin on purpose. Split across two hosts (`x.onrender.com` and
# `y.pages.dev`) the refresh cookie becomes a genuine third-party cookie, which
# Safari blocks by default and Chrome is phasing out — login would work on a
# laptop and fail on a phone. Serving both from one process sidesteps that, and
# costs one service instead of two.
#
# To split them later (two subdomains of one domain), build the frontend with
# VITE_API_URL set and deploy `web/dist` separately; the server only serves the
# app when `web/dist` is present, so it needs no change.

FROM node:22-slim AS runtime

# Prisma's query engine needs OpenSSL, which the slim image omits.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# ---- Dependencies -----------------------------------------------------------
# Copied first so a code-only change reuses these layers.
# `--include=dev` because the build needs TypeScript and Vite, and the start
# command needs the Prisma CLI for `migrate deploy`.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

# ---- Build the web app ------------------------------------------------------
# No VITE_API_URL: empty means same origin, which is the point of this image.
COPY web ./web
RUN npm --prefix web run build

# ---- Build the API ----------------------------------------------------------
# The schema is needed here for `prisma generate`, and again at runtime for
# `migrate deploy`.
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Documentation only — the platform maps its own port. server.ts reads PORT.
EXPOSE 4000

# Applies any pending migration, then boots. Running migrations here rather
# than as a separate release step keeps a deploy atomic from the operator's
# point of view: a failed migration means the container never starts, and the
# previous one keeps serving.
CMD ["npm", "start"]

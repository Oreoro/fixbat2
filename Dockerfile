# Reproducible local environment for FixBat.
#
# FixBat deploys to Cloudflare Workers, which run on Cloudflare's edge — this
# image is for development and CI, not production hosting. It runs the same
# workerd runtime wrangler uses, so what you see here is what deploys.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so edits to source do not invalidate the install layer.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund \
 && npm install-scripts approve esbuild workerd 2>/dev/null || true

COPY . .

RUN npm run build

EXPOSE 8787
ENV NODE_ENV=development

# The database lives in a named volume that starts empty, so on a first run it
# has no schema and every route answers 500. Applying migrations before the
# server starts is what makes `docker compose up` work from nothing; they are
# additive and idempotent, so this is also correct on every later restart.
#
# --ip 0.0.0.0 so the port is reachable from outside the container.
# --test-scheduled exposes /__scheduled, which the test suite uses to run the cron.
CMD ["sh", "-c", "npm run db:local && exec npx wrangler dev --ip 0.0.0.0 --port 8787 --local --test-scheduled"]

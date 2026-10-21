# RukwaRide API — multi-stage build for the pnpm monorepo.
FROM node:22-alpine AS build
# Pin pnpm to the version the repo is locked against (avoid floating `pnpm@9`,
# whose newer releases drift from the lockfile / CLI flags).
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# Workspace manifests first (layer caching).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/driver/package.json apps/driver/package.json
COPY scripts/package.json scripts/package.json
RUN pnpm install --frozen-lockfile --filter @rukwaride/api... --filter @rukwaride/shared

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @rukwaride/shared build \
  && cd apps/api && pnpm prisma generate && pnpm build

# Pruned production bundle (api + its prod deps incl. workspace shared).
# `pnpm deploy` already copies the built dist/ and prisma/ (schema + migrations).
# The pruned bundle's @prisma/client postinstall can't self-generate (the CLI is
# a devDep), so regenerate the client into /out with the matched CLI.
RUN pnpm --filter @rukwaride/api deploy --prod /out \
  && cd apps/api && pnpm exec prisma generate --schema=/out/prisma/schema.prisma

FROM node:22-alpine
RUN apk add --no-cache tini openssl
# Prisma CLI (pinned to the @prisma/client version) so the container applies
# migrations on boot. Installed globally to keep prisma's tree out of the
# runtime bundle and out of `pnpm audit --prod`.
RUN npm install -g prisma@6.19.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending migrations, then start. Single-VPS deploy (spec §15): one API
# instance, so there is no migrate race to guard against.
CMD ["sh", "-c", "prisma migrate deploy && node dist/main.js"]

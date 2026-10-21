# RukwaRide passenger PWA + staff console (Next.js standalone output).
FROM node:22-alpine AS build
# Pin pnpm to the locked version (avoid floating `pnpm@9` drift).
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/driver/package.json apps/driver/package.json
COPY scripts/package.json scripts/package.json
RUN pnpm install --frozen-lockfile --filter @rukwaride/web... --filter @rukwaride/shared

COPY packages/shared packages/shared
COPY apps/web apps/web
# Baked into the client bundle at build time:
ARG NEXT_PUBLIC_API_URL=https://api.example.co.tz
ARG NEXT_PUBLIC_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_TILE_URL=$NEXT_PUBLIC_TILE_URL
RUN pnpm --filter @rukwaride/shared build && pnpm --filter @rukwaride/web build

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]

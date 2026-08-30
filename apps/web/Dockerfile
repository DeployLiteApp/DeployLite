# syntax=docker/dockerfile:1.7

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN mkdir -p apps/web/public
RUN pnpm --filter @deploylite/contracts build && pnpm --filter @deploylite/web build

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S deploylite && adduser -S deploylite -G deploylite
COPY --from=build --chown=deploylite:deploylite /app/apps/web/.next/standalone ./
COPY --from=build --chown=deploylite:deploylite /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=deploylite:deploylite /app/apps/web/public ./apps/web/public
USER deploylite
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

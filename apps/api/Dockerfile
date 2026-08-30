# syntax=docker/dockerfile:1.7

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/agent apps/agent
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
RUN pnpm --filter @deploylite/api... build
RUN pnpm deploy --filter @deploylite/api --prod /prod \
  && rm -rf /prod/src /prod/node_modules/.bin \
  && rm -f /prod/Dockerfile /prod/tsconfig.json /prod/vitest.config.ts /prod/vitest.setup.ts \
  && rm -f /prod/dist/*.test.* \
  && find /prod/node_modules/.pnpm -type f \( -path '*/src/*' -o -name '*.test.*' -o -name 'tsconfig.json' -o -name 'vitest.config.ts' -o -name 'vitest.setup.ts' \) -delete

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S deploylite && adduser -S deploylite -G deploylite
COPY --from=build --chown=deploylite:deploylite /prod /app
COPY --from=build --chown=deploylite:deploylite /app/packages/db/migrations /app/packages/db/migrations
COPY --from=build --chown=deploylite:deploylite /app/packages/db/scripts /app/packages/db/scripts
USER deploylite
EXPOSE 3001
CMD ["node", "dist/index.js"]

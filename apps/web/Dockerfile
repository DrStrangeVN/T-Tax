FROM node:24-slim AS base
RUN corepack enable && corepack prepare pnpm@12.9.1 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @t-tax/web...

COPY packages packages
COPY apps/web apps/web

RUN pnpm --filter @t-tax/core build && pnpm --filter @t-tax/db build && pnpm --filter @t-tax/ui build && pnpm --filter @t-tax/web build

ENV NODE_ENV=production
ENV PORT=7331
ENV TTAX_DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 7331

CMD ["node", "apps/web/dist/server.js"]

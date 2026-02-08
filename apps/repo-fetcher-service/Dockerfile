FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/repo-fetcher-service ./apps/repo-fetcher-service
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @repolens/shared-utils build
RUN pnpm --filter @repolens/shared-types build
RUN pnpm --filter @repolens/repo-fetcher-service build
CMD ["node", "apps/repo-fetcher-service/dist/index.js"]

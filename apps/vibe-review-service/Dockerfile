FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/vibe-review-service ./apps/vibe-review-service
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @repolens/shared-utils build
RUN pnpm --filter @repolens/shared-types build
RUN pnpm --filter @repolens/vibe-review-service build
CMD ["node", "apps/vibe-review-service/dist/index.js"]

FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/intake-service ./apps/intake-service
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @repolens/shared-utils build
RUN pnpm --filter @repolens/shared-types build
RUN pnpm --filter @repolens/intake-service build
EXPOSE 3001
CMD ["node", "apps/intake-service/dist/index.js"]

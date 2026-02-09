FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web-client ./apps/web-client
RUN pnpm install --frozen-lockfile=false
EXPOSE 5173
CMD ["pnpm", "--filter", "@repolens/web-client", "dev", "--host", "0.0.0.0", "--port", "5173"]

# TLive Bridge — multi-stage production build
# Context: project root (needs pnpm-lock.yaml)
#
#   docker build -f bridge/Dockerfile -t tlive-bridge .
#   docker compose up -d

FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
COPY bridge/package.json bridge/
RUN cd bridge && pnpm install --frozen-lockfile --prod=false

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/bridge/node_modules bridge/node_modules
COPY bridge/ bridge/
RUN cd bridge && node esbuild.config.js

FROM node:22-alpine AS prod-deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
COPY bridge/package.json bridge/
RUN cd bridge && pnpm install --frozen-lockfile --prod

FROM node:22-alpine
RUN addgroup -S tlive && adduser -S tlive -G tlive
WORKDIR /app
COPY --from=prod-deps /app/bridge/node_modules node_modules
COPY --from=builder /app/bridge/dist dist
COPY bridge/package.json .

USER tlive
ENV NODE_ENV=production
EXPOSE 8849
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8849/health || exit 1
CMD ["node", "dist/main.mjs"]

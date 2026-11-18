# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine AS api
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
WORKDIR /repo/apps/api
CMD ["node", "dist/main.js"]

FROM node:22-alpine AS worker
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]

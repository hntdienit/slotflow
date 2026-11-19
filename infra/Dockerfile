# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN apk add --no-cache openssl libc6-compat && corepack enable
WORKDIR /repo
COPY . .
# Next bakes the /api rewrite target at build time
ARG API_URL=http://api:3000
ENV API_URL=$API_URL
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

FROM node:22-alpine AS web
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
WORKDIR /repo/apps/web
CMD ["pnpm", "exec", "next", "start", "-p", "3001"]

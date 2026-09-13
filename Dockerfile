# syntax=docker.io/docker/dockerfile:1

FROM node:22-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm i --frozen-lockfile

FROM base AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache libc6-compat
RUN corepack enable pnpm

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 voice

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm i --prod --frozen-lockfile && pnpm store prune

COPY --from=builder --chown=voice:nodejs /app/dist ./dist

RUN mkdir -p /app/whatsapp-auth && chown voice:nodejs /app/whatsapp-auth

USER voice

EXPOSE 8080

ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

CMD ["node", "dist/server.js"]

# syntax=docker/dockerfile:1
# LiveKit Cloud Agents — Node worker (see docs/livekit-cloud-deploy.md)

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

FROM base AS build
WORKDIR /app
ENV NODE_ENV=development
ENV HOME=/app
ENV XDG_CACHE_HOME=/app/.cache
ENV HF_HOME=/app/.cache/huggingface
RUN mkdir -p /app/.cache

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build
RUN npm run download-files
RUN npm prune --omit=dev

FROM base AS production

ARG UID=10001
RUN adduser \
  --disabled-password \
  --gecos "" \
  --home "/app" \
  --shell "/sbin/nologin" \
  --uid "${UID}" \
  appuser

WORKDIR /app
ENV HOME=/app
ENV XDG_CACHE_HOME=/app/.cache
ENV HF_HOME=/app/.cache/huggingface

COPY --from=build --chown=appuser:appuser /app/package.json /app/package-lock.json ./
COPY --from=build --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appuser /app/dist ./dist
COPY --from=build --chown=appuser:appuser /app/.cache ./.cache

USER appuser

CMD ["npm", "start"]

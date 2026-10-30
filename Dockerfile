# Uma imagem para todos os papéis: APP_ROLES escolhe o que o container roda; `bun run migrate` é o job one-shot dela.
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health/live >/dev/null || exit 1
CMD ["bun", "run", "src/main.ts"]

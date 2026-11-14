# Painel Next.js em modo "standalone" (servidor Node mínimo, sem node_modules completo).

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
# Sem NEXT_PUBLIC_API_URL: o painel chama a API na própria origem (o proxy separa /api).
RUN rm -f apps/web/.env.development && npm run build -w apps/web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

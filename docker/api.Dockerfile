# Imagem única do backend: roda como "api" (HTTP + Socket.IO), "worker" (sessões
# WhatsApp e filas) ou "migrate" (migrations + primeiro administrador), conforme o comando.

# ---------- build: compila o TypeScript ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --include-workspace-root --no-audit --no-fund
COPY apps/api apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w apps/api

# ---------- runtime: só dependências de produção ----------
FROM node:22-bookworm-slim AS runtime
# openssl: motor do Prisma · ffmpeg: miniatura e duração de vídeo/áudio enviados pelo Baileys
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --include-workspace-root --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/api/prisma apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
COPY --from=build /app/apps/api/dist apps/api/dist
# Pasta das mídias com dono "node": o volume nomeado herda essa permissão na primeira vez.
RUN mkdir -p /data/media && chown -R node:node /data/media
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

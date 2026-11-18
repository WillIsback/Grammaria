# Stage 1 : Build frontend
# Vite+ requiert Node ^22.18, ^24.11 ou >=26
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
# Pas de hooks git dans l'image
ENV VP_GIT_HOOKS=0
RUN npm ci

COPY . .
RUN npm run build

# Stage 2 : Runtime Bun
FROM oven/bun:alpine
WORKDIR /app

# Copier les artefacts du build
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Copier les fichiers serveur
COPY server.ts journal.ts telemetry.ts config.ts package.json bun.lock ./
COPY src/utils/streamErrors.ts src/utils/llmText.ts src/utils/upstream.ts ./src/utils/
COPY src/analysis ./src/analysis
COPY src/types.ts ./src/

# Installer uniquement les dépendances de production
# --ignore-scripts : le script "prepare" appelle vp, absent des dépendances de production
RUN bun install --production --frozen-lockfile --ignore-scripts

# Créer le fichier valid-words.json vide si absent
RUN mkdir -p public/data && \
    [ -f public/data/valid-words.json ] || echo '{"words":[]}' > public/data/valid-words.json

# Journal des fautes (SQLite) : monter un volume pour le conserver
RUN mkdir -p data
VOLUME /app/data

EXPOSE 25000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun run -e 'fetch("http://localhost:25000").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "run", "server.ts"]

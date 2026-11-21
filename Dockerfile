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

# Stage 2 : moteur grammatical (grammaria-rc, Rust).
# scripts/moteur/construire.sh récupère depuis GitHub (dépôt public, sans
# identifiant) la révision épinglée dans src-tauri/Cargo.toml — la même que
# l'application de bureau —, la compile et copie ses données dans /app/moteur.
# Image Alpine : le binaire est lié statiquement (musl) et tourne tel quel dans
# l'image Bun (Alpine), sans bibliothèque à installer.
# grammaria-rc exige Rust >= 1.75 (rust-version de son Cargo.toml).
FROM rust:1-alpine AS moteur
RUN apk add --no-cache bash git musl-dev
WORKDIR /app
COPY scripts/moteur/construire.sh ./scripts/moteur/
COPY src-tauri/Cargo.toml ./src-tauri/
RUN bash scripts/moteur/construire.sh

# Stage 3 : Runtime Bun
FROM oven/bun:alpine
WORKDIR /app

# Fuseaux horaires : sans tzdata, la variable TZ est ignorée et le « jour » des
# sollicitations (une par règle et par jour) changerait à minuit UTC.
RUN apk add --no-cache tzdata

# Version publiée (passée par la release), inscrite dans l'export de la bêta.
ARG VERSION=0.0.0
ENV GRAMMARIA_VERSION=$VERSION

# Copier les artefacts du build
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Correcteur grammatical intégré : binaire du moteur Rust, ses données et sa
# révision (grammar.ts le lance une fois : `moteur/grammaria serve --data moteur/data`)
COPY --from=moteur /app/moteur ./moteur

# Copier les fichiers serveur
COPY server.ts journal.ts journal.rules.ts journal.badges.ts journal.driver.ts journal.driver.bun.ts grammar.ts settings.ts statique.ts telemetry.ts config.ts package.json bun.lock ./
# api/ : gestionnaire des routes /api/* et /v1/*, partagé avec l'application de bureau
COPY api ./api
COPY src/utils/streamErrors.ts src/utils/llmText.ts src/utils/upstream.ts src/utils/modeles.ts src/utils/erreursModele.ts ./src/utils/
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

# `bun -e` et non `bun run -e` : avec Bun 1.4, `bun run -e` affiche l'aide et sort
# avec le code 0, et le conteneur paraissait toujours en bonne santé.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://localhost:25000").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "run", "server.ts"]

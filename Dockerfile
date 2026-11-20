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

# Stage 2 : moteur grammatical (grammaria-rc, Rust) — version expérimentale.
# Le dépôt du moteur est un contexte de build nommé :
#   docker build --build-context grammaria-rc=../grammaria-rc -t grammaria .
# Binaire lié statiquement (musl) : il tourne tel quel dans l'image Bun (Alpine).
FROM rust:1-alpine AS moteur
WORKDIR /src
COPY --from=grammaria-rc . .
RUN cargo build --release --locked --bin grammaria --bin grammaria-build
# Conversion des données (le lexique prend plusieurs minutes), puis règles de
# désambiguïsation, lues telles quelles par le moteur.
RUN mkdir -p /moteur/data && \
    ./target/release/grammaria-build --assets assets/fr --out /moteur/data && \
    cp assets/fr/languagetool-disambiguation.xml /moteur/data/fr.disambig.xml && \
    cp target/release/grammaria /moteur/grammaria

# Stage 3 : Runtime Bun
FROM oven/bun:alpine
WORKDIR /app

# Fuseaux horaires : sans tzdata, la variable TZ est ignorée et le « jour » des
# sollicitations (une par règle et par jour) changerait à minuit UTC.
RUN apk add --no-cache tzdata

# Copier les artefacts du build
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Correcteur grammatical intégré : binaire du moteur Rust et ses données
# (grammar.ts le lance une fois : `moteur/grammaria serve --data moteur/data`)
COPY --from=moteur /moteur ./moteur

# Copier les fichiers serveur
COPY server.ts journal.ts journal.rules.ts journal.badges.ts journal.driver.ts journal.driver.bun.ts grammar.ts settings.ts telemetry.ts config.ts package.json bun.lock ./
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun run -e 'fetch("http://localhost:25000").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "run", "server.ts"]

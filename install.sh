#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

IMAGE="ghcr.io/OWNER/grammaria:latest"

echo -e "${BOLD}Grammaria — Installation${NC}"
echo ""

# Vérifier Docker
if ! command -v docker &>/dev/null; then
  echo -e "${RED}Erreur : Docker est requis.${NC}"
  echo "Installer Docker : https://docs.docker.com/get-docker/"
  exit 1
fi

# Créer le dossier d'installation
INSTALL_DIR="${INSTALL_DIR:-grammaria}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo -e "${YELLOW}Configuration du fournisseur LLM :${NC}"
read -rp "URL de l'API LLM [http://localhost:11434] : " LLM_TARGET_INPUT
LLM_TARGET="${LLM_TARGET_INPUT:-http://localhost:11434}"

read -rp "Clé API (laisser vide si non requise) : " LLM_API_KEY
read -rp "Nom du modèle (ex: llama3, gpt-4o) : " LLM_MODEL_NAME

read -rp "Désactiver le mode thinking vLLM/Qwen3? [O/n] : " THINKING_CHOICE
if [[ "${THINKING_CHOICE,,}" == "n" ]]; then
  LLM_DISABLE_THINKING="false"
else
  LLM_DISABLE_THINKING="true"
fi

# Écrire le .env
cat > .env << EOF
LLM_TARGET=${LLM_TARGET}
LLM_API_KEY=${LLM_API_KEY}
LLM_MODEL_NAME=${LLM_MODEL_NAME}
LLM_DISABLE_THINKING=${LLM_DISABLE_THINKING}
PORT=25000
EOF

# Écrire le docker-compose.yml
cat > docker-compose.yml << COMPOSE
version: '3.8'

services:
  grammaria:
    image: ${IMAGE}
    container_name: grammaria
    ports:
      - "25000:25000"
    env_file: .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
COMPOSE

echo ""
echo -e "${GREEN}Démarrage de Grammaria...${NC}"
docker compose pull
docker compose up -d

echo ""
echo -e "${GREEN}✓ Grammaria disponible sur http://localhost:25000${NC}"
echo -e "  Logs : docker compose logs -f"
echo -e "  Arrêt : docker compose down"

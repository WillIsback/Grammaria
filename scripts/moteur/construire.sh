#!/usr/bin/env bash
# Construit le moteur grammatical (grammaria-rc, Rust) dans moteur/ :
#   moteur/grammaria        binaire (`grammaria serve`, lancé par grammar.ts)
#   moteur/data/lt/         ressources françaises de LanguageTool, lues telles quelles
#   moteur/data/grammaria/  règles propres au moteur et profil de règles
#   moteur/VERSION          révision du moteur construite
#
# Usage : scripts/moteur/construire.sh   (ou `npm run build:moteur`)
#
# Révision : une seule source de vérité, la dépendance `grammaria_rc` de
# src-tauri/Cargo.toml (l'application de bureau lie le moteur à cette révision ; le
# serveur web et l'image Docker doivent utiliser la même). Par défaut, le script
# récupère exactement cette révision depuis GitHub (dépôt public, aucun identifiant)
# dans le dossier de travail, puis la compile.
#
# Variables :
#   GRAMMARIA_RC_SRC         clone local de grammaria-rc à utiliser au lieu du réseau ;
#                            il doit être à la révision épinglée (sinon : erreur)
#   GRAMMARIA_RC_REV_LIBRE=1 accepter un clone local à une autre révision (développement
#                            du moteur seulement : le bureau, lui, garde la révision épinglée)
#   GRAMMARIA_MOTEUR_SORTIE  dossier produit (défaut : moteur/)
#   GRAMMARIA_MOTEUR_TRAVAIL dossier de travail : sources récupérées et compilation
#                            (défaut : .moteur-build/). Le clone local n'est jamais modifié.
#
# Les données ne sont pas converties : le moteur lit les fichiers de règles et les
# dictionnaires d'origine, `grammaria-build` ne fait que les copier.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SORTIE="${GRAMMARIA_MOTEUR_SORTIE:-$RACINE/moteur}"
TRAVAIL="${GRAMMARIA_MOTEUR_TRAVAIL:-$RACINE/.moteur-build}"
DEPOT="https://github.com/WillIsback/grammaria-rc"

# Windows (Git Bash) : chemins « D:/… », compris à la fois par bash et par cargo.exe
# (un chemin « /d/… » dans CARGO_TARGET_DIR ne serait pas compris par cargo).
if command -v cygpath > /dev/null 2>&1; then
  RACINE="$(cygpath -m "$RACINE")"
  SORTIE="$(cygpath -m "$SORTIE")"
  TRAVAIL="$(cygpath -m "$TRAVAIL")"
fi

REV="$(sed -n 's/^grammaria_rc = .*rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$RACINE/src-tauri/Cargo.toml")"
if [ -z "$REV" ]; then
  echo "[moteur] révision de grammaria_rc introuvable dans src-tauri/Cargo.toml" >&2
  exit 1
fi

mkdir -p "$TRAVAIL"
if [ -n "${GRAMMARIA_RC_SRC:-}" ]; then
  SRC="$(cd "$GRAMMARIA_RC_SRC" && pwd)"
  if command -v cygpath > /dev/null 2>&1; then SRC="$(cygpath -m "$SRC")"; fi
  if [ ! -f "$SRC/Cargo.toml" ]; then
    echo "[moteur] grammaria-rc introuvable dans $SRC (variable GRAMMARIA_RC_SRC)" >&2
    exit 1
  fi
  ACTUELLE="$(git -C "$SRC" rev-parse HEAD 2> /dev/null || echo inconnue)"
  if [ "$ACTUELLE" != "$REV" ]; then
    if [ "${GRAMMARIA_RC_REV_LIBRE:-}" = "1" ]; then
      echo "[moteur] attention : $SRC est à $ACTUELLE, src-tauri épingle $REV" >&2
      REV="$ACTUELLE"
    else
      echo "[moteur] $SRC est à $ACTUELLE, src-tauri/Cargo.toml épingle $REV." >&2
      echo "[moteur] Mettez le clone à cette révision, ou GRAMMARIA_RC_REV_LIBRE=1 pour passer outre." >&2
      exit 1
    fi
  fi
else
  # Récupère seulement la révision épinglée (GitHub accepte un fetch par commit).
  SRC="$TRAVAIL/grammaria-rc"
  if [ "$(git -C "$SRC" rev-parse HEAD 2> /dev/null || true)" != "$REV" ]; then
    echo "[moteur] récupération de grammaria-rc $REV"
    rm -rf "$SRC"
    git init -q "$SRC"
    git -C "$SRC" fetch -q --depth 1 "$DEPOT" "$REV"
    git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
fi

# Compilation hors des sources : un clone local reste intact.
export CARGO_TARGET_DIR="$TRAVAIL/target"
echo "[moteur] compilation de grammaria-rc $REV ($SRC)"
cargo build --release --locked --manifest-path "$SRC/Cargo.toml" --bin grammaria --bin grammaria-build

# Sous Windows (Git Bash), les binaires portent l'extension .exe.
EXE=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) EXE=".exe" ;; esac

mkdir -p "$SORTIE"
cp "$CARGO_TARGET_DIR/release/grammaria$EXE" "$SORTIE/grammaria$EXE"
chmod 755 "$SORTIE/grammaria$EXE"

# Données : copie fraîche, pour qu'un fichier retiré du moteur ne reste pas.
rm -rf "$SORTIE/data"
"$CARGO_TARGET_DIR/release/grammaria-build$EXE" --assets "$SRC/assets/fr" --out "$SORTIE/data"

# Version du moteur embarqué, pour les mesures et le diagnostic.
echo "$REV" > "$SORTIE/VERSION"

echo "[moteur] prêt :"
ls -l "$SORTIE/grammaria$EXE"
du -sh "$SORTIE/data/lt" "$SORTIE/data/grammaria"

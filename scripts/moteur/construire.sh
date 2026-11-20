#!/usr/bin/env bash
# Construit le moteur grammatical (grammaria-rc, Rust) dans moteur/ :
#   moteur/grammaria        binaire (`grammaria serve`, lancé par grammar.ts)
#   moteur/data/lt/         ressources françaises de LanguageTool, lues telles quelles
#   moteur/data/grammaria/  règles propres au moteur et profil de règles
#
# Usage : scripts/moteur/construire.sh
#   GRAMMARIA_RC_SRC : dépôt grammaria-rc (défaut : ../grammaria-rc, à côté de Grammaria)
#   GRAMMARIA_MOTEUR_SORTIE : dossier produit (défaut : moteur/)
#
# Les données ne sont plus converties : le moteur lit les fichiers de règles et les
# dictionnaires d'origine, `grammaria-build` ne fait que les copier.
#
# L'application de bureau lie la même version du moteur (dépendance `grammaria_rc` de
# src-tauri/Cargo.toml) : les données doivent lui correspondre. Un avertissement signale
# un dépôt qui n'est pas à la révision épinglée.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$(cd "${GRAMMARIA_RC_SRC:-$RACINE/../grammaria-rc}" && pwd)"
SORTIE="${GRAMMARIA_MOTEUR_SORTIE:-$RACINE/moteur}"

if [ ! -f "$SRC/Cargo.toml" ]; then
  echo "grammaria-rc introuvable dans $SRC (variable GRAMMARIA_RC_SRC)" >&2
  exit 1
fi

echo "[moteur] compilation de grammaria-rc ($SRC)"
cargo build --release --locked --manifest-path "$SRC/Cargo.toml" --bin grammaria --bin grammaria-build

# Sous Windows (Git Bash), les binaires portent l'extension .exe.
EXE=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) EXE=".exe" ;; esac

mkdir -p "$SORTIE"
install -m 755 "$SRC/target/release/grammaria$EXE" "$SORTIE/grammaria$EXE"

# Données : copie fraîche, pour qu'un fichier retiré du moteur ne reste pas.
rm -rf "$SORTIE/data"
"$SRC/target/release/grammaria-build$EXE" --assets "$SRC/assets/fr" --out "$SORTIE/data"

# Version du moteur embarqué, pour les mesures et le diagnostic.
REV="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo inconnue)"
echo "$REV" > "$SORTIE/VERSION"
EPINGLEE="$(sed -n 's/^grammaria_rc = .*rev = "\([0-9a-f]*\)".*/\1/p' "$RACINE/src-tauri/Cargo.toml")"
if [ -n "$EPINGLEE" ] && [ "$REV" != "$EPINGLEE" ]; then
  echo "[moteur] attention : $SRC est à $REV, src-tauri épingle $EPINGLEE" >&2
fi

echo "[moteur] prêt :"
ls -l "$SORTIE/grammaria$EXE"
du -sh "$SORTIE/data/lt" "$SORTIE/data/grammaria"

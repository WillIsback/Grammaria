#!/usr/bin/env bash
# Construit le moteur grammatical (grammaria-rc, Rust) dans moteur/ :
#   moteur/grammaria        binaire (`grammaria serve`, lancé par grammar.ts)
#   moteur/data/            fr.lex, fr.words, fr.rules, fr.disambig.xml
#
# Usage : scripts/moteur/construire.sh [--forcer]
#   GRAMMARIA_RC_SRC : dépôt grammaria-rc (défaut : ../grammaria-rc, à côté de Grammaria)
#   GRAMMARIA_MOTEUR_SORTIE : dossier produit (défaut : moteur/)
#
# La conversion du lexique domine (une dizaine de minutes) : elle n'est refaite que si les
# sources de grammaria-rc sont plus récentes que ses données (data/), ou avec --forcer.
#
# L'application de bureau lie la même version du moteur (dépendance `grammaria_rc` de
# src-tauri/Cargo.toml) : le format des données doit lui correspondre. Un avertissement
# signale un dépôt qui n'est pas à la révision épinglée.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$(cd "${GRAMMARIA_RC_SRC:-$RACINE/../grammaria-rc}" && pwd)"
SORTIE="${GRAMMARIA_MOTEUR_SORTIE:-$RACINE/moteur}"
FORCER="${1:-}"

if [ ! -f "$SRC/Cargo.toml" ]; then
  echo "grammaria-rc introuvable dans $SRC (variable GRAMMARIA_RC_SRC)" >&2
  exit 1
fi

echo "[moteur] compilation de grammaria-rc ($SRC)"
cargo build --release --locked --manifest-path "$SRC/Cargo.toml" --bin grammaria --bin grammaria-build

# Sous Windows (Git Bash), les binaires portent l'extension .exe.
EXE=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) EXE=".exe" ;; esac

mkdir -p "$SORTIE/data"
install -m 755 "$SRC/target/release/grammaria$EXE" "$SORTIE/grammaria$EXE"

# Les données sont produites dans le dépôt du moteur (data/, non suivi), puis copiées :
# elles y servent de cache d'une construction à l'autre.
FICHIERS="fr.lex fr.words fr.rules fr.disambig.xml"
a_jour() {
  [ "$FORCER" != "--forcer" ] || return 1
  for f in $FICHIERS; do
    [ -f "$SRC/data/$f" ] || return 1
  done
  # Une source ou le convertisseur plus récents que les données : à refaire.
  [ -z "$(find "$SRC/assets/fr" "$SRC/target/release/grammaria-build$EXE" -newer "$SRC/data/fr.rules" -print -quit)" ]
}

if a_jour; then
  echo "[moteur] données à jour ($SRC/data)"
else
  echo "[moteur] conversion des données (lexique : une dizaine de minutes)"
  (cd "$SRC" && "./target/release/grammaria-build$EXE" --assets assets/fr --out data)
fi
for f in $FICHIERS; do
  install -m 644 "$SRC/data/$f" "$SORTIE/data/$f"
done

# Version du moteur embarqué, pour les mesures et le diagnostic.
REV="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo inconnue)"
echo "$REV" > "$SORTIE/VERSION"
EPINGLEE="$(sed -n 's/^grammaria_rc = .*rev = "\([0-9a-f]*\)".*/\1/p' "$RACINE/src-tauri/Cargo.toml")"
if [ -n "$EPINGLEE" ] && [ "$REV" != "$EPINGLEE" ]; then
  echo "[moteur] attention : $SRC est à $REV, src-tauri épingle $EPINGLEE" >&2
fi

echo "[moteur] prêt :"
ls -l "$SORTIE/grammaria$EXE" "$SORTIE/data"

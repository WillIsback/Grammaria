import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lecture du Dockerfile et du `.dockerignore` pour les tests : ce que Docker verrait,
 * sans démon. La release v0.3.0 a échoué à sa dernière étape (image jamais construite
 * avant) : ces fonctions servent à repérer avant la release un fichier absent du
 * contexte, une étape inconnue, ou une copie vers le mauvais dossier.
 */
export const RACINE = join(import.meta.dirname, "../../..");

/**
 * Règles du `.dockerignore`, sémantique de Docker (moby/patternmatcher) : motifs ancrés à
 * la racine du contexte, `*` et `?` sans `/`, `**` pour plusieurs dossiers, un motif qui
 * couvre un dossier parent exclut le fichier, `!` réinclut, la dernière règle applicable
 * l'emporte.
 */
const regles = readFileSync(join(RACINE, ".dockerignore"), "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((ligne) => {
    const negation = ligne.startsWith("!");
    const motif = (negation ? ligne.slice(1) : ligne).replace(/^\/+/, "").replace(/\/+$/, "");
    let source = "";
    for (let i = 0; i < motif.length; i++) {
      const c = motif[i];
      if (c === "*" && motif[i + 1] === "*") {
        i++;
        if (motif[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else if (c === "*") source += "[^/]*";
      else if (c === "?") source += "[^/]";
      else source += c.replace(/[.+()|^$\\{}[\]]/g, "\\$&");
    }
    return { negation, regex: new RegExp(`^${source}$`) };
  });

/** Vrai si le chemin (relatif à la racine) est absent du contexte de build Docker. */
export function horsContexte(chemin: string): boolean {
  const morceaux = chemin.split("/");
  const candidats = morceaux.map((_, i) => morceaux.slice(0, i + 1).join("/"));
  let resultat = false;
  for (const { negation, regex } of regles) {
    if (candidats.some((c) => regex.test(c))) resultat = !negation;
  }
  return resultat;
}

export type Instruction = { commande: string; arguments: string };
export type Etape = { image: string; nom: string | null; instructions: Instruction[] };

/** Étapes du Dockerfile (lignes de continuation `\` jointes, commentaires retirés). */
export function etapesDockerfile(): Etape[] {
  const texte = readFileSync(join(RACINE, "Dockerfile"), "utf-8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ");
  const etapes: Etape[] = [];
  for (const ligne of texte.split("\n")) {
    const m = /^\s*([A-Z]+)\s+(.*)$/.exec(ligne);
    if (!m) continue;
    const [, commande, args] = m;
    if (commande === "FROM") {
      const [image, , nom] = args.trim().split(/\s+/);
      etapes.push({ image, nom: nom ?? null, instructions: [] });
    } else {
      etapes.at(-1)?.instructions.push({ commande, arguments: args.trim() });
    }
  }
  return etapes;
}

export type Copie = { depuis: string | null; sources: string[]; destination: string };

/** Les COPY d'une étape : `--from=…`, sources, destination. */
export function copies(etape: Etape): Copie[] {
  return etape.instructions
    .filter((i) => i.commande === "COPY")
    .map((i) => {
      const morceaux = i.arguments.split(/\s+/);
      const options = morceaux.filter((m) => m.startsWith("--"));
      const reste = morceaux.filter((m) => !m.startsWith("--"));
      const from = options.find((o) => o.startsWith("--from="));
      return {
        depuis: from ? from.slice("--from=".length) : null,
        sources: reste.slice(0, -1),
        destination: reste.at(-1) ?? "",
      };
    });
}

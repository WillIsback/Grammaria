/**
 * Génère tests/fixtures/correcteur/reference.json : pour chaque texte du corpus
 * (tests/fixtures/correcteur/corpus.ts), les détections du moteur du SERVEUR (grammar.ts),
 * dans l'ordre. C'est la référence que l'application de bureau doit reproduire (autotest :
 * src/desktop/autotest.ts ; même moteur Rust, lié à l'application) et que le serveur doit
 * continuer à produire (tests-bun/correcteur.reference.test.ts).
 *
 * Usage : bun scripts/desktop/reference-correcteur.ts [--verifier]
 *   --verifier : n'écrit rien, sort en erreur si le serveur ne produit plus la référence.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GrammarChecker } from "../../grammar.ts";
import type { LTMatch } from "../../src/types.ts";
import { CORPUS } from "../../tests/fixtures/correcteur/corpus.ts";

export const CHEMIN_REFERENCE = resolve(
  import.meta.dir,
  "../../tests/fixtures/correcteur/reference.json",
);

/** Ce qui est comparé d'une détection : règle, position, longueur, puis message et suggestions. */
export interface DetectionReference {
  regle: string;
  debut: number;
  longueur: number;
  message: string;
  suggestions: string[];
}

export interface TexteReference {
  nom: string;
  texte: string;
  mots: number;
  detections: DetectionReference[];
}

export interface Reference {
  /** Comment la régénérer. */
  generation: string;
  textes: TexteReference[];
}

/** Réduit une détection à ce que la référence compare (5 premières suggestions). */
export function resumer(match: LTMatch): DetectionReference {
  return {
    regle: match.rule.id,
    debut: match.offset,
    longueur: match.length,
    message: match.message,
    suggestions: match.replacements.slice(0, 5).map((r) => r.value),
  };
}

export async function calculerReference(checker: GrammarChecker): Promise<Reference> {
  const textes: TexteReference[] = [];
  for (const { nom, texte } of CORPUS) {
    const matches = await checker.check(texte);
    textes.push({
      nom,
      texte,
      mots: texte.split(/\s+/).filter(Boolean).length,
      detections: matches.map(resumer),
    });
  }
  return { generation: "bun scripts/desktop/reference-correcteur.ts", textes };
}

if (import.meta.main) {
  const checker = new GrammarChecker();
  try {
    const reference = await calculerReference(checker);
    const json = `${JSON.stringify(reference, null, 1)}\n`;
    if (process.argv.includes("--verifier")) {
      const actuelle = readFileSync(CHEMIN_REFERENCE, "utf8");
      if (actuelle !== json) {
        console.error(
          "[référence] le serveur ne produit plus tests/fixtures/correcteur/reference.json",
        );
        process.exitCode = 1;
      } else console.log("[référence] identique");
    } else {
      writeFileSync(CHEMIN_REFERENCE, json);
      const total = reference.textes.reduce((n, t) => n + t.detections.length, 0);
      console.log(
        `[référence] ${reference.textes.length} textes, ${total} détections → ${join("tests", "fixtures", "correcteur", "reference.json")}`,
      );
    }
  } finally {
    checker.close();
  }
}

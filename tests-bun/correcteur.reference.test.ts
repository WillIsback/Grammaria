import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { GrammarChecker } from "../grammar.ts";
import {
  CHEMIN_REFERENCE,
  calculerReference,
  type Reference,
} from "../scripts/desktop/reference-correcteur.ts";
import { CORPUS } from "../tests/fixtures/correcteur/corpus.ts";

// Référence versionnée des détections du serveur, que le Worker du bureau doit reproduire
// (scripts/desktop/verifier-correcteur.mjs). Si ce test échoue après une montée de version de
// ltjs, régénérer avec `bun scripts/desktop/reference-correcteur.ts` et relire le diff.
const checker = new GrammarChecker();
afterAll(() => checker.close());

const reference: Reference = JSON.parse(readFileSync(CHEMIN_REFERENCE, "utf8"));

describe("référence du correcteur", () => {
  it("couvre le corpus : au moins 15 textes variés, dont vide, emojis et très long", () => {
    expect(reference.textes.map((t) => t.nom)).toEqual(CORPUS.map((t) => t.nom));
    expect(reference.textes.map((t) => t.texte)).toEqual(CORPUS.map((t) => t.texte));
    expect(reference.textes.length).toBeGreaterThanOrEqual(15);
    const noms = reference.textes.map((t) => t.nom);
    for (const nom of ["vide", "emojis", "apostrophes-typographiques", "sans-faute", "long"]) {
      expect(noms).toContain(nom);
    }
    expect(Math.max(...reference.textes.map((t) => t.mots))).toBeGreaterThan(900);
  });

  it("le serveur produit toujours la référence (règles, positions, longueurs, ordre)", async () => {
    const actuelle = await calculerReference(checker);
    for (const [i, texte] of actuelle.textes.entries()) {
      expect({ nom: texte.nom, detections: texte.detections }).toEqual({
        nom: reference.textes[i].nom,
        detections: reference.textes[i].detections,
      });
    }
  }, 120_000);
});

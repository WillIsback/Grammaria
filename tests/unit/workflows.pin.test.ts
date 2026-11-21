import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Sécurité de la chaîne d'approvisionnement (issue #38) : chaque action GitHub
 * tierce doit être épinglée à une empreinte de commit (40 hexadécimaux), jamais
 * à un tag ni à une branche mobile (un tag déplacé ou une action compromise en
 * amont injecterait du code dans un job qui détient les secrets de signature).
 * Les workflows réutilisables du dépôt (`uses: ./…`) sont exclus.
 */
const DOSSIER = join(import.meta.dirname, "../../.github/workflows");
const RE_USES = /^\s*(?:-\s*)?uses:\s*(\S+)/;

function usesExternes(): { fichier: string; valeur: string }[] {
  const resultats: { fichier: string; valeur: string }[] = [];
  for (const nom of readdirSync(DOSSIER).filter((n) => n.endsWith(".yml"))) {
    for (const ligne of readFileSync(join(DOSSIER, nom), "utf-8").split("\n")) {
      const m = RE_USES.exec(ligne);
      if (m && !m[1].startsWith("./")) resultats.push({ fichier: nom, valeur: m[1] });
    }
  }
  return resultats;
}

describe("épinglage des actions GitHub", () => {
  const uses = usesExternes();

  it("il y a bien des actions tierces à vérifier", () => {
    expect(uses.length).toBeGreaterThan(5);
  });

  it("chaque action tierce est épinglée à un SHA de commit (40 hex)", () => {
    const nonEpinglees = uses.filter(({ valeur }) => !/@[0-9a-f]{40}$/.test(valeur));
    expect(nonEpinglees).toEqual([]);
  });

  it("chaque épinglage garde le tag en commentaire", () => {
    for (const { fichier, valeur } of uses) {
      const ligne = readFileSync(join(DOSSIER, fichier), "utf-8")
        .split("\n")
        .find((l) => l.includes(valeur));
      expect(ligne, `${valeur} sans commentaire de version`).toMatch(/@[0-9a-f]{40} # \S/);
    }
  });
});

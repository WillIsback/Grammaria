import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GrammarChecker } from "../grammar.ts";

// Le moteur garde des balises dans les messages de ses règles (« <suggestion>…</suggestion> »)
// pour en tirer les remplacements. Aucune ne doit arriver jusqu'à l'écran : la v0.4.0 les
// affichait en clair (#25). La référence du correcteur ne peut pas le voir seule — elle est
// régénérée avec le moteur — donc ce test fait parler, sur leurs propres exemples, les règles
// dont le message porte une balise, et lit ce que le serveur renvoie à l'interface.
const BALISE = /<\/?(suggestion|match|marker|pleasespellme|mistake)\b/i;
const ECHANTILLON = 300;

const decoder = (xml: string) =>
  xml
    .replace(/<\/?marker>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Un exemple fautif par règle dont le message contient une balise, répartis sur le fichier. */
function exemplesDesReglesBalisees(): string[] {
  const xml = readFileSync(join(import.meta.dir, "../moteur/data/lt/grammar.xml"), "utf8");
  const exemples: string[] = [];
  for (const regle of xml.split(/<rule[\s>]/)) {
    if (!/<message>[^]*?<suggestion>[^]*?<\/message>/.test(regle)) continue;
    const exemple = /<example correction="[^"]+">([^]*?)<\/example>/.exec(regle)?.[1];
    if (exemple && !exemple.includes("\n")) exemples.push(decoder(exemple));
  }
  const pas = Math.max(1, Math.floor(exemples.length / ECHANTILLON));
  return exemples.filter((_, i) => i % pas === 0);
}

const checker = new GrammarChecker();
afterAll(() => checker.close());

describe("messages des règles", () => {
  it("aucune balise du moteur n'arrive jusqu'à l'interface", async () => {
    const exemples = exemplesDesReglesBalisees();
    expect(exemples.length).toBeGreaterThanOrEqual(ECHANTILLON);

    const fautives: string[] = [];
    let citations = 0;
    for (const exemple of exemples) {
      for (const detection of await checker.check(exemple)) {
        const textes = [
          detection.message,
          detection.shortMessage,
          ...detection.replacements.map((r) => r.value),
        ];
        if (textes.some((t) => BALISE.test(t))) {
          fautives.push(`${detection.rule.id} : ${detection.message}`);
        }
        if (detection.message.includes("« ")) citations++;
      }
    }
    expect(fautives).toEqual([]);
    // Le test doit vraiment avoir fait parler ces règles : leurs suggestions sont citées
    // entre guillemets dans le message.
    expect(citations).toBeGreaterThanOrEqual(100);
  }, 120_000);
});

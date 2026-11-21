import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * La référence du correcteur (tests/fixtures/correcteur/reference.json) est ce que le serveur
 * et l'application de bureau doivent tous deux produire : leurs tests la comparent à ce qu'ils
 * affichent. Si une balise du moteur s'y glisse, ces tests comparent le défaut à lui-même et
 * restent verts — c'est ce qui a laissé passer les « <suggestion> » de la v0.4.0 (#25).
 */
const reference = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/correcteur/reference.json"), "utf-8"),
) as { textes: { nom: string; detections: { message: string; suggestions: string[] }[] }[] };

const detections = reference.textes.flatMap((t) => t.detections);

describe("référence du correcteur : textes affichés", () => {
  it("aucun message ni suggestion ne contient de balise", () => {
    const balise = /<\/?[a-z][^>]*>/i;
    const fautifs = detections
      .flatMap((d) => [d.message, ...d.suggestions])
      .filter((texte) => balise.test(texte));
    expect(fautifs).toEqual([]);
  });

  it("les suggestions citées dans un message le sont entre guillemets français", () => {
    expect(detections.filter((d) => d.message.includes("« ")).length).toBeGreaterThan(10);
  });
});

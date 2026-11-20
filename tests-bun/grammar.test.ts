import { afterAll, describe, expect, it } from "bun:test";
import { GrammarChecker } from "../grammar.ts";
import { analyze } from "../src/analysis/analyze.ts";

// Moteur réel (version expérimentale) : le moteur Rust grammaria-rc, lancé une fois par
// grammar.ts (`moteur/grammaria serve`). À construire avant : `npm run build:moteur`.
const checker = new GrammarChecker();
afterAll(() => checker.close());

// Le premier appel lance le moteur et charge ses données.
const LOAD_TIMEOUT_MS = 60_000;

/** Message de l'erreur qui rejette `promesse` ; null si elle aboutit. */
const messageEchec = (promesse: Promise<unknown>): Promise<string | null> =>
  promesse.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("GrammarChecker", () => {
  it(
    "détecte les fautes au format LanguageTool",
    async () => {
      const text = "Je mange un pomme. Il a manger une pomme.";
      const matches = await checker.check(text);

      const accord = matches.find((m) => m.rule.id === "D_N");
      expect(accord && text.slice(accord.offset, accord.offset + accord.length)).toBe("un pomme");
      expect(accord?.replacements[0]?.value).toBe("une pomme");
      expect(accord?.rule.category?.id).toBeTruthy();
      expect(accord?.message).toContain("pomme");
      const participe = matches.find((m) => m.rule.id === "R_VAVOIR_VINF");
      expect(participe && text.slice(participe.offset, participe.offset + participe.length)).toBe(
        "Il a manger",
      );
    },
    LOAD_TIMEOUT_MS,
  );

  // Pertes connues du moteur Rust par rapport au portage JavaScript de LanguageTool
  // (voir benchmark/moteur-rust/rapport.md) : pas de correcteur orthographique, et l'accord
  // sujet-verbe (« les enfants était ») n'est pas détecté.
  it.todo("reconnaît une faute d'orthographe (FR_SPELLING_RULE)", () => {});
  it.todo("détecte l'accord sujet-verbe (ACCORD_SUJET_VERBE)", () => {});

  it("ne signale rien sur un texte correct", async () => {
    expect(await checker.check("Les enfants étaient contents.")).toEqual([]);
  });

  it("positions en unités UTF-16, comme les chaînes JavaScript (emojis, accents)", async () => {
    const text = "Génial 😀 👨‍👩‍👧 ! Je mange un pomme.";
    const matches = await checker.check(text);
    const accord = matches.find((m) => m.rule.id === "D_N");
    expect(accord && text.slice(accord.offset, accord.offset + accord.length)).toBe("un pomme");
  });

  it("demandes simultanées : chacune reçoit sa propre réponse", async () => {
    const textes = Array.from({ length: 12 }, (_, i) =>
      i % 2 ? `Texte ${i} : je mange un pomme.` : `Texte ${i} : je mange une pomme.`,
    );
    const resultats = await Promise.all(textes.map((t) => checker.check(t)));
    expect(resultats.map((m) => m.filter((x) => x.rule.id === "D_N").length)).toEqual(
      textes.map((_, i) => i % 2),
    );
  });

  it("alimente l'analyse : la faute corrigée est classée et comptée", async () => {
    const original = "Je mange un pomme.";
    const corrected = "Je mange une pomme.";
    const analysis = analyze(original, corrected, await checker.check(original));
    expect(analysis.corrections[0].faults[0]).toMatchObject({
      source: "lt",
      ruleKey: "D_N",
      counted: true,
    });
  });
});

describe("GrammarChecker — processus du moteur", () => {
  it("moteur tué : les demandes en cours sont rejetées, la suivante le relance", async () => {
    const local = new GrammarChecker();
    try {
      expect(await local.check("Bonjour.")).toEqual([]);
      const moteur = (local as unknown as { moteur: { kill(): void } }).moteur;
      const enCours = local.check("Je mange un pomme.");
      moteur.kill();
      expect(await messageEchec(enCours)).toContain("s'est arrêté");
      const suivante = await local.check("Je mange un pomme.");
      expect(suivante.some((m) => m.rule.id === "D_N")).toBe(true);
    } finally {
      local.close();
    }
  });

  it("binaire introuvable : erreur lisible, sans bloquer", async () => {
    const avant = process.env.GRAMMARIA_MOTEUR;
    process.env.GRAMMARIA_MOTEUR = "/introuvable/grammaria";
    const local = new GrammarChecker();
    try {
      expect(await messageEchec(local.check("Bonjour."))).toContain(
        "Le correcteur grammatical s'est arrêté",
      );
    } finally {
      local.close();
      if (avant === undefined) delete process.env.GRAMMARIA_MOTEUR;
      else process.env.GRAMMARIA_MOTEUR = avant;
    }
  });

  it("données introuvables : le message du moteur est transmis", async () => {
    const avant = process.env.GRAMMARIA_MOTEUR_DONNEES;
    process.env.GRAMMARIA_MOTEUR_DONNEES = "/introuvable/data";
    const local = new GrammarChecker();
    try {
      expect(await messageEchec(local.check("Bonjour."))).toMatch(/missing fr\.lex/);
    } finally {
      local.close();
      if (avant === undefined) delete process.env.GRAMMARIA_MOTEUR_DONNEES;
      else process.env.GRAMMARIA_MOTEUR_DONNEES = avant;
    }
  });

  it("close : les demandes en attente sont rejetées", async () => {
    const local = new GrammarChecker();
    const demande = local.check("Bonjour.");
    local.close();
    expect(await messageEchec(demande)).toContain("a été arrêté");
  });
});

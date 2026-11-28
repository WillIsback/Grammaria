import { describe, expect, it } from "bun:test";
import { Journal } from "../journal.ts";
import type { JournalDriver } from "../journal.driver.ts";
import { SEUILS } from "../src/analysis/regles/seuils.ts";
import { corriger, DAY, EMPLOI_ON, FAUTE_ON, jour, piloteEspion, SANS_FAUTE } from "./helpers.ts";

/** Texte de plus de 30 mots, sans faute. */
const LONG = Array(2).fill(
  "Nous vous remercions pour votre message et nous vous confirmons la réunion de jeudi prochain à dix heures dans la grande salle du deuxième étage avec toute l'équipe du projet.",
);

/** Fait taire `console.error` pendant `f` et renvoie les messages reçus. */
async function erreursPendant(f: () => Promise<unknown>): Promise<string[]> {
  const erreurs: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => void erreurs.push(args.map(String).join(" "));
  try {
    await f();
  } finally {
    console.error = consoleError;
  }
  return erreurs;
}

/** Amène « on / ont » jusqu'au premier choix à deux formes ; renvoie son choiceId. */
async function jusquAuChoix(journal: Journal): Promise<number> {
  await corriger(journal, FAUTE_ON, jour(0));
  await corriger(journal, FAUTE_ON, jour(0) + 1000);
  for (let i = 0; i < SEUILS.astucesAvantTravail; i++)
    await corriger(journal, FAUTE_ON, jour(i) + 2000);
  const { intervention } = await corriger(journal, FAUTE_ON, jour(SEUILS.astucesAvantTravail));
  if (intervention?.type !== "choix") throw new Error("choix attendu");
  return intervention.choiceId;
}

describe("Journal — lire, calculer, écrire un lot", () => {
  it("record fait exactement un readMany et un batch (hors migration)", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    pilote.remettreAZero();

    // Fautes, astuces, choix, usage, acquisition, rechute : toujours 1 + 1.
    const textes: [string[], number][] = [
      [FAUTE_ON, jour(0)],
      [FAUTE_ON, jour(0) + 1000],
      [FAUTE_ON, jour(0) + 2000],
      [FAUTE_ON, jour(1)],
      [FAUTE_ON, jour(2)],
      [FAUTE_ON, jour(3)],
      ...[4, 5, 6, 7, 8, 9].map((n): [string[], number] => [EMPLOI_ON, jour(n)]),
      [EMPLOI_ON, jour(17)],
      [FAUTE_ON, jour(18)],
    ];
    for (const [i, [texte, now]] of textes.entries()) {
      await corriger(journal, texte, now);
      expect(pilote.appels).toMatchObject({ read: 0, readMany: i + 1, batch: i + 1 });
    }
    // Le scénario a bien traversé tout le cycle.
    const types = new Set((await journal.ruleEvents({ limit: 1000 })).map((e) => e.type));
    expect([...types].map(String).sort()).toEqual(
      [
        "acquise",
        "astuce",
        "choix",
        "emploi",
        "observee",
        "rechute",
        "signalee",
        "travaillee",
      ].sort(),
    );
  });

  it("le lot de record contient le texte, ses fautes, les états, les événements et les badges", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    pilote.remettreAZero();
    await corriger(journal, FAUTE_ON, jour(0));
    const [lot] = pilote.appels.lots;
    const cibles = lot.map((s) => s.sql.match(/INTO (\w+)/)?.[1]);
    expect(cibles).toEqual([
      "texts",
      "faults",
      "rule_labels",
      "rule_states",
      "rule_events",
      "badges",
    ]);
    expect(lot[1].params?.[0]).toEqual({ $rowid: 0 });
  });

  it("award juste après record n'interroge pas la base et annonce les badges du lot", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    await corriger(journal, LONG, jour(0));
    pilote.remettreAZero();
    const badges = await journal.badges.award(jour(0) + 5);
    expect(badges.map((b) => b.id)).toEqual(["premier-texte", "premier-sans-faute"]);
    expect(pilote.appels).toMatchObject({ read: 0, readMany: 0, batch: 0 });
    // Déjà annoncés : plus rien ensuite.
    expect(await journal.badges.award(jour(0) + 10)).toEqual([]);
    // Une date antérieure à la dernière évaluation relit la base.
    expect(await journal.badges.award(jour(0) - 10)).toEqual([]);
    expect(pilote.appels.readMany).toBe(1);
  });

  it("le choiceId est l'id de l'événement « choix » écrit par le lot", async () => {
    const journal = await Journal.ouvrir(piloteEspion());
    const choiceId = await jusquAuChoix(journal);
    const [dernier] = await journal.ruleEvents({ limit: 1 });
    expect(dernier).toMatchObject({ id: choiceId, type: "choix" });
  });

  it("answerChoice lit une fois et écrit un lot", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    const choiceId = await jusquAuChoix(journal);
    pilote.remettreAZero();
    expect(await journal.answerChoice(choiceId, true, jour(5))).toBe("recorded");
    expect(pilote.appels).toMatchObject({ read: 0, readMany: 1, batch: 1 });
    pilote.remettreAZero();
    expect(await journal.answerChoice(choiceId, true, jour(5))).toBe("conflict");
    expect(pilote.appels).toMatchObject({ read: 0, readMany: 1, batch: 0 });
  });

  it("answerChoice : une réponse concurrente arrivée après la lecture fait échouer le lot (expectChanges)", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    const choiceId = await jusquAuChoix(journal);
    const avant = await journal.rules();
    // Juste après la lecture de answerChoice, une autre écriture répond au choix.
    let fait = false;
    pilote.apresReadMany = (_queries, lignes) => {
      if (!fait) {
        fait = true;
        pilote.pilote.db.exec(
          `INSERT INTO rule_events (rule_key, created_at, type) VALUES ('PAIRE:on/ont', ${jour(5)}, 'reponse_fausse')`,
        );
      }
      return lignes;
    };
    expect(await journal.answerChoice(choiceId, true, jour(5) + 1)).toBe("conflict");
    pilote.apresReadMany = undefined;
    // Le lot a été annulé en entier : l'état n'a pas bougé, aucune réponse juste.
    expect(await journal.rules()).toEqual(avant);
    const reponses = (await journal.ruleEvents({ limit: 1000 })).filter((e) =>
      e.type.startsWith("reponse"),
    );
    expect(reponses.map((e) => e.type)).toEqual(["reponse_fausse"]);
  });

  it("enchaîne les écritures concurrentes sans les entrelacer, même derrière un pont asynchrone", async () => {
    const pilote = piloteEspion();
    // Pont lent : chaque appel répond au tour suivant de la boucle d'événements.
    const lent: JournalDriver = {
      read: (sql, params) => Bun.sleep(1).then(() => pilote.read(sql, params)),
      readMany: (queries) => Bun.sleep(1).then(() => pilote.readMany(queries)),
      batch: (statements) => Bun.sleep(1).then(() => pilote.batch(statements)),
      compacter: () => Bun.sleep(1).then(() => pilote.compacter()),
    };
    const journal = await Journal.ouvrir(lent);
    await Promise.all([
      corriger(journal, FAUTE_ON, jour(0)),
      corriger(journal, FAUTE_ON, jour(0) + 1000),
      corriger(journal, FAUTE_ON, jour(0) + 2000),
    ]);
    const [regle] = await journal.rules();
    expect(regle).toMatchObject({ occurrences: 3, state: "signalee", tipsShown: 1 });
    expect((await journal.period(7, jour(1))).texts).toBe(3);
  });
});

describe("Journal — le texte et ses fautes ne sont jamais perdus", () => {
  it("si le suivi des règles échoue, le lot ne contient que le texte et ses fautes", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    await corriger(journal, FAUTE_ON, jour(0));
    pilote.remettreAZero();
    // Instantané des états des règles illisible : le calcul du suivi lève une erreur.
    pilote.apresReadMany = (_queries, lignes) => lignes.map((l, i) => (i === 0 ? [null] : l));
    const erreurs = await erreursPendant(() => corriger(journal, FAUTE_ON, jour(1)));
    pilote.apresReadMany = undefined;
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toContain("suivi des règles annulé");
    expect(pilote.appels.batch).toBe(1);
    const cibles = pilote.appels.lots[0].map((s) => s.sql.match(/INTO (\w+)/)?.[1]);
    // Texte, faute… et les badges, calculés sans le suivi.
    expect(cibles.filter((c) => c !== "badges")).toEqual(["texts", "faults", "rule_labels"]);
    expect((await journal.period(7, jour(2))).faults).toBe(2);
    expect((await journal.rules())[0]).toMatchObject({ occurrences: 1 });
  });

  it("si le calcul des badges échoue, le texte, ses fautes et le suivi sont écrits", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    await corriger(journal, FAUTE_ON, jour(0));
    await corriger(journal, FAUTE_ON, jour(1));
    await corriger(journal, SANS_FAUTE, jour(2));
    await corriger(journal, SANS_FAUTE, jour(3));
    expect((await journal.badges.award(jour(3))).map((b) => b.id)).toEqual(["premier-texte"]);
    pilote.remettreAZero();
    // Lignes des badges obtenus illisibles : le calcul des badges lève une erreur.
    pilote.apresReadMany = (queries, lignes) =>
      lignes.map((l, i) => (queries[i].sql.includes("badge_id AS id") ? [null] : l));
    let suivi: Awaited<ReturnType<Journal["record"]>> | undefined;
    // Troisième faute en sept jours, et cinquième jour d'écriture (badge « jours-5 »).
    const erreurs = await erreursPendant(async () => {
      suivi = await corriger(journal, FAUTE_ON, jour(4));
    });
    pilote.apresReadMany = undefined;
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toContain("[Badges]");
    expect(suivi?.intervention).toMatchObject({ type: "astuce", ruleKey: "PAIRE:on/ont" });
    const cibles = pilote.appels.lots[0].map((s) => s.sql.match(/INTO (\w+)/)?.[1]);
    expect(cibles).toEqual([
      "texts",
      "faults",
      "rule_labels",
      "rule_states",
      "rule_events",
      "rule_events",
    ]);
    expect((await journal.period(7, jour(5))).texts).toBe(5);
    expect((await journal.rules())[0]).toMatchObject({ state: "signalee", occurrences: 3 });
    expect((await journal.badges.obtained()).has("jours-5")).toBe(false);
    // L'évaluation suivante relit la base et attribue le badge manqué, à sa date.
    expect((await journal.badges.award(jour(4) + 1)).map((b) => b.id)).toEqual(["jours-5"]);
    expect((await journal.badges.obtained()).get("jours-5")).toBe(jour(4));
  });

  it("si le lot est refusé à cause du suivi, le texte et ses fautes sont écrits seuls", async () => {
    const pilote = piloteEspion();
    const journal = await Journal.ouvrir(pilote);
    await corriger(journal, FAUTE_ON, jour(0));
    const avant = await journal.rules();
    pilote.remettreAZero();
    pilote.avantBatch = (statements) => {
      if (statements.some((s) => s.sql.includes("rule_states"))) throw new Error("disque plein");
    };
    let suivi: Awaited<ReturnType<Journal["record"]>> | undefined;
    const erreurs = await erreursPendant(async () => {
      suivi = await corriger(journal, FAUTE_ON, jour(1));
    });
    pilote.avantBatch = undefined;
    expect(suivi).toEqual({ intervention: null, reussites: [] });
    expect(erreurs).toHaveLength(1);
    expect(pilote.appels.batch).toBe(2);
    expect(pilote.appels.lots[1].map((s) => s.sql.match(/INTO (\w+)/)?.[1])).toEqual([
      "texts",
      "faults",
      "rule_labels",
    ]);
    expect((await journal.period(7, jour(2))).faults).toBe(2);
    expect(await journal.rules()).toEqual(avant);
    // Le texte suivant est suivi normalement, avec toutes les fautes journalisées.
    await corriger(journal, FAUTE_ON, jour(1) + DAY / 2);
    expect((await journal.rules())[0]).toMatchObject({ occurrences: 2, state: "signalee" });
  });
});

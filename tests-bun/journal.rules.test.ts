import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type Journal, SCHEMA_VERSION } from "../journal.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { SEUILS } from "../src/analysis/regles/seuils.ts";
import { avecBase, corriger, DAY, FAUTE_ON, jour, ouvrirJournal, SANS_FAUTE } from "./helpers.ts";

const ON = "PAIRE:on/ont";

const regle = async (journal: Journal, ruleKey = ON) =>
  (await journal.rules()).find((r) => r.ruleKey === ruleKey);

/** Amène « on / ont » à l'état travaillée ; renvoie le jour de la dernière faute. */
async function rendreTravaillee(journal: Journal): Promise<number> {
  await corriger(journal, FAUTE_ON, jour(0));
  await corriger(journal, FAUTE_ON, jour(0) + 1000);
  // Troisième faute : signalée, première astuce. Puis une astuce par jour.
  for (let i = 0; i < SEUILS.astucesAvantTravail; i++)
    await corriger(journal, FAUTE_ON, jour(i) + 2000);
  const dernier = jour(SEUILS.astucesAvantTravail);
  await corriger(journal, FAUTE_ON, dernier);
  return dernier;
}

describe("Journal — cycle de vie des règles", () => {
  it("n'intervient pas avant la troisième faute en sept jours", async () => {
    const journal = await ouvrirJournal(":memory:");
    expect(await corriger(journal, FAUTE_ON, jour(0))).toEqual({
      intervention: null,
      reussites: [],
    });
    expect(await regle(journal)).toMatchObject({ state: "observee", occurrences: 1 });
    expect((await corriger(journal, FAUTE_ON, jour(1))).intervention).toBeNull();

    const troisieme = await corriger(journal, FAUTE_ON, jour(2));
    expect(troisieme.intervention).toMatchObject({
      type: "astuce",
      ruleKey: ON,
      titre: "on / ont",
    });
    expect(await regle(journal)).toMatchObject({
      state: "signalee",
      occurrences: 3,
      tipsShown: 1,
      firstFaultAt: jour(0),
      lastFaultAt: jour(2),
      label: "on / ont",
      categoryName: "Confusion de mots",
    });
    expect((await regle(journal))?.fiche?.astuce).toContain("avaient");
  });

  it("ne signale pas trois fautes étalées sur plus de sept jours", async () => {
    const journal = await ouvrirJournal(":memory:");
    await corriger(journal, FAUTE_ON, jour(0));
    await corriger(journal, FAUTE_ON, jour(4));
    expect((await corriger(journal, FAUTE_ON, jour(8))).intervention).toBeNull();
    expect((await regle(journal))?.state).toBe("observee");
  });

  it("n'affiche qu'une astuce par règle et par jour", async () => {
    const journal = await ouvrirJournal(":memory:");
    await corriger(journal, FAUTE_ON, jour(0));
    await corriger(journal, FAUTE_ON, jour(0) + 1000);
    expect((await corriger(journal, FAUTE_ON, jour(0) + 2000)).intervention?.type).toBe("astuce");
    expect((await corriger(journal, FAUTE_ON, jour(0) + 3000)).intervention).toBeNull();
    expect(await regle(journal)).toMatchObject({ tipsShown: 1, occurrences: 4 });
    // Le lendemain, le budget est de nouveau disponible. La règle a déjà reçu
    // son astuce : la faute la fait passer en « travaillée » (issue #61).
    expect((await corriger(journal, FAUTE_ON, jour(1))).intervention?.type).toBe("choix");
  });

  it("propose les deux formes quand la faute persiste après les astuces", async () => {
    const journal = await ouvrirJournal(":memory:");
    await corriger(journal, FAUTE_ON, jour(0));
    await corriger(journal, FAUTE_ON, jour(0) + 1000);
    for (let i = 0; i < SEUILS.astucesAvantTravail; i++) {
      expect((await corriger(journal, FAUTE_ON, jour(i) + 2000)).intervention?.type).toBe("astuce");
    }
    expect(await regle(journal)).toMatchObject({
      state: "signalee",
      tipsShown: SEUILS.astucesAvantTravail,
    });

    const choix = await corriger(journal, FAUTE_ON, jour(SEUILS.astucesAvantTravail), () => 0.9);
    expect(choix.intervention).toEqual({
      type: "choix",
      choiceId: expect.any(Number),
      ruleKey: ON,
      titre: "on / ont",
      explication: expect.stringContaining("avaient"),
      avant: "Hier, ils ",
      apres: " mangé tous les gâteaux.",
      formes: [
        { texte: "on", correcte: false },
        { texte: "ont", correcte: true },
      ],
      // Position de « ont » dans le texte corrigé, à masquer à l'écran (issue #59).
      masque: { start: 10, end: 13 },
    });
    expect(await regle(journal)).toMatchObject({ state: "travaillee", choicesShown: 1 });

    // Une seule sollicitation par jour : bouton Copier normal ensuite.
    const jourDuChoix = jour(SEUILS.astucesAvantTravail);
    expect((await corriger(journal, FAUTE_ON, jourDuChoix + 1000)).intervention).toBeNull();
    expect((await corriger(journal, FAUTE_ON, jourDuChoix + DAY)).intervention?.type).toBe("choix");
  });

  it("rattache la réponse à un choix précis, une seule fois", async () => {
    const journal = await ouvrirJournal(":memory:");
    expect(await journal.answerChoice(1, true, jour(0))).toBe("unknown");
    const dernier = await rendreTravaillee(journal);
    const [evenement] = await journal.ruleEvents({ limit: 1 });
    expect(evenement).toMatchObject({ ruleKey: ON, type: "choix" });

    // L'identifiant d'un autre événement (ici une astuce) n'est pas un choix.
    const astuce = (await journal.ruleEvents({ limit: 1000 })).find((e) => e.type === "astuce");
    expect(await journal.answerChoice(astuce?.id ?? 0, true, dernier + 400)).toBe("unknown");

    expect(await journal.answerChoice(evenement.id, false, dernier + 500)).toBe("recorded");
    expect(await journal.answerChoice(evenement.id, true, dernier + 600)).toBe("conflict");
    expect(await regle(journal)).toMatchObject({
      choicesShown: 1,
      choicesCorrect: 0,
      choicesWrong: 1,
    });
    expect((await journal.ruleEvents({ limit: 1 }))[0]).toMatchObject({
      ruleKey: ON,
      type: "reponse_fausse",
      at: dernier + 500,
    });
  });

  it("refuse la réponse à un choix remplacé par un plus récent", async () => {
    const journal = await ouvrirJournal(":memory:");
    const dernier = await rendreTravaillee(journal);
    const ancien = (await journal.ruleEvents({ limit: 1 }))[0].id;
    const suivant = (await corriger(journal, FAUTE_ON, dernier + DAY)).intervention;
    if (suivant?.type !== "choix") throw new Error("choix attendu");
    expect(suivant.choiceId).not.toBe(ancien);

    expect(await journal.answerChoice(ancien, true, dernier + DAY + 100)).toBe("conflict");
    expect(await journal.answerChoice(suivant.choiceId, true, dernier + DAY + 200)).toBe(
      "recorded",
    );
    expect(await regle(journal)).toMatchObject({
      choicesShown: 2,
      choicesCorrect: 1,
      choicesWrong: 0,
    });
  });

  it("garde le texte et ses fautes quand le suivi des règles échoue", async () => {
    const journal = await ouvrirJournal(":memory:");
    const dernier = await rendreTravaillee(journal);
    const avant = {
      regle: await regle(journal),
      historique: await journal.ruleEvents({ limit: 1000 }),
      periode: await journal.period(365, dernier + DAY),
    };
    const erreurs: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => void erreurs.push(args);
    let suivi: Awaited<ReturnType<Journal["record"]>>;
    try {
      // Le tirage de l'ordre des formes échoue, après la mise à jour de l'état.
      suivi = await corriger(journal, FAUTE_ON, dernier + DAY, () => {
        throw new Error("panne du suivi");
      });
    } finally {
      console.error = consoleError;
    }

    expect(suivi).toEqual({ intervention: null, reussites: [] });
    expect(erreurs).toHaveLength(1);
    // Le texte et sa faute sont journalisés…
    const apres = await journal.period(365, dernier + DAY);
    expect(apres.texts).toBe(avant.periode.texts + 1);
    expect(apres.faults).toBe(avant.periode.faults + 1);
    // … et le suivi est annulé en entier, sans état à moitié écrit.
    expect(await regle(journal)).toEqual(avant.regle);
    expect(await journal.ruleEvents({ limit: 1000 })).toEqual(avant.historique);
    // Le texte suivant est suivi normalement.
    expect((await corriger(journal, FAUTE_ON, dernier + 2 * DAY)).intervention?.type).toBe("choix");
  });

  it("plafonne à trois règles travaillées en même temps", async () => {
    const journal = await ouvrirJournal(":memory:");
    const textes = [
      ["Ils on vu.", "Ils ont vu."],
      ["Il va a Paris.", "Il va à Paris."],
      ["Il et parti.", "Il est parti."],
      ["Ils son partis.", "Ils sont partis."],
    ];
    expect(textes).toHaveLength(SEUILS.travailleesMax + 1);
    // Chaque jour, les quatre règles fautent dans quatre textes distincts.
    for (const t of textes) {
      await corriger(journal, t, jour(0));
      await corriger(journal, t, jour(0) + 1000);
    }
    for (let i = 0; i <= SEUILS.astucesAvantTravail; i++) {
      for (const [n, t] of textes.entries()) await corriger(journal, t, jour(i) + 2000 + n);
    }
    const etats = (await journal.rules()).map((r) => r.state);
    expect(etats.filter((s) => s === "travaillee")).toHaveLength(SEUILS.travailleesMax);
    expect(etats.filter((s) => s === "signalee")).toHaveLength(1);

    // La quatrième règle continue de recevoir des astuces.
    const quatrieme = await corriger(journal, textes[3], jour(10));
    expect(quatrieme.intervention).toMatchObject({ type: "astuce", ruleKey: "PAIRE:son/sont" });
  });

  it("déclare la règle acquise après 14 jours d'usage sans faute, puis gère la rechute", async () => {
    const journal = await ouvrirJournal(":memory:");
    const dernier = await rendreTravaillee(journal);

    // Usage réel, mais 14 jours pas encore écoulés.
    for (let i = 1; i <= 5; i++) {
      expect((await corriger(journal, SANS_FAUTE, dernier + i * DAY)).reussites).toEqual([]);
    }
    expect((await corriger(journal, SANS_FAUTE, dernier + 13 * DAY)).reussites).toEqual([]);

    const acquis = dernier + SEUILS.acquisitionJoursSansFaute * DAY;
    expect(await corriger(journal, SANS_FAUTE, acquis)).toEqual({
      intervention: null,
      reussites: [{ ruleKey: ON, titre: "on / ont" }],
    });
    expect(await regle(journal)).toMatchObject({
      state: "acquise",
      acquiredAt: acquis,
      relapses: 0,
    });
    // Le message de réussite n'est donné qu'une fois.
    expect((await corriger(journal, SANS_FAUTE, acquis + DAY)).reussites).toEqual([]);

    const rechute = await corriger(journal, FAUTE_ON, acquis + 2 * DAY);
    expect(rechute.intervention).toMatchObject({ type: "astuce", ruleKey: ON });
    expect(await regle(journal)).toMatchObject({
      state: "signalee",
      relapses: 1,
      acquiredAt: null,
      tipsShown: 1,
    });

    const types = (await journal.ruleEvents({ ruleKey: ON, limit: 1000 }))
      .map((e) => e.type)
      .reverse();
    expect(types.filter((t) => !["astuce", "choix"].includes(t))).toEqual([
      "observee",
      "signalee",
      "travaillee",
      "acquise",
      "rechute",
    ]);
    expect((await journal.ruleEvents({ ruleKey: ON, limit: 2 }))[1]).toEqual({
      id: expect.any(Number),
      ruleKey: ON,
      at: acquis + 2 * DAY,
      type: "rechute",
      from: "acquise",
      to: "signalee",
    });
  });

  it("ne déclare pas la règle acquise si l'application n'a pas été utilisée", async () => {
    const journal = await ouvrirJournal(":memory:");
    const dernier = await rendreTravaillee(journal);
    expect((await corriger(journal, SANS_FAUTE, dernier + 60 * DAY)).reussites).toEqual([]);
    expect((await regle(journal))?.state).toBe("travaillee");
  });

  it("laisse hors du cycle les modifications non classées et la ponctuation", async () => {
    const journal = await ouvrirJournal(":memory:");
    for (let i = 0; i < 4; i++) {
      // « dossier → classeur » : ni fiche, ni détection, ni accord.
      await corriger(journal, ["Voici le dossier , merci.", "Voici le classeur, merci."], jour(i));
    }
    expect(await journal.rules()).toEqual([]);
    expect(await journal.ruleEvents()).toEqual([]);
  });

  it("laisse hors du cycle les détections qui n'entrent pas dans la note", async () => {
    const journal = await ouvrirJournal(":memory:");
    const original = "Voici le dossier.";
    const match = {
      message: "Style",
      shortMessage: "Style",
      offset: 9,
      length: 7,
      replacements: [],
      rule: { id: "STYLE_X", issueType: "style", category: { id: "STYLE", name: "Style" } },
    };
    for (let i = 0; i < 4; i++) {
      await journal.record(analyze(original, "Voici le classeur.", [match]), jour(i), { original });
    }
    expect(await journal.rules()).toEqual([]);
  });

  it("laisse hors du cycle la détection générique des fautes de frappe", async () => {
    const journal = await ouvrirJournal(":memory:");
    const original = "Le devellopement avance.";
    const match = {
      message: "Faute de frappe possible trouvée.",
      shortMessage: "Faute de frappe",
      offset: 3,
      length: 13,
      replacements: [],
      rule: {
        id: "FR_SPELLING_RULE",
        issueType: "misspelling",
        category: { id: "TYPOS", name: "Faute de frappe possible" },
      },
    };
    for (let i = 0; i < 4; i++) {
      const analysis = analyze(original, "Le développement avance.", [match]);
      expect(analysis.faultCount).toBe(1);
      expect((await journal.record(analysis, jour(i), { original })).intervention).toBeNull();
    }
    expect(await journal.rules()).toEqual([]);
    // La faute reste journalisée et comptée dans la note.
    expect((await journal.summary(30, jour(4))).rules[0]).toMatchObject({
      ruleKey: "FR_SPELLING_RULE",
      count: 4,
    });
  });

  it("ne conserve jamais le texte entier dans les tables du cycle", async () => {
    await avecBase(async (path) => {
      const journal = await ouvrirJournal(path);
      await rendreTravaillee(journal);
      await journal.close();
      const db = new Database(path);
      const lignes = JSON.stringify([
        db.query("SELECT * FROM rule_states").all(),
        db.query("SELECT * FROM rule_events").all(),
      ]);
      db.close();
      expect(lignes).not.toContain("gâteaux");
      expect(lignes).toContain(ON);
    });
  });

  it("« Effacer le journal » remet aussi à zéro l'état des règles", async () => {
    const journal = await ouvrirJournal(":memory:");
    await rendreTravaillee(journal);
    expect(await journal.rules()).not.toEqual([]);
    expect(await journal.ruleEvents()).not.toEqual([]);

    await journal.purge();
    expect(await journal.rules()).toEqual([]);
    expect(await journal.ruleEvents()).toEqual([]);
    expect((await journal.period(365, jour(10))).texts).toBe(0);
    // Le cycle repart de zéro.
    expect((await corriger(journal, FAUTE_ON, jour(10))).intervention).toBeNull();
    expect(await regle(journal)).toMatchObject({ state: "observee", occurrences: 1 });
  });
});

describe("Journal — migration du schéma", () => {
  /** Base telle que la créait la v0.2.0 : tables texts et faults seulement. */
  function baseV020(path: string, textesSansFaute = 0): void {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE texts (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        fault_count INTEGER NOT NULL,
        unclassified_count INTEGER NOT NULL,
        score REAL
      );
      CREATE TABLE faults (
        id INTEGER PRIMARY KEY,
        text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        rule_key TEXT NOT NULL,
        source TEXT NOT NULL,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        issue_type TEXT NOT NULL,
        message TEXT NOT NULL,
        word TEXT NOT NULL,
        replacement TEXT NOT NULL,
        sentence TEXT NOT NULL,
        counted INTEGER NOT NULL
      );
      CREATE INDEX idx_texts_created ON texts(created_at);
      CREATE INDEX idx_faults_rule ON faults(rule_key, created_at);
      CREATE INDEX idx_faults_word ON faults(word, created_at);
    `);
    const texte = db.prepare(
      "INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score) VALUES (?, 10, ?, 0, 18)",
    );
    const faute = db.prepare(
      `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
         issue_type, message, word, replacement, sentence, counted)
       VALUES (?, ?, ?, 'fiche', 'CONFUSION', 'Confusion de mots', 'grammar', ?, 'x', 'y', 'Phrase.', ?)`,
    );
    const ajouter = (at: number, fautes: [string, string, number][]) => {
      const { lastInsertRowid } = texte.run(at, fautes.length);
      for (const [key, message, counted] of fautes)
        faute.run(lastInsertRowid, at, key, message, counted);
    };
    // « on / ont » : trois fautes en trois jours ; « a / à » : une seule ;
    // « STYLE » : trois détections hors note.
    ajouter(jour(0), [
      [ON, "on / ont", 1],
      ["PAIRE:a/à", "a / à", 1],
    ]);
    ajouter(jour(1), [
      [ON, "on / ont", 1],
      ["STYLE", "Style", 0],
    ]);
    ajouter(jour(2), [
      [ON, "on / ont", 1],
      ["STYLE", "Style", 0],
      ["STYLE", "Style", 0],
    ]);
    // Usage sans faute : un texte par jour à partir du jour 3.
    for (let i = 0; i < textesSansFaute; i++) ajouter(jour(3 + i), []);
    db.close();
  }

  const contenu = (path: string) => {
    const db = new Database(path, { readonly: true });
    const lignes = {
      texts: db.query("SELECT * FROM texts ORDER BY id").all(),
      faults: db.query("SELECT * FROM faults ORDER BY id").all(),
      version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    };
    db.close();
    return lignes;
  };

  it("ouvre une base v0.2.0 sans perdre de données et reconstruit l'état des règles", async () => {
    await avecBase(async (path) => {
      baseV020(path);
      const avant = contenu(path);
      expect(avant.version).toBe(0);

      const journal = await ouvrirJournal(path);
      expect(await journal.period(365, jour(3))).toMatchObject({ texts: 3, words: 30 });
      const regles = await journal.rules();
      expect(regles.map((r) => [r.ruleKey, r.state, r.occurrences])).toEqual([
        [ON, "signalee", 3],
        ["PAIRE:a/à", "observee", 1],
      ]);
      expect(regles[0]).toMatchObject({
        firstFaultAt: jour(0),
        lastFaultAt: jour(2),
        stateSince: jour(2),
        tipsShown: 0,
        lastSolicitedAt: null,
      });
      // L'historique reconstruit porte les dates d'origine.
      expect((await journal.ruleEvents({ ruleKey: ON })).map((e) => [e.type, e.at])).toEqual([
        ["signalee", jour(2)],
        ["observee", jour(0)],
      ]);
      await journal.close();

      const apres = contenu(path);
      expect(apres.texts).toEqual(avant.texts);
      // Les fautes restent, sans leurs colonnes de texte (version 3).
      const sansTexte = (avant.faults as Record<string, unknown>[]).map(
        ({ message: _m, word: _w, replacement: _r, sentence: _s, ...faute }) => faute,
      );
      expect(apres.faults).toEqual(sansTexte);
      expect(apres.version).toBe(SCHEMA_VERSION);
    });
  });

  it("retrouve à la migration les règles déjà acquises, à leur date d'origine", async () => {
    await avecBase(async (path) => {
      // Trois fautes de J0 à J2, puis 17 textes sans faute de J3 à J19.
      baseV020(path, 17);
      const journal = await ouvrirJournal(path);
      // Acquise au premier texte corrigé 14 jours après la dernière faute (J2).
      expect(await regle(journal)).toMatchObject({
        state: "acquise",
        acquiredAt: jour(16),
        stateSince: jour(16),
        occurrences: 3,
        relapses: 0,
      });
      expect((await journal.ruleEvents({ ruleKey: ON })).map((e) => [e.type, e.at])).toEqual([
        ["acquise", jour(16)],
        ["signalee", jour(2)],
        ["observee", jour(0)],
      ]);
      // Pas de « Règle acquise » en rafale au premier texte après la mise à jour.
      expect(await corriger(journal, SANS_FAUTE, jour(20))).toEqual({
        intervention: null,
        reussites: [],
      });
      // Une faute ensuite est bien une rechute.
      await corriger(journal, FAUTE_ON, jour(21));
      expect(await regle(journal)).toMatchObject({ state: "signalee", relapses: 1 });
      await journal.close();
    });
  });

  it("ne déclare pas acquise à la migration une règle sans usage suffisant", async () => {
    await avecBase(async (path) => {
      // Deux textes sans faute seulement : en dessous des minimums d'usage.
      baseV020(path, 2);
      const journal = await ouvrirJournal(path);
      expect((await regle(journal))?.state).toBe("signalee");
      await journal.close();
    });
  });

  it("est idempotente : rouvrir la base ne rejoue rien", async () => {
    await avecBase(async (path) => {
      baseV020(path);
      const premier = await ouvrirJournal(path);
      await corriger(premier, FAUTE_ON, jour(3));
      const regles = await premier.rules();
      const historique = await premier.ruleEvents({ limit: 1000 });
      await premier.close();

      const second = await ouvrirJournal(path);
      expect(await second.rules()).toEqual(regles);
      expect(await second.ruleEvents({ limit: 1000 })).toEqual(historique);
      await second.close();
      const troisieme = await ouvrirJournal(path);
      expect(await troisieme.rules()).toEqual(regles);
      await troisieme.close();
    });
  });

  it("reprend le cycle là où l'historique le laisse", async () => {
    await avecBase(async (path) => {
      baseV020(path);
      const journal = await ouvrirJournal(path);
      // Règle déjà signalée par l'historique : la faute suivante affiche une astuce.
      expect((await corriger(journal, FAUTE_ON, jour(3))).intervention).toMatchObject({
        type: "astuce",
        ruleKey: ON,
      });
      await journal.close();
    });
  });

  it("fonctionne sur une base alpha dont les tables des règles et des badges ont user_id", async () => {
    await avecBase(async (path) => {
      baseV020(path);
      // Schéma distribué avec une alpha de la v0.3.0, avant le retrait de user_id.
      const db = new Database(path);
      db.exec(`
        CREATE TABLE rule_states (
          user_id TEXT NOT NULL DEFAULT 'local',
          rule_key TEXT NOT NULL,
          state TEXT NOT NULL,
          state_since INTEGER NOT NULL,
          occurrences INTEGER NOT NULL,
          first_fault_at INTEGER NOT NULL,
          last_fault_at INTEGER NOT NULL,
          tips_shown INTEGER NOT NULL DEFAULT 0,
          choices_shown INTEGER NOT NULL DEFAULT 0,
          choices_correct INTEGER NOT NULL DEFAULT 0,
          choices_wrong INTEGER NOT NULL DEFAULT 0,
          last_solicited_at INTEGER,
          solicitations_that_day INTEGER NOT NULL DEFAULT 0,
          acquired_at INTEGER,
          relapses INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, rule_key)
        );
        CREATE TABLE rule_events (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL DEFAULT 'local',
          rule_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          type TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT
        );
        CREATE TABLE badges (
          user_id TEXT NOT NULL DEFAULT 'local',
          badge_id TEXT NOT NULL,
          obtained_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, badge_id)
        );
      `);
      db.close();

      const journal = await ouvrirJournal(path);
      expect((await journal.rules()).map((r) => [r.ruleKey, r.state, r.occurrences])).toEqual([
        [ON, "signalee", 3],
        ["PAIRE:a/à", "observee", 1],
      ]);
      expect((await journal.badges.obtained()).get("premier-texte")).toBe(jour(0));
      // Une astuce, puis le choix à deux formes dès la faute suivante (issue #61).
      expect((await corriger(journal, FAUTE_ON, jour(3))).intervention?.type).toBe("astuce");
      for (const n of [4, 5]) {
        expect((await corriger(journal, FAUTE_ON, jour(n))).intervention?.type).toBe("choix");
      }
      const choix = (await corriger(journal, FAUTE_ON, jour(6))).intervention;
      if (choix?.type !== "choix") throw new Error("choix attendu");
      expect(await journal.answerChoice(choix.choiceId, true, jour(6) + 1000)).toBe("recorded");
      expect(await regle(journal)).toMatchObject({ state: "travaillee", occurrences: 7 });
      // Sept jours d'écriture : le badge s'enregistre dans l'ancienne table.
      expect((await journal.badges.award(jour(6) + 1000)).map((b) => b.id)).toEqual(["jours-5"]);
      expect((await journal.badges.obtained()).get("jours-5")).toBe(jour(4));
      await journal.close();

      const reouvert = await ouvrirJournal(path);
      expect(await regle(reouvert)).toMatchObject({ choicesShown: 3, choicesCorrect: 1 });
      await reouvert.purge();
      expect(await reouvert.rules()).toEqual([]);
      expect((await reouvert.badges.obtained()).size).toBe(0);
      await reouvert.close();
    });
  });

  it("crée une base neuve directement à la version courante", async () => {
    await avecBase(async (path) => {
      await (await ouvrirJournal(path)).close();
      expect(contenu(path).version).toBe(SCHEMA_VERSION);
    });
  });
});

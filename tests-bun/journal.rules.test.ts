import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../journal.ts";
import { SCHEMA_VERSION } from "../journal.rules.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { SEUILS } from "../src/analysis/regles/seuils.ts";

const DAY = 24 * 60 * 60 * 1000;
/** Midi, heure locale : un décalage d'un jour change toujours de jour calendaire. */
const J0 = new Date(2026, 9, 1, 12).getTime();
const jour = (n: number) => J0 + n * DAY;

const ON = "PAIRE:on/ont";
const FAUTE_ON = ["Hier, ils on mangé tous les gâteaux.", "Hier, ils ont mangé tous les gâteaux."];
const SANS_FAUTE = ["Tout va bien aujourd'hui.", "Tout va bien aujourd'hui."];

function corriger(journal: Journal, [original, corrige]: string[], now: number, random = () => 0) {
  return journal.record(analyze(original, corrige, []), now, { original, random });
}

const regle = (journal: Journal, ruleKey = ON) =>
  journal.rules().find((r) => r.ruleKey === ruleKey);

/** Amène « on / ont » à l'état travaillée ; renvoie le jour de la dernière faute. */
function rendreTravaillee(journal: Journal): number {
  corriger(journal, FAUTE_ON, jour(0));
  corriger(journal, FAUTE_ON, jour(0) + 1000);
  // Troisième faute : signalée, première astuce. Puis une astuce par jour.
  for (let i = 0; i < SEUILS.astucesAvantTravail; i++) corriger(journal, FAUTE_ON, jour(i) + 2000);
  const dernier = jour(SEUILS.astucesAvantTravail);
  corriger(journal, FAUTE_ON, dernier);
  return dernier;
}

describe("Journal — cycle de vie des règles", () => {
  it("n'intervient pas avant la troisième faute en sept jours", () => {
    const journal = new Journal(":memory:");
    expect(corriger(journal, FAUTE_ON, jour(0))).toEqual({ intervention: null, reussites: [] });
    expect(regle(journal)).toMatchObject({ state: "observee", occurrences: 1 });
    expect(corriger(journal, FAUTE_ON, jour(1)).intervention).toBeNull();

    const troisieme = corriger(journal, FAUTE_ON, jour(2));
    expect(troisieme.intervention).toMatchObject({
      type: "astuce",
      ruleKey: ON,
      titre: "on / ont",
    });
    expect(regle(journal)).toMatchObject({
      state: "signalee",
      occurrences: 3,
      tipsShown: 1,
      firstFaultAt: jour(0),
      lastFaultAt: jour(2),
      label: "on / ont",
      categoryName: "Confusion de mots",
    });
    expect(regle(journal)?.fiche?.astuce).toContain("avaient");
  });

  it("ne signale pas trois fautes étalées sur plus de sept jours", () => {
    const journal = new Journal(":memory:");
    corriger(journal, FAUTE_ON, jour(0));
    corriger(journal, FAUTE_ON, jour(4));
    expect(corriger(journal, FAUTE_ON, jour(8)).intervention).toBeNull();
    expect(regle(journal)?.state).toBe("observee");
  });

  it("n'affiche qu'une astuce par règle et par jour", () => {
    const journal = new Journal(":memory:");
    corriger(journal, FAUTE_ON, jour(0));
    corriger(journal, FAUTE_ON, jour(0) + 1000);
    expect(corriger(journal, FAUTE_ON, jour(0) + 2000).intervention?.type).toBe("astuce");
    expect(corriger(journal, FAUTE_ON, jour(0) + 3000).intervention).toBeNull();
    expect(regle(journal)).toMatchObject({ tipsShown: 1, occurrences: 4 });
    expect(corriger(journal, FAUTE_ON, jour(1)).intervention?.type).toBe("astuce");
  });

  it("propose les deux formes quand la faute persiste après les astuces", () => {
    const journal = new Journal(":memory:");
    corriger(journal, FAUTE_ON, jour(0));
    corriger(journal, FAUTE_ON, jour(0) + 1000);
    for (let i = 0; i < SEUILS.astucesAvantTravail; i++) {
      expect(corriger(journal, FAUTE_ON, jour(i) + 2000).intervention?.type).toBe("astuce");
    }
    expect(regle(journal)).toMatchObject({ state: "signalee", tipsShown: 3 });

    const choix = corriger(journal, FAUTE_ON, jour(3), () => 0.9);
    expect(choix.intervention).toEqual({
      type: "choix",
      ruleKey: ON,
      titre: "on / ont",
      explication: expect.stringContaining("avaient"),
      avant: "Hier, ils ",
      apres: " mangé tous les gâteaux.",
      formes: [
        { texte: "on", correcte: false },
        { texte: "ont", correcte: true },
      ],
    });
    expect(regle(journal)).toMatchObject({ state: "travaillee", choicesShown: 1 });

    // Une seule sollicitation par jour : bouton Copier normal ensuite.
    expect(corriger(journal, FAUTE_ON, jour(3) + 1000).intervention).toBeNull();
    expect(corriger(journal, FAUTE_ON, jour(4)).intervention?.type).toBe("choix");
  });

  it("enregistre la réponse au choix, une seule fois par choix proposé", () => {
    const journal = new Journal(":memory:");
    expect(journal.answerChoice(ON, true, jour(0))).toBe(false);
    const dernier = rendreTravaillee(journal);

    expect(journal.answerChoice(ON, false, dernier + 500)).toBe(true);
    expect(journal.answerChoice(ON, true, dernier + 600)).toBe(false);
    expect(regle(journal)).toMatchObject({ choicesShown: 1, choicesCorrect: 0, choicesWrong: 1 });
    expect(journal.ruleEvents({ limit: 1 })[0]).toMatchObject({
      ruleKey: ON,
      type: "reponse_fausse",
      at: dernier + 500,
    });
  });

  it("plafonne à trois règles travaillées en même temps", () => {
    const journal = new Journal(":memory:");
    const textes = [
      ["Ils on vu.", "Ils ont vu."],
      ["Il va a Paris.", "Il va à Paris."],
      ["Il et parti.", "Il est parti."],
      ["Ils son partis.", "Ils sont partis."],
    ];
    expect(textes).toHaveLength(SEUILS.travailleesMax + 1);
    // Chaque jour, les quatre règles fautent dans quatre textes distincts.
    for (const t of textes) {
      corriger(journal, t, jour(0));
      corriger(journal, t, jour(0) + 1000);
    }
    for (let i = 0; i <= SEUILS.astucesAvantTravail; i++) {
      for (const [n, t] of textes.entries()) corriger(journal, t, jour(i) + 2000 + n);
    }
    const etats = journal.rules().map((r) => r.state);
    expect(etats.filter((s) => s === "travaillee")).toHaveLength(SEUILS.travailleesMax);
    expect(etats.filter((s) => s === "signalee")).toHaveLength(1);

    // La quatrième règle continue de recevoir des astuces.
    const quatrieme = corriger(journal, textes[3], jour(10));
    expect(quatrieme.intervention).toMatchObject({ type: "astuce", ruleKey: "PAIRE:son/sont" });
  });

  it("déclare la règle acquise après 14 jours d'usage sans faute, puis gère la rechute", () => {
    const journal = new Journal(":memory:");
    const dernier = rendreTravaillee(journal);

    // Usage réel, mais 14 jours pas encore écoulés.
    for (let i = 1; i <= 5; i++) {
      expect(corriger(journal, SANS_FAUTE, dernier + i * DAY).reussites).toEqual([]);
    }
    expect(corriger(journal, SANS_FAUTE, dernier + 13 * DAY).reussites).toEqual([]);

    const acquis = dernier + SEUILS.acquisitionJoursSansFaute * DAY;
    expect(corriger(journal, SANS_FAUTE, acquis)).toEqual({
      intervention: null,
      reussites: [{ ruleKey: ON, titre: "on / ont" }],
    });
    expect(regle(journal)).toMatchObject({ state: "acquise", acquiredAt: acquis, relapses: 0 });
    // Le message de réussite n'est donné qu'une fois.
    expect(corriger(journal, SANS_FAUTE, acquis + DAY).reussites).toEqual([]);

    const rechute = corriger(journal, FAUTE_ON, acquis + 2 * DAY);
    expect(rechute.intervention).toMatchObject({ type: "astuce", ruleKey: ON });
    expect(regle(journal)).toMatchObject({
      state: "signalee",
      relapses: 1,
      acquiredAt: null,
      tipsShown: 1,
    });

    const types = journal
      .ruleEvents({ ruleKey: ON, limit: 1000 })
      .map((e) => e.type)
      .reverse();
    expect(types.filter((t) => !["astuce", "choix"].includes(t))).toEqual([
      "observee",
      "signalee",
      "travaillee",
      "acquise",
      "rechute",
    ]);
    expect(journal.ruleEvents({ ruleKey: ON, limit: 2 })[1]).toEqual({
      id: expect.any(Number),
      ruleKey: ON,
      at: acquis + 2 * DAY,
      type: "rechute",
      from: "acquise",
      to: "signalee",
    });
  });

  it("ne déclare pas la règle acquise si l'application n'a pas été utilisée", () => {
    const journal = new Journal(":memory:");
    const dernier = rendreTravaillee(journal);
    expect(corriger(journal, SANS_FAUTE, dernier + 60 * DAY).reussites).toEqual([]);
    expect(regle(journal)?.state).toBe("travaillee");
  });

  it("laisse hors du cycle les modifications non classées et la ponctuation", () => {
    const journal = new Journal(":memory:");
    for (let i = 0; i < 4; i++) {
      // « dossier → classeur » : ni fiche, ni détection, ni accord.
      corriger(journal, ["Voici le dossier , merci.", "Voici le classeur, merci."], jour(i));
    }
    expect(journal.rules()).toEqual([]);
    expect(journal.ruleEvents()).toEqual([]);
  });

  it("laisse hors du cycle les détections qui n'entrent pas dans la note", () => {
    const journal = new Journal(":memory:");
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
      journal.record(analyze(original, "Voici le classeur.", [match]), jour(i), { original });
    }
    expect(journal.rules()).toEqual([]);
  });

  it("laisse hors du cycle la détection générique des fautes de frappe", () => {
    const journal = new Journal(":memory:");
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
      expect(journal.record(analysis, jour(i), { original }).intervention).toBeNull();
    }
    expect(journal.rules()).toEqual([]);
    // La faute reste journalisée et comptée dans la note.
    expect(journal.summary(30, jour(4)).rules[0]).toMatchObject({
      ruleKey: "FR_SPELLING_RULE",
      count: 4,
    });
  });

  it("ne conserve jamais le texte entier dans les tables du cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "grammaria-rules-"));
    try {
      const path = join(dir, "journal.db");
      const journal = new Journal(path);
      rendreTravaillee(journal);
      journal.close();
      const db = new Database(path);
      const lignes = JSON.stringify([
        db.query("SELECT * FROM rule_states").all(),
        db.query("SELECT * FROM rule_events").all(),
      ]);
      db.close();
      expect(lignes).not.toContain("gâteaux");
      expect(lignes).toContain(ON);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("« Effacer le journal » remet aussi à zéro l'état des règles", () => {
    const journal = new Journal(":memory:");
    rendreTravaillee(journal);
    expect(journal.rules()).not.toEqual([]);
    expect(journal.ruleEvents()).not.toEqual([]);

    journal.purge();
    expect(journal.rules()).toEqual([]);
    expect(journal.ruleEvents()).toEqual([]);
    expect(journal.period(365, jour(10)).texts).toBe(0);
    // Le cycle repart de zéro.
    expect(corriger(journal, FAUTE_ON, jour(10)).intervention).toBeNull();
    expect(regle(journal)).toMatchObject({ state: "observee", occurrences: 1 });
  });
});

describe("Journal — migration du schéma", () => {
  /** Base telle que la créait la v0.2.0 : tables texts et faults seulement. */
  function baseV020(path: string): void {
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
    db.close();
  }

  function avecBase(test: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "grammaria-migration-"));
    try {
      test(join(dir, "journal.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("ouvre une base v0.2.0 sans perdre de données et reconstruit l'état des règles", () => {
    avecBase((path) => {
      baseV020(path);
      const avant = contenu(path);
      expect(avant.version).toBe(0);

      const journal = new Journal(path);
      expect(journal.period(365, jour(3))).toMatchObject({ texts: 3, words: 30 });
      const regles = journal.rules();
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
      expect(journal.ruleEvents({ ruleKey: ON }).map((e) => [e.type, e.at])).toEqual([
        ["signalee", jour(2)],
        ["observee", jour(0)],
      ]);
      journal.close();

      const apres = contenu(path);
      expect(apres.texts).toEqual(avant.texts);
      expect(apres.faults).toEqual(avant.faults);
      expect(apres.version).toBe(SCHEMA_VERSION);
    });
  });

  it("est idempotente : rouvrir la base ne rejoue rien", () => {
    avecBase((path) => {
      baseV020(path);
      const premier = new Journal(path);
      corriger(premier, FAUTE_ON, jour(3));
      const regles = premier.rules();
      const historique = premier.ruleEvents({ limit: 1000 });
      premier.close();

      const second = new Journal(path);
      expect(second.rules()).toEqual(regles);
      expect(second.ruleEvents({ limit: 1000 })).toEqual(historique);
      second.close();
      const troisieme = new Journal(path);
      expect(troisieme.rules()).toEqual(regles);
      troisieme.close();
    });
  });

  it("reprend le cycle là où l'historique le laisse", () => {
    avecBase((path) => {
      baseV020(path);
      const journal = new Journal(path);
      // Règle déjà signalée par l'historique : la faute suivante affiche une astuce.
      expect(corriger(journal, FAUTE_ON, jour(3)).intervention).toMatchObject({
        type: "astuce",
        ruleKey: ON,
      });
      journal.close();
    });
  });

  it("crée une base neuve directement à la version courante", () => {
    avecBase((path) => {
      new Journal(path).close();
      expect(contenu(path).version).toBe(SCHEMA_VERSION);
    });
  });
});

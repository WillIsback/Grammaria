import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { creerGestionnaire } from "../api/handler.ts";
import { GrammarChecker } from "../grammar.ts";
import { Journal, SCHEMA_VERSION } from "../journal.ts";
import { ouvrirPiloteBun } from "../journal.driver.bun.ts";
import { analyze, regleDuMoteur } from "../src/analysis/analyze.ts";
import { SEUILS } from "../src/analysis/regles/seuils.ts";
import type { LTMatch } from "../src/types.ts";
import reference from "../tests/fixtures/correcteur/reference.json";
import { avecBase, DAY, jour } from "./helpers.ts";

/**
 * Garde de l'issue #32 : aucun texte utilisé pendant une correction ne doit
 * s'enregistrer. Les textes corrigés contiennent des mots-sentinelles
 * improbables ; on les cherche ensuite dans les OCTETS du fichier de la base
 * (et de ses fichiers annexes), en UTF-8 et en UTF-16, et dans les réponses
 * de toutes les routes de consultation. Ces tests doivent échouer dès qu'un
 * texte de l'utilisateur est de nouveau écrit quelque part.
 */

/** Mots improbables, un par place possible d'un texte de l'utilisateur. */
const DANS_LA_PHRASE = "Kwaxolotl"; // nom propre, dans la phrase fautive
const MOT_FAUTIF = "zorglubienne"; // forme fautive (faute de frappe du moteur)
const CORRECTION = "brabanthropie"; // ce que le correcteur a écrit à la place
const DANS_LE_CHOIX = "Ŋyrtéphaïde"; // phrase d'une astuce et d'un choix à deux formes
const DANS_LE_MESSAGE = "quixotérismal"; // cité par le message d'une règle
const SENTINELLES = [DANS_LA_PHRASE, MOT_FAUTIF, CORRECTION, DANS_LE_CHOIX, DANS_LE_MESSAGE];

/** Formes cherchées : telle quelle, en minuscules, en majuscules (identifiants). */
const formes = (mots: readonly string[]) =>
  [...new Set(mots.flatMap((m) => [m, m.toLowerCase(), m.toUpperCase()]))].filter(Boolean);

const utf16 = (texte: string, grandBoutiste: boolean) => {
  const octets = Buffer.alloc(texte.length * 2);
  for (let i = 0; i < texte.length; i++) {
    const code = texte.charCodeAt(i);
    if (grandBoutiste) octets.writeUInt16BE(code, i * 2);
    else octets.writeUInt16LE(code, i * 2);
  }
  return octets;
};

/** Fichiers de la base sur le disque : la base, son WAL, sa mémoire partagée, son journal. */
function fichiersDeLaBase(path: string): string[] {
  return ["", "-wal", "-shm", "-journal"].map((s) => path + s).filter((f) => existsSync(f));
}

/** Mots de `mots` (sous l'une de leurs `formes`) présents dans les octets des fichiers de la base. */
function motsDansLesOctets(path: string, mots: readonly string[]): string[] {
  const contenus = fichiersDeLaBase(path).map((f) => readFileSync(f));
  return formes(mots).filter((mot) =>
    [Buffer.from(mot, "utf8"), utf16(mot, false), utf16(mot, true)].some((aiguille) =>
      contenus.some((octets) => octets.includes(aiguille)),
    ),
  );
}

const motsDans = (texte: string, mots: readonly string[]) =>
  formes(mots).filter((mot) => texte.includes(mot));

describe("Journal — aucun texte de l'utilisateur enregistré (#32)", () => {
  const correcteur = new GrammarChecker();
  afterAll(() => correcteur.close());

  it("ni dans le fichier de la base, ni dans les réponses des routes", async () => {
    await avecBase(async (path) => {
      const journal = await Journal.ouvrir(ouvrirPiloteBun(path));
      let maintenant = jour(0);
      const gestionnaire = creerGestionnaire({
        journal,
        correcteur,
        reglages: {
          vuePublique: () => ({}) as never,
          mettreAJour: () => ({}) as never,
        },
        motsValides: { lire: () => [], ajouter: () => [] },
        modele: {
          listerModeles: async () => ({ data: [] }),
          ouvrirFlux: async () => {
            throw new Error("pas de modèle dans ce test");
          },
        },
        options: { bureau: false, originesCors: [], llmTopK: -1, horloge: () => maintenant },
      });
      const appel = async (chemin: string, corps?: unknown) => {
        const reponse = await gestionnaire(
          new Request(`http://127.0.0.1${chemin}`, {
            method: corps === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json" },
            body: corps === undefined ? undefined : JSON.stringify(corps),
          }),
        );
        expect(reponse?.status).toBe(200);
        return reponse!.text();
      };
      /** Corrige un texte comme l'interface : détections du vrai moteur, puis analyse. */
      const corriger = async (original: string, corrected: string, ajout: LTMatch[] = []) => {
        const { matches } = JSON.parse(await appel("/api/check", { text: original })) as {
          matches: LTMatch[];
        };
        return appel("/api/analyze", { original, corrected, matches: [...matches, ...ajout] });
      };

      const reponses: string[] = [];
      // 1. Faute de frappe du moteur : mot fautif, correction et nom propre dans la phrase.
      const frappe = await corriger(
        `Hier, ${MOT_FAUTIF} a vu ${DANS_LA_PHRASE} dans le jardin.`,
        `Hier, ${CORRECTION} a vu ${DANS_LA_PHRASE} dans le jardin.`,
      );
      // Le test n'est pas vide : la faute est bien reconnue et passe par l'analyse.
      expect(frappe).toContain("FR_SPELLING_RULE");
      expect(frappe).toContain(MOT_FAUTIF);
      reponses.push(frappe);

      // 2. Règle dont le message cite un mot du texte (détection transmise par l'interface).
      const original = `Le ${DANS_LE_MESSAGE} est prêt.`;
      const cite = await corriger(original, "Le dossier est prêt.", [
        {
          message: `Le mot « ${DANS_LE_MESSAGE} » est inconnu.`,
          shortMessage: `« ${DANS_LE_MESSAGE} »`,
          offset: original.indexOf(DANS_LE_MESSAGE),
          length: DANS_LE_MESSAGE.length,
          replacements: [{ value: "dossier" }],
          rule: {
            id: "REGLE_QUI_CITE",
            description: "Mot inconnu",
            issueType: "grammar",
            category: { id: "GRAMMAR", name: "Grammaire" },
          },
        },
      ]);
      // Le message cite le mot, pendant la correction (`shortMessage` d'abord).
      expect(cite).toContain(`"message":"« ${DANS_LE_MESSAGE} »"`);
      reponses.push(cite);

      // 3. Règles du moteur rapportées sous un identifiant par mot (« jai », « boton »…).
      const parMot = await corriger(
        "jai vu un boton pile poil devant la porte.",
        "j'ai vu un bouton pile-poil devant la porte.",
      );
      expect(parMot).toContain("FR_SIMPLE_REPLACE_SIMPLE");
      expect(parMot).not.toContain("FR_SIMPLE_REPLACE_SIMPLE_");
      expect(parMot).not.toContain("FR_COMPOUNDS_");

      // 4. Astuce puis choix à deux formes sur la phrase de l'utilisateur, et réponse.
      const fiche = [
        `Ils on vu ${DANS_LE_CHOIX} hier soir.`,
        `Ils ont vu ${DANS_LE_CHOIX} hier soir.`,
      ];
      const types: (string | null)[] = [];
      let choiceId: number | null = null;
      for (let i = 0; i <= SEUILS.astucesAvantTravail + 1; i++) {
        maintenant = jour(i) + 1000;
        const corps = JSON.parse(await corriger(fiche[0], fiche[1])) as {
          intervention: { type: string; choiceId?: number } | null;
        };
        if (i === 0) {
          maintenant += 1;
          await corriger(fiche[0], fiche[1]);
        }
        types.push(corps.intervention?.type ?? null);
        if (corps.intervention?.type === "choix") choiceId = corps.intervention.choiceId ?? null;
      }
      expect(types).toContain("astuce");
      expect(types).toContain("choix");
      reponses.push(await appel("/api/rules/answer", { choiceId, correct: true }));

      // Toutes les routes de consultation.
      for (const route of [
        "/api/journal?days=365",
        "/api/progress",
        "/api/badges",
        "/api/rules",
        "/api/rules/events?limit=1000",
      ]) {
        reponses.push(await appel(route));
      }
      // Les réponses de l'analyse rendent le texte à l'interface (passages, messages) ;
      // celles des routes de consultation ne lisent que le journal.
      const nbAnalyses = 2;
      expect(motsDans(reponses.slice(0, nbAnalyses).join("\n"), [MOT_FAUTIF])).toEqual([
        MOT_FAUTIF,
      ]);
      const consultations = reponses.slice(nbAnalyses).join("\n");
      expect(motsDans(consultations, SENTINELLES)).toEqual([]);
      expect(
        motsDans(consultations, ["Vérifiez", "Vouliez-vous", "Faute de frappe possible trouvée"]),
      ).toEqual([]);

      // Base ouverte (WAL vivant), puis fermée.
      const interdits = [...SENTINELLES, "boton", "pile poil", "PILE_POIL", "SIMPLE_JAI"];
      expect(fichiersDeLaBase(path).length).toBeGreaterThan(0);
      expect(motsDansLesOctets(path, interdits)).toEqual([]);
      // Et pourtant, l'historique est là.
      const progression = JSON.parse(reponses.at(-4)!) as { totals: { texts: number } };
      expect(progression.totals.texts).toBeGreaterThan(5);
      const regles = JSON.parse(reponses.at(-2)!) as { rules: { ruleKey: string }[] };
      expect(regles.rules.map((r) => r.ruleKey)).toContain("PAIRE:on/ont");
      await journal.close();
      expect(motsDansLesOctets(path, interdits)).toEqual([]);
    });
  }, 30_000);

  it("la recherche dans les octets trouve bien un mot écrit en UTF-8 ou en UTF-16", async () => {
    await avecBase(async (path) => {
      const db = new Database(path);
      db.exec("CREATE TABLE t (x TEXT)");
      db.query("INSERT INTO t VALUES (?)").run(`phrase de ${DANS_LA_PHRASE}`);
      db.close();
      expect(motsDansLesOctets(path, SENTINELLES)).toEqual([DANS_LA_PHRASE]);
      const db16 = new Database(`${path}.16`);
      db16.exec("PRAGMA encoding = 'UTF-16le'");
      db16.exec("CREATE TABLE t (x TEXT)");
      db16.query("INSERT INTO t VALUES (?)").run(DANS_LE_CHOIX);
      db16.close();
      expect(motsDansLesOctets(`${path}.16`, SENTINELLES)).toEqual([DANS_LE_CHOIX]);
    });
  });
});

describe("Libellé des règles : une donnée fixe de la règle, jamais le texte", () => {
  const correcteur = new GrammarChecker();
  afterAll(() => correcteur.close());

  it("même règle sur deux phrases différentes : même libellé, messages différents", async () => {
    const libelles = async (texte: string, id: string) => {
      const m = (await correcteur.check(texte)).find((x) => x.rule.id === id);
      if (!m) throw new Error(`${id} non détectée dans « ${texte} »`);
      return { label: regleDuMoteur(m.rule).label, message: m.message };
    };
    const a = await libelles("Ils mange des pommes.", "ACCORD_R_PERS_VERBE");
    const b = await libelles("Elles chante très fort.", "ACCORD_R_PERS_VERBE");
    // Le message cite les mots du texte ; le libellé, non.
    expect(a.message).not.toBe(b.message);
    expect(a.message).toContain("mange");
    expect(a.label).toBe(b.label);
    expect(a.label).not.toContain("mange");
    expect(b.label).not.toContain("chante");

    const c = await libelles("jai fini.", "FR_SIMPLE_REPLACE_SIMPLE_JAI");
    const d = await libelles("Un boton.", "FR_SIMPLE_REPLACE_SIMPLE_BOTON");
    expect(c.label).toBe("Mot incorrect");
    expect(d.label).toBe("Mot incorrect");
  });

  it("sur tout le corpus de référence : une description par règle, identifiants publics", async () => {
    const parRegle = new Map<string, Set<string>>();
    let detections = 0;
    for (const { texte } of reference.textes) {
      if (!texte.trim()) continue;
      const matches = (await correcteur.check(texte)) as (LTMatch & {
        rule: { subId?: string };
      })[];
      for (const m of matches) {
        detections++;
        const { ruleKey, label } = regleDuMoteur(m.rule);
        // Clé : identifiant de règle en majuscules, sans mot du texte (règles par mot ramenées).
        expect(ruleKey).toMatch(/^[A-Z0-9_]+$/);
        const cle = `${m.rule.id}#${m.rule.subId ?? ""}`;
        parRegle.set(cle, (parRegle.get(cle) ?? new Set()).add(label));
      }
    }
    expect(detections).toBeGreaterThan(50);
    const variables = [...parRegle].filter(([, l]) => l.size > 1);
    expect(variables).toEqual([]);
  }, 30_000);
});

/** Colonnes autorisées, table par table, chacune justifiée : aucune ne contient de texte. */
const COLONNES_AUTORISEES: Record<string, Record<string, string>> = {
  texts: {
    id: "identifiant",
    user_id: "constante 'local'",
    created_at: "date",
    word_count: "compteur",
    fault_count: "compteur",
    unclassified_count: "compteur",
    score: "note",
  },
  faults: {
    id: "identifiant",
    text_id: "identifiant du texte",
    user_id: "constante 'local'",
    created_at: "date",
    rule_key: "identifiant public de la règle",
    source: "fiche, lt ou accord",
    category_id: "identifiant de catégorie du moteur",
    category_name: "nom de catégorie du moteur (fixe)",
    issue_type: "type de faute du moteur (fixe)",
    counted: "booléen",
  },
  rule_labels: {
    rule_key: "identifiant public de la règle",
    label: "description fixe de la règle (titre de fiche, description du moteur)",
  },
  rule_states: {
    rule_key: "identifiant public de la règle",
    state: "état du cycle",
    state_since: "date",
    occurrences: "compteur",
    first_fault_at: "date",
    last_fault_at: "date",
    tips_shown: "compteur",
    choices_shown: "compteur",
    choices_correct: "compteur",
    choices_wrong: "compteur",
    last_solicited_at: "date",
    solicitations_that_day: "compteur",
    acquired_at: "date",
    relapses: "compteur",
  },
  rule_events: {
    id: "identifiant",
    rule_key: "identifiant public de la règle",
    created_at: "date",
    type: "type d'événement",
    from_state: "état du cycle",
    to_state: "état du cycle",
  },
  badges: { badge_id: "identifiant du badge", obtained_at: "date" },
};

describe("Schéma du journal : liste blanche des colonnes", () => {
  it("aucune table ni colonne hors de la liste (une nouvelle colonne doit y être justifiée)", async () => {
    await avecBase(async (path) => {
      const journal = await Journal.ouvrir(ouvrirPiloteBun(path));
      await journal.close();
      const db = new Database(path, { readonly: true });
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      const schema = Object.fromEntries(
        tables.map(({ name }) => [
          name,
          (db.query(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name),
        ]),
      );
      db.close();
      const attendu = Object.fromEntries(
        Object.entries(COLONNES_AUTORISEES).map(([t, c]) => [t, Object.keys(c)]),
      );
      expect(schema).toEqual(attendu);
    });
  });
});

describe("Migration v2 → v3 : les textes sont effacés, l'historique reste", () => {
  /** Journal de la version 2, avec des sentinelles dans chaque colonne de texte. */
  function baseV2(path: string): void {
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE texts (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL, word_count INTEGER NOT NULL, fault_count INTEGER NOT NULL,
        unclassified_count INTEGER NOT NULL, score REAL);
      CREATE TABLE faults (id INTEGER PRIMARY KEY,
        text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL DEFAULT 'local', created_at INTEGER NOT NULL,
        rule_key TEXT NOT NULL, source TEXT NOT NULL, category_id TEXT NOT NULL,
        category_name TEXT NOT NULL, issue_type TEXT NOT NULL, message TEXT NOT NULL,
        word TEXT NOT NULL, replacement TEXT NOT NULL, sentence TEXT NOT NULL,
        counted INTEGER NOT NULL);
      CREATE INDEX idx_texts_created ON texts(created_at);
      CREATE INDEX idx_faults_rule ON faults(rule_key, created_at);
      CREATE INDEX idx_faults_word ON faults(word, created_at);
      CREATE TABLE rule_states (rule_key TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL,
        state_since INTEGER NOT NULL, occurrences INTEGER NOT NULL,
        first_fault_at INTEGER NOT NULL, last_fault_at INTEGER NOT NULL,
        tips_shown INTEGER NOT NULL DEFAULT 0, choices_shown INTEGER NOT NULL DEFAULT 0,
        choices_correct INTEGER NOT NULL DEFAULT 0, choices_wrong INTEGER NOT NULL DEFAULT 0,
        last_solicited_at INTEGER, solicitations_that_day INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER, relapses INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE rule_events (id INTEGER PRIMARY KEY, rule_key TEXT NOT NULL,
        created_at INTEGER NOT NULL, type TEXT NOT NULL, from_state TEXT, to_state TEXT);
      CREATE INDEX idx_rule_events_rule ON rule_events(rule_key, created_at);
      CREATE INDEX idx_rule_events_created ON rule_events(created_at);
      CREATE TABLE badges (badge_id TEXT NOT NULL PRIMARY KEY, obtained_at INTEGER NOT NULL);
    `);
    const texte = db.query(
      "INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score) VALUES (?, 50, ?, 0, 16)",
    );
    const faute = db.query(
      `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
         issue_type, message, word, replacement, sentence, counted)
       VALUES (?, ?, ?, 'lt', 'GRAMMAR', 'Grammaire', 'grammar', ?, ?, ?, ?, 1)`,
    );
    // 120 textes de deux fautes : une règle ordinaire, une règle « par mot ».
    for (let i = 0; i < 120; i++) {
      const at = jour(i % 60) + i;
      const { lastInsertRowid } = texte.run(at, 2);
      for (const ruleKey of [
        "ACCORD_SUJET_VERBE",
        `FR_SIMPLE_REPLACE_SIMPLE_${i % 2 ? "JAI" : "BOTON"}`,
      ]) {
        faute.run(
          lastInsertRowid,
          at,
          ruleKey,
          `Vérifiez l'accord avec « ${DANS_LE_MESSAGE} ».`,
          `${MOT_FAUTIF}${i}`,
          CORRECTION,
          `Hier, ${DANS_LA_PHRASE} et ${DANS_LE_CHOIX} sont venus (${i}).`,
        );
      }
    }
    // Des lignes supprimées : leurs octets restent dans les pages libres.
    db.exec("DELETE FROM texts WHERE id > 100");
    db.exec("DELETE FROM faults WHERE text_id > 100");
    const etat = db.query(
      `INSERT INTO rule_states (rule_key, state, state_since, occurrences, first_fault_at,
         last_fault_at, tips_shown, relapses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    etat.run("ACCORD_SUJET_VERBE", "travaillee", jour(10), 100, jour(0), jour(59), 3, 0);
    etat.run("FR_SIMPLE_REPLACE_SIMPLE_JAI", "signalee", jour(20), 50, jour(1), jour(59), 2, 1);
    etat.run("FR_SIMPLE_REPLACE_SIMPLE_BOTON", "travaillee", jour(5), 50, jour(0), jour(58), 1, 0);
    const evenement = db.query(
      "INSERT INTO rule_events (rule_key, created_at, type) VALUES (?, ?, 'astuce')",
    );
    evenement.run("FR_SIMPLE_REPLACE_SIMPLE_JAI", jour(20));
    evenement.run("ACCORD_SUJET_VERBE", jour(10));
    db.query("INSERT INTO badges VALUES ('premier-texte', ?)").run(jour(0));
    db.exec("PRAGMA user_version = 2");
    db.close();
  }

  const lire = (path: string) => {
    const db = new Database(path, { readonly: true });
    const q = (sql: string) => db.query(sql).all();
    const r = {
      version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
      texts: q("SELECT * FROM texts ORDER BY id"),
      faults: q(
        `SELECT id, text_id, created_at, category_name, counted,
                CASE WHEN rule_key LIKE 'FR\\_SIMPLE\\_REPLACE\\_SIMPLE%' ESCAPE '\\'
                     THEN 'FR_SIMPLE_REPLACE_SIMPLE' ELSE rule_key END AS regle
         FROM faults ORDER BY id`,
      ),
      states: q("SELECT * FROM rule_states ORDER BY rule_key"),
      events: q("SELECT rule_key, created_at, type FROM rule_events ORDER BY id"),
      badges: q("SELECT * FROM badges"),
    };
    db.close();
    return r;
  };

  it("garde textes, fautes, dates et compteurs ; plus aucun texte dans le fichier", async () => {
    await avecBase(async (path) => {
      baseV2(path);
      // Le test n'est pas vide : les sentinelles sont bien dans le fichier avant.
      expect(motsDansLesOctets(path, SENTINELLES).length).toBeGreaterThan(0);
      const avant = lire(path);
      expect(avant.version).toBe(2);
      expect(avant.faults).toHaveLength(200);

      const journal = await Journal.ouvrir(ouvrirPiloteBun(path));
      const progression = await journal.progress(jour(60));
      const resume = await journal.summary(365, jour(60));
      const regles = await journal.rules();
      await journal.close();

      const apres = lire(path);
      expect(apres.version).toBe(SCHEMA_VERSION);
      expect(apres.texts).toEqual(avant.texts);
      expect(apres.faults).toEqual(avant.faults);
      expect(apres.badges).toEqual(avant.badges);
      // Règles « par mot » ramenées à leur règle d'origine, compteurs additionnés.
      expect(apres.events).toEqual([
        { rule_key: "FR_SIMPLE_REPLACE_SIMPLE", created_at: jour(20), type: "astuce" },
        { rule_key: "ACCORD_SUJET_VERBE", created_at: jour(10), type: "astuce" },
      ]);
      expect(apres.states).toEqual([
        avant.states[0],
        {
          ...(avant.states[2] as object),
          rule_key: "FR_SIMPLE_REPLACE_SIMPLE",
          state: "signalee",
          state_since: jour(20),
          occurrences: 100,
          first_fault_at: jour(0),
          last_fault_at: jour(59),
          tips_shown: 3,
          relapses: 1,
        },
      ]);
      expect(regles.map((r) => [r.ruleKey, r.label])).toEqual([
        ["ACCORD_SUJET_VERBE", "Grammaire"],
        ["FR_SIMPLE_REPLACE_SIMPLE", "Grammaire"],
      ]);
      expect(progression.totals).toMatchObject({ texts: 100, words: 5000, faults: 200 });
      expect(resume.rules.map((r) => [r.ruleKey, r.count])).toEqual([
        ["ACCORD_SUJET_VERBE", 100],
        ["FR_SIMPLE_REPLACE_SIMPLE", 100],
      ]);
      const consultations = JSON.stringify([progression, resume, regles]);
      expect(motsDans(consultations, SENTINELLES)).toEqual([]);

      // Les octets : ni dans les lignes, ni dans les pages libres, ni dans le WAL.
      expect(motsDansLesOctets(path, [...SENTINELLES, "BOTON", "SIMPLE_JAI"])).toEqual([]);

      // Rouvrir ne refait rien et ne perd rien.
      const encore = await Journal.ouvrir(ouvrirPiloteBun(path));
      expect((await encore.summary(365, jour(60))).rules).toEqual(resume.rules);
      await encore.close();
      expect(lire(path)).toEqual(apres);
    });
  });

  it("le libellé d'une faute nouvelle est la description fixe de la règle", async () => {
    const journal = await Journal.ouvrir(ouvrirPiloteBun(":memory:"));
    const original = `Hier, ${MOT_FAUTIF} est venu.`;
    const match: LTMatch = {
      message: `Faute de frappe sur « ${MOT_FAUTIF} »`,
      shortMessage: "",
      offset: 6,
      length: MOT_FAUTIF.length,
      replacements: [],
      rule: {
        id: "REGLE_X",
        description: "Description fixe",
        issueType: "grammar",
        category: { id: "GRAMMAR", name: "Grammaire" },
      },
    };
    await journal.record(analyze(original, "Hier, Paul est venu.", [match]), jour(0) + DAY);
    const resume = await journal.summary(365, jour(2));
    expect(resume.rules).toEqual([
      { ruleKey: "REGLE_X", categoryName: "Grammaire", label: "Description fixe", count: 1 },
    ]);
    await journal.close();
  });
});

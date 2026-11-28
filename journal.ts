import {
  avecEnAttente,
  BadgeStore,
  lireFaits,
  nouveauxBadges,
  PURGE_BADGES,
  REQUETE_TEXTES,
  REQUETES_BADGES,
  SCHEMA_BADGES,
} from "./journal.badges.ts";
import type { AnswerResult } from "./api/deps.ts";
import {
  type JournalDriver,
  MIGRATION_SANS_TEXTE,
  type Query,
  type Statement,
} from "./journal.driver.ts";
import {
  type FollowOptions,
  fusionnerEtatsParMot,
  libelleRegle,
  motifParMot,
  requeteEtatsParMot,
  lireInstantaneSuivi,
  type PlanSuivi,
  planifierRejeu,
  planifierSuivi,
  PURGE_REGLES,
  REQUETES_LISTE,
  REQUETES_REJEU,
  requetesSuivi,
  type RuleHistoryEntry,
  RuleStore,
  type RuleView,
  SCHEMA_REGLES,
  SELECT_LIBELLE,
  type Suivi,
  vueRegles,
} from "./journal.rules.ts";
import { type Analysis, REGLES_PAR_MOT } from "./src/analysis/analyze.ts";
import type { BadgeAnnonce } from "./src/analysis/badges/vue.ts";
import {
  calculerProgression,
  debutPremiereSemaine,
  type LigneFaute,
  type LigneTexte,
  type Progression,
} from "./src/analysis/progression/calcul.ts";
import {
  construireExport,
  type ExportBeta,
  nouveauParticipant,
  type Plateforme,
  validerExport,
} from "./src/analysis/progression/export.ts";
import {
  calculerMesure,
  type EntreeMesure,
  type Mesure,
} from "./src/analysis/progression/mesure.ts";
import { choisirTendance, type TendanceRegle } from "./src/analysis/progression/tendance.ts";
import type { RuleState } from "./src/analysis/regles/cycle.ts";
import { JOUR_MS } from "./src/analysis/regles/seuils.ts";
import { noteSur20 } from "./src/analysis/score.ts";
import type { WeekSummary } from "./src/types.ts";

export type { JournalDriver } from "./journal.driver.ts";
export type { RuleHistoryEntry, RuleHistoryType, RuleView, Suivi } from "./journal.rules.ts";

/**
 * Version du schéma, conservée dans `PRAGMA user_version` : 0 pour une base
 * v0.2.0, 1 avec le cycle de vie des règles, 2 avec les badges, 3 sans aucun
 * texte de l'utilisateur (ni phrase, ni mot, ni correction, ni message).
 */
export const SCHEMA_VERSION = 3;

/**
 * Journal créé par une version plus récente de Grammaria (`user_version` au-delà
 * de `SCHEMA_VERSION`) : l'ouvrir risquerait de l'abîmer. `Journal.ouvrir` échoue
 * sans rien écrire ; le bureau affiche ce message, le serveur ne démarre pas.
 */
export class JournalFuturError extends Error {
  constructor(readonly version: number) {
    super(
      `Ce journal a été créé par une version plus récente de Grammaria (schéma ${version}, ` +
        `cette version connaît le schéma ${SCHEMA_VERSION}). Installez la dernière version de ` +
        "Grammaria pour l'ouvrir ; il n'a pas été modifié.",
    );
    this.name = "JournalFuturError";
  }
}

export interface RuleCount {
  ruleKey: string;
  categoryName: string;
  /** Nom fixe de la règle (titre de la fiche, description du moteur, catégorie ou clé). */
  label: string;
  count: number;
}

export interface JournalSummary {
  days: number;
  period: WeekSummary;
  unclassified: number;
  rules: RuleCount[];
}

/**
 * Tables et index du journal, une instruction par entrée. Idempotent.
 *
 * Aucun texte de l'utilisateur n'y entre : une faute, c'est une règle, sa
 * source, sa catégorie, son type, une date et « comptée ou non ». Le libellé
 * d'une règle (`rule_labels`) est une donnée fixe de la règle, jamais son
 * message, qui peut citer les mots du texte.
 */
const SCHEMA_JOURNAL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS texts (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    created_at INTEGER NOT NULL,
    word_count INTEGER NOT NULL,
    fault_count INTEGER NOT NULL,
    unclassified_count INTEGER NOT NULL,
    score REAL
  )`,
  `CREATE TABLE IF NOT EXISTS faults (
    id INTEGER PRIMARY KEY,
    text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL DEFAULT 'local',
    created_at INTEGER NOT NULL,
    rule_key TEXT NOT NULL,
    source TEXT NOT NULL,
    category_id TEXT NOT NULL,
    category_name TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    counted INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rule_labels (
    rule_key TEXT NOT NULL PRIMARY KEY,
    label TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_texts_created ON texts(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_faults_rule ON faults(rule_key, created_at)",
  // Identifiant aléatoire du participant à la bêta (export anonyme, issue #34) :
  // une seule ligne au plus, créée au premier export.
  `CREATE TABLE IF NOT EXISTS beta_participant (
    id TEXT NOT NULL PRIMARY KEY
  )`,
];

const SQL_TEXTE = `INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score)
  VALUES (?, ?, ?, ?, ?)`;
const SQL_FAUTE = `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
    issue_type, counted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_LIBELLE = "INSERT OR REPLACE INTO rule_labels (rule_key, label) VALUES (?, ?)";
/** Crée l'identifiant du participant s'il n'existe pas encore (une seule ligne). */
const SQL_PARTICIPANT = `INSERT INTO beta_participant (id)
  SELECT ? WHERE NOT EXISTS (SELECT 1 FROM beta_participant)`;

/** Le texte et ses fautes : les deux premières lignes de chaque lot de `record`. */
function instructionsTexte(analysis: Analysis, now: number): Statement[] {
  const statements: Statement[] = [
    {
      sql: SQL_TEXTE,
      params: [
        now,
        analysis.wordCount,
        analysis.faultCount,
        analysis.unclassifiedCount,
        analysis.score,
      ],
    },
  ];
  const libelles = new Map<string, string>();
  for (const correction of analysis.corrections) {
    for (const f of correction.faults) {
      statements.push({
        sql: SQL_FAUTE,
        params: [
          { $rowid: 0 },
          now,
          f.ruleKey,
          f.source,
          f.categoryId,
          f.categoryName,
          f.issueType,
          f.counted ? 1 : 0,
        ],
      });
      libelles.set(f.ruleKey, f.label);
    }
  }
  for (const [ruleKey, label] of libelles) {
    statements.push({ sql: SQL_LIBELLE, params: [ruleKey, label] });
  }
  return statements;
}

const sansSuivi = (): Suivi => ({ intervention: null, reussites: [] });

/**
 * Journal des fautes : une ligne par texte corrigé, une ligne par faute, et
 * l'état de chaque règle dans son cycle de vie (voir `journal.rules.ts`).
 * Aucun texte de l'utilisateur n'est conservé : ni le texte, ni la phrase,
 * ni le mot fautif, ni la correction, ni le message de la règle.
 *
 * Toute la base passe par un `JournalDriver` : chaque écriture LIT un
 * instantané, CALCULE en pur, puis ÉCRIT un lot atomique, sans transaction
 * interactive. Aucun import de Bun ni de Node : le même code tourne sur le
 * serveur (`journal.driver.bun.ts`) et dans la WebView du bureau.
 */
export class Journal {
  private readonly ruleStore: RuleStore;
  /** Badges de progression (voir `journal.badges.ts`). */
  readonly badges: BadgeStore;
  /** Dernière écriture en cours : les écritures s'enchaînent sans s'entrelacer. */
  private file: Promise<unknown> = Promise.resolve();

  private constructor(private readonly driver: JournalDriver) {
    this.ruleStore = new RuleStore(driver);
    this.badges = new BadgeStore(driver, this.serie);
  }

  /** Ouvre le journal sur `driver` : crée les tables manquantes et migre le schéma. */
  static async ouvrir(driver: JournalDriver): Promise<Journal> {
    const journal = new Journal(driver);
    await journal.serie(() => journal.migrate());
    return journal;
  }

  /**
   * Exécute une écriture après les précédentes : entre la lecture de
   * l'instantané et l'écriture du lot, aucune autre écriture du journal ne
   * s'intercale, même derrière un pont asynchrone.
   */
  private serie = <T>(operation: () => Promise<T>): Promise<T> => {
    const resultat = this.file.then(operation, operation);
    this.file = resultat.catch(() => {});
    return resultat;
  };

  /**
   * Crée les tables manquantes et met le schéma à la version courante, en un
   * lot. Idempotent. Sur une base v0.2.0, l'état des règles est reconstruit à
   * partir des fautes journalisées ; sur une base antérieure aux badges, les
   * badges déjà mérités sont attribués à leur date réelle, sans notification.
   * Sur une base antérieure à la version 3, les textes de l'utilisateur sont
   * effacés (voir `effacerTextes`), le reste de l'historique est conservé.
   */
  private async migrate(): Promise<void> {
    // Version lue AVANT toute écriture : un journal d'une version future de
    // Grammaria (schéma inconnu) n'est jamais modifié.
    const [{ user_version: version }] = await this.driver.read<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if (version > SCHEMA_VERSION) throw new JournalFuturError(version);
    await this.driver.batch(
      [...SCHEMA_JOURNAL, ...SCHEMA_REGLES, ...SCHEMA_BADGES].map((sql) => ({ sql })),
    );
    if (version >= SCHEMA_VERSION) return;

    // Avant le rejeu de l'état des règles (v0) : il lit les clés normalisées.
    if (version < 3) await this.effacerTextes();
    const lignes = await this.driver.readMany([...REQUETES_REJEU, ...REQUETES_BADGES]);
    const statements: Statement[] = [];
    let evenements: PlanSuivi["evenements"] = [];
    if (version < 1) {
      const rejeu = planifierRejeu(lignes.slice(0, REQUETES_REJEU.length));
      statements.push(...rejeu.statements);
      evenements = rejeu.evenements;
    }
    if (version < 2) {
      // Attribution rétroactive : le résultat (badges nouveaux) n'est pas annoncé.
      const { faits, obtenus } = lireFaits(lignes.slice(REQUETES_REJEU.length));
      const now = Date.now();
      statements.push(
        ...nouveauxBadges(avecEnAttente(faits, null, evenements), obtenus, now).statements,
      );
    }
    statements.push({ sql: `PRAGMA user_version = ${SCHEMA_VERSION}` });
    await this.driver.batch(statements);
    // Les octets des textes supprimés restent sinon dans les pages libres du
    // fichier et dans le WAL : la base est réécrite, le WAL vidé.
    if (version < 3) await this.driver.compacter();
  }

  /**
   * Migration vers la version 3 : retire de la table des fautes les colonnes
   * de texte (`message`, `word`, `replacement`, `sentence`) et ramène les clés
   * de règle qui contenaient un mot du texte à leur règle d'origine (voir
   * `REGLES_PAR_MOT`). Les lignes, les dates et les compteurs restent : toute
   * la progression est conservée. Idempotent, en un lot.
   */
  private async effacerTextes(): Promise<void> {
    const [colonnes, etats] = (await this.driver.readMany([
      { sql: "PRAGMA table_info(faults)" },
      requeteEtatsParMot(),
    ])) as [{ name: string }[], RuleState[]];
    const presentes = new Set(colonnes.map((c) => c.name));
    // L'index de `word` d'abord : SQLite ne retire pas une colonne indexée.
    const retraits = MIGRATION_SANS_TEXTE.filter(
      (sql) => !sql.startsWith("ALTER") || presentes.has(sql.slice(sql.lastIndexOf(" ") + 1)),
    );
    const statements: Statement[] = retraits.map((sql) => ({ sql }));
    for (const ruleKey of Object.keys(REGLES_PAR_MOT)) {
      for (const table of ["faults", "rule_events"]) {
        statements.push({
          sql: `UPDATE ${table} SET rule_key = ? WHERE rule_key LIKE ? ESCAPE '\\'`,
          params: [ruleKey, motifParMot(ruleKey)],
        });
      }
    }
    statements.push(...fusionnerEtatsParMot(etats));
    await this.driver.batch(statements);
  }

  /**
   * Journalise un texte corrigé, met à jour l'état des règles et les badges,
   * et renvoie l'intervention à afficher près du bouton Copier.
   *
   * Un `readMany` (instantané), un calcul pur, un `batch`. Les badges obtenus
   * avec ce texte sont enregistrés dans le même lot et annoncés par l'appel
   * suivant à `badges.award()`.
   */
  record(
    analysis: Analysis,
    now: number = Date.now(),
    options: FollowOptions = {},
  ): Promise<Suivi> {
    return this.serie(async () => {
      const requetes = requetesSuivi(analysis, now);
      const lignes = await this.driver.readMany([...requetes, ...REQUETES_BADGES]);
      const texte = instructionsTexte(analysis, now);

      // Le suivi des règles ne doit jamais faire perdre le texte journalisé :
      // en cas d'échec, le lot ne contient que le texte et ses fautes.
      let plan: PlanSuivi | null = null;
      try {
        plan = planifierSuivi(
          analysis,
          lireInstantaneSuivi(lignes.slice(0, requetes.length)),
          now,
          options,
        );
      } catch (error) {
        console.error("[journal] suivi des règles annulé pour ce texte :", error);
      }

      // Badges : un échec du calcul n'empêche ni le texte ni le suivi.
      let badges: { annonces: BadgeAnnonce[]; statements: Statement[] } | null = null;
      let dernierFait = now;
      try {
        const instantane = lireFaits(lignes.slice(requetes.length));
        const ligne: LigneTexte = {
          at: now,
          words: analysis.wordCount,
          faults: analysis.faultCount,
        };
        const faits = avecEnAttente(instantane.faits, ligne, plan?.evenements ?? []);
        badges = nouveauxBadges(faits, instantane.obtenus, now);
        dernierFait = Math.max(now, instantane.dernierFait);
      } catch (error) {
        console.error("[Badges] Évaluation impossible :", error);
      }

      const suivi = [...(plan?.statements ?? []), ...(badges?.statements ?? [])];
      let resultats;
      try {
        resultats = await this.driver.batch([...texte, ...suivi]);
      } catch (error) {
        this.badges.invalider();
        if (suivi.length === 0) throw error;
        // Lot refusé à cause du suivi : le texte et ses fautes sont écrits seuls.
        console.error("[journal] suivi des règles annulé pour ce texte :", error);
        await this.driver.batch(texte);
        return sansSuivi();
      }
      if (badges) this.badges.retenir(badges.annonces, now, dernierFait);
      else this.badges.invalider();
      if (!plan) return sansSuivi();
      const { suivi: resultat, indexChoix } = plan;
      if (indexChoix !== null && resultat.intervention?.type === "choix") {
        // Le choix est identifié par l'id de son événement « choix ».
        const choiceId = resultats[texte.length + indexChoix].lastInsertRowid;
        return { ...resultat, intervention: { ...resultat.intervention, choiceId } };
      }
      return resultat;
    });
  }

  /** État de chaque règle suivie dans son cycle de vie. */
  rules(): Promise<RuleView[]> {
    return this.ruleStore.list();
  }

  /** Historique daté des transitions et des sollicitations. */
  ruleEvents(options: { limit?: number; ruleKey?: string } = {}): Promise<RuleHistoryEntry[]> {
    return this.ruleStore.events(options);
  }

  /** Réponse de l'utilisateur à un choix à deux formes précis (`choiceId`). */
  answerChoice(
    choiceId: number,
    correct: boolean,
    now: number = Date.now(),
  ): Promise<AnswerResult> {
    return this.serie(async () => {
      const result = await this.ruleStore.answer(choiceId, correct, now);
      // Une réponse juste est un fait des badges : la prochaine évaluation relit.
      if (result === "recorded") this.badges.invalider();
      return result;
    });
  }

  async period(days: number, now: number = Date.now()): Promise<WeekSummary> {
    const [row] = await this.driver.read<{ texts: number; words: number; faults: number }>(
      SQL_PERIODE,
      [now - days * JOUR_MS],
    );
    return { ...row, score: noteSur20(row.faults, row.words) };
  }

  async summary(days: number, now: number = Date.now()): Promise<JournalSummary> {
    const since = now - days * JOUR_MS;
    const [[periode], [unclassified], lignes] = (await this.driver.readMany([
      { sql: SQL_PERIODE, params: [since] },
      {
        sql: "SELECT COALESCE(SUM(unclassified_count), 0) AS n FROM texts WHERE created_at > ?",
        params: [since],
      },
      {
        sql: `SELECT rule_key AS ruleKey, MAX(category_name) AS categoryName,
                     ${SELECT_LIBELLE} AS label, COUNT(*) AS count
              FROM faults WHERE created_at > ? AND counted = 1
              GROUP BY rule_key ORDER BY count DESC, rule_key LIMIT 20`,
        params: [since],
      },
    ])) as [
      { texts: number; words: number; faults: number }[],
      { n: number }[],
      (Omit<RuleCount, "label"> & { label: string | null })[],
    ];
    const period = { ...periode, score: noteSur20(periode.faults, periode.words) };
    const rules = lignes.map((r) => ({ ...r, label: libelleRegle(r.ruleKey, r) }));
    return { days, period, unclassified: unclassified.n, rules };
  }

  /**
   * Tendance favorable de l'une des règles `ruleKeys`, à afficher avant la
   * note (issue #63) ; null si aucune ne progresse de façon mesurable. Même
   * calcul que la section « Ce que changent les astuces » de l'écran Progression.
   */
  async trend(ruleKeys: string[]): Promise<TendanceRegle | null> {
    if (ruleKeys.length === 0) return null;
    const [texts, states, dernieres, emplois, ...mesure] = await this.driver.readMany([
      REQUETE_TEXTES,
      ...REQUETES_LISTE,
      ...REQUETES_MESURE,
    ]);
    const rules = vueRegles(
      states as RuleState[],
      dernieres as Parameters<typeof vueRegles>[1],
      emplois as Parameters<typeof vueRegles>[2],
    );
    return choisirTendance(calculerMesure(entreeMesure(texts, mesure, rules)), ruleKeys);
  }

  /** Écran « Progression » : tout est calculé par `src/analysis/progression/`. */
  async progress(now: number = Date.now()): Promise<Progression & { mesure: Mesure }> {
    const [texts, faults, states, dernieres, emplois, ...mesure] = await this.driver.readMany([
      REQUETE_TEXTES,
      // Seules les fautes comptées des semaines affichées servent.
      {
        sql: `SELECT created_at AS at, rule_key AS ruleKey, ${SELECT_LIBELLE} AS label,
                     category_name AS categoryName
              FROM faults WHERE counted = 1 AND created_at >= ? ORDER BY created_at`,
        params: [debutPremiereSemaine(now)],
      },
      ...REQUETES_LISTE,
      ...REQUETES_MESURE,
    ]);
    const rules = vueRegles(
      states as RuleState[],
      dernieres as Parameters<typeof vueRegles>[1],
      emplois as Parameters<typeof vueRegles>[2],
    );
    return {
      ...calculerProgression(
        { texts: texts as LigneTexte[], faults: faults as LigneFaute[], rules },
        now,
      ),
      // L'état des règles porte ici leur libellé, pour l'écran (jamais exporté).
      mesure: calculerMesure(entreeMesure(texts, mesure, rules)),
    };
  }

  /**
   * Export anonyme de la bêta (`src/analysis/progression/export.ts`). Crée au
   * premier appel l'identifiant aléatoire du participant, gardé dans la base
   * jusqu'à « Effacer le journal ». L'export est validé avant d'être renvoyé :
   * il ne sort jamais un champ hors du format.
   */
  exportBeta(
    options: { application: string; plateforme: Plateforme },
    now: number = Date.now(),
  ): Promise<ExportBeta> {
    return this.serie(async () => {
      await this.driver.batch([{ sql: SQL_PARTICIPANT, params: [nouveauParticipant()] }]);
      const [[{ id: participant }], texts, ...mesure] = (await this.driver.readMany([
        { sql: "SELECT id FROM beta_participant LIMIT 1" },
        REQUETE_TEXTES,
        ...REQUETES_MESURE,
        { sql: "SELECT rule_key AS ruleKey, state FROM rule_states" },
      ])) as [{ id: string }[], ...unknown[][]];
      const states = mesure.pop() as EntreeMesure["states"];
      const exp = construireExport({
        ...options,
        participant,
        journal: entreeMesure(texts, mesure, states),
        now,
      });
      const resultat = validerExport(exp);
      if (!resultat.ok) throw new Error(`Export de la bêta invalide : ${resultat.erreur}`);
      return resultat.export;
    });
  }

  /** Efface le journal, remet à zéro l'état des règles et retire les badges. */
  purge(): Promise<void> {
    return this.serie(async () => {
      await this.driver.batch([
        { sql: "DELETE FROM faults" },
        { sql: "DELETE FROM texts" },
        { sql: "DELETE FROM rule_labels" },
        // Un journal effacé repart sous un nouvel identifiant de participant.
        { sql: "DELETE FROM beta_participant" },
        ...PURGE_REGLES,
        ...PURGE_BADGES,
      ]);
      this.badges.oublier();
    });
  }

  /** Ferme la base, après les écritures en cours. */
  async close(): Promise<void> {
    await this.file;
    await this.driver.close?.();
  }
}

/**
 * Lectures de la mesure (à la suite de `REQUETE_TEXTES`) : fautes comptées et
 * historique des règles. Des identifiants, des dates et des types seulement.
 */
const REQUETES_MESURE: readonly Query[] = [
  {
    sql: `SELECT created_at AS at, rule_key AS ruleKey, category_id AS categoryId
          FROM faults WHERE counted = 1 ORDER BY created_at, id`,
  },
  { sql: "SELECT rule_key AS ruleKey, created_at AS at, type FROM rule_events ORDER BY id" },
];

function entreeMesure(
  texts: unknown[],
  [faults, events]: unknown[][],
  states: EntreeMesure["states"],
): EntreeMesure {
  return {
    texts: texts as EntreeMesure["texts"],
    faults: faults as EntreeMesure["faults"],
    events: events as EntreeMesure["events"],
    states,
  };
}

const SQL_PERIODE = `SELECT COUNT(*) AS texts, COALESCE(SUM(word_count), 0) AS words,
       COALESCE(SUM(fault_count), 0) AS faults
FROM texts WHERE created_at > ?`;

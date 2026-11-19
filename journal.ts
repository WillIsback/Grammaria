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
import type { JournalDriver, Statement } from "./journal.driver.ts";
import {
  type AnswerResult,
  type FollowOptions,
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
  type Suivi,
  vueRegles,
} from "./journal.rules.ts";
import type { Analysis } from "./src/analysis/analyze.ts";
import type { BadgeAnnonce } from "./src/analysis/badges/vue.ts";
import {
  calculerProgression,
  debutPremiereSemaine,
  type LigneFaute,
  type LigneTexte,
  type Progression,
} from "./src/analysis/progression/calcul.ts";
import type { RuleState } from "./src/analysis/regles/cycle.ts";
import { JOUR_MS } from "./src/analysis/regles/seuils.ts";
import { noteSur20 } from "./src/analysis/score.ts";
import type { WeekSummary } from "./src/types.ts";

export type { JournalDriver } from "./journal.driver.ts";
export type { RuleHistoryEntry, RuleHistoryType, RuleView, Suivi } from "./journal.rules.ts";

/**
 * Version du schéma, conservée dans `PRAGMA user_version` : 0 pour une base
 * v0.2.0, 1 avec le cycle de vie des règles, 2 avec les badges.
 */
export const SCHEMA_VERSION = 2;

export interface RuleCount {
  ruleKey: string;
  categoryName: string;
  message: string;
  count: number;
}

export interface WordCount {
  word: string;
  replacement: string;
  count: number;
}

export interface JournalSummary {
  days: number;
  period: WeekSummary;
  unclassified: number;
  rules: RuleCount[];
  words: WordCount[];
}

/** Tables et index du journal, une instruction par entrée. Idempotent. */
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
    message TEXT NOT NULL,
    word TEXT NOT NULL,
    replacement TEXT NOT NULL,
    sentence TEXT NOT NULL,
    counted INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_texts_created ON texts(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_faults_rule ON faults(rule_key, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_faults_word ON faults(word, created_at)",
];

const SQL_TEXTE = `INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score)
  VALUES (?, ?, ?, ?, ?)`;
const SQL_FAUTE = `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
    issue_type, message, word, replacement, sentence, counted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
          f.message,
          f.word,
          f.replacement,
          f.sentence,
          f.counted ? 1 : 0,
        ],
      });
    }
  }
  return statements;
}

const sansSuivi = (): Suivi => ({ intervention: null, reussites: [] });

/**
 * Journal des fautes : une ligne par texte corrigé, une ligne par faute, et
 * l'état de chaque règle dans son cycle de vie (voir `journal.rules.ts`).
 * Le texte complet n'est jamais conservé, seulement la phrase contenant la faute.
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
   * Les tables `texts` et `faults` ne sont jamais modifiées.
   */
  private async migrate(): Promise<void> {
    await this.driver.batch(
      [...SCHEMA_JOURNAL, ...SCHEMA_REGLES, ...SCHEMA_BADGES].map((sql) => ({ sql })),
    );
    const [{ user_version: version }] = await this.driver.read<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if (version >= SCHEMA_VERSION) return;

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
    const [[periode], [unclassified], rules, words] = (await this.driver.readMany([
      { sql: SQL_PERIODE, params: [since] },
      {
        sql: "SELECT COALESCE(SUM(unclassified_count), 0) AS n FROM texts WHERE created_at > ?",
        params: [since],
      },
      {
        sql: `SELECT rule_key AS ruleKey, MAX(category_name) AS categoryName,
                     MAX(message) AS message, COUNT(*) AS count
              FROM faults WHERE created_at > ? AND counted = 1
              GROUP BY rule_key ORDER BY count DESC, rule_key LIMIT 20`,
        params: [since],
      },
      {
        sql: `SELECT word, MAX(replacement) AS replacement, COUNT(*) AS count
              FROM faults WHERE created_at > ? AND counted = 1 AND word != ''
              GROUP BY word ORDER BY count DESC, word LIMIT 20`,
        params: [since],
      },
    ])) as [
      { texts: number; words: number; faults: number }[],
      { n: number }[],
      RuleCount[],
      WordCount[],
    ];
    const period = { ...periode, score: noteSur20(periode.faults, periode.words) };
    return { days, period, unclassified: unclassified.n, rules, words };
  }

  /**
   * Tous les textes corrigés (date, mots, fautes), du plus ancien au plus
   * récent : pour l'écran « Progression » et pour les badges.
   */
  async texts(): Promise<LigneTexte[]> {
    return this.driver.read<LigneTexte>(REQUETE_TEXTES.sql);
  }

  /** Écran « Progression » : tout est calculé par `src/analysis/progression/`. */
  async progress(now: number = Date.now()): Promise<Progression> {
    const [texts, faults, states, dernieres] = await this.driver.readMany([
      REQUETE_TEXTES,
      // Seules les fautes comptées des semaines affichées servent.
      {
        sql: `SELECT created_at AS at, rule_key AS ruleKey, word, replacement, message,
                     category_name AS categoryName
              FROM faults WHERE counted = 1 AND created_at >= ? ORDER BY created_at`,
        params: [debutPremiereSemaine(now)],
      },
      ...REQUETES_LISTE,
    ]);
    const rules = vueRegles(states as RuleState[], dernieres as Parameters<typeof vueRegles>[1]);
    return calculerProgression(
      { texts: texts as LigneTexte[], faults: faults as LigneFaute[], rules },
      now,
    );
  }

  /** Efface le journal, remet à zéro l'état des règles et retire les badges. */
  purge(): Promise<void> {
    return this.serie(async () => {
      await this.driver.batch([
        { sql: "DELETE FROM faults" },
        { sql: "DELETE FROM texts" },
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

const SQL_PERIODE = `SELECT COUNT(*) AS texts, COALESCE(SUM(word_count), 0) AS words,
       COALESCE(SUM(fault_count), 0) AS faults
FROM texts WHERE created_at > ?`;

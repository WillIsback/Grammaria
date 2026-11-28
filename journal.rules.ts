import type { AnswerResult } from "./api/deps.ts";
import { estConflit, type JournalDriver, type Query, type Statement } from "./journal.driver.ts";
import type { Analysis } from "./src/analysis/analyze.ts";
import { FICHES, type Fiche, libelleSansFiche } from "./src/analysis/fiches.ts";
import {
  appliquerEvenement,
  entreDansLeCycle,
  type EtatCycle,
  type RuleContext,
  type RuleEvent,
  type RuleState,
  type Transition,
  type TransitionType,
} from "./src/analysis/regles/cycle.ts";
import {
  type Candidat,
  choisirIntervention,
  type Intervention,
  type Reussite,
} from "./src/analysis/regles/intervention.ts";
import { JOUR_MS, SEUILS } from "./src/analysis/regles/seuils.ts";
import { detecteEmplois, reglesEmployees } from "./src/analysis/regles/emplois.ts";
import { choisirRevision, type QuestionRevision } from "./src/analysis/regles/revision.ts";
import { REGLES_PAR_MOT, regleParMot } from "./src/analysis/analyze.ts";

/** Une règle telle que l'expose `GET /api/rules`. */
export interface RuleView extends RuleState {
  /** Nom lisible : titre de la fiche, sinon libellé fixe de la règle, catégorie ou clé. */
  label: string;
  categoryName: string;
  /** Fiche de règle (titre, astuce) quand la règle en possède une. */
  fiche: Fiche | null;
  /**
   * Textes où la règle a été employée correctement depuis sa dernière faute
   * (issue #60) ; null quand on ne sait pas reconnaître ses emplois.
   */
  correctUses: number | null;
}

/** Type d'une ligne de l'historique : transition du cycle ou sollicitation. */
export type RuleHistoryType =
  | TransitionType
  | "astuce"
  | "choix"
  | "reponse_juste"
  | "reponse_fausse"
  /** La règle a été employée correctement dans un texte (issue #60). */
  | "emploi"
  /** Question de révision posée pendant l'attente, et sa réponse (issue #62). */
  | "revision"
  | "revision_juste"
  | "revision_fausse";

/** Une ligne datée de l'historique d'une règle (`GET /api/rules/events`). */
export interface RuleHistoryEntry {
  id: number;
  ruleKey: string;
  at: number;
  type: RuleHistoryType;
  /** États avant et après, pour les transitions ; null sinon. */
  from: EtatCycle | null;
  to: EtatCycle | null;
}

/** Ce que le serveur demande d'afficher près du bouton Copier pour un texte. */
export interface Suivi {
  intervention: Intervention | null;
  reussites: Reussite[];
}

export interface FollowOptions {
  /**
   * Texte d'origine, pour proposer les deux formes sur la phrase de l'utilisateur.
   * Utilisé pendant la requête seulement : rien n'en est journalisé (l'événement
   * « choix » ne garde que la règle et la date).
   */
  original?: string;
  /**
   * Texte corrigé, pour situer le mot à masquer pendant le choix (issue #59).
   * Comme `original`, il ne sert que pendant la requête : rien n'en est journalisé.
   */
  corrected?: string;
  /** Tirage de l'ordre des deux formes ; injectable pour les tests. */
  random?: () => number;
  /**
   * Une question de révision a déjà été posée pendant l'attente de ce texte :
   * il ne reçoit ni astuce ni choix (une seule sollicitation par texte, issue #62).
   */
  sansIntervention?: boolean;
}

/**
 * Champs de `RuleState`, dans l'ordre des colonnes de `rule_states` : la
 * colonne est le nom du champ en snake_case (`tipsShown` → `tips_shown`).
 */
const CHAMPS_ETAT = [
  "ruleKey",
  "state",
  "stateSince",
  "occurrences",
  "firstFaultAt",
  "lastFaultAt",
  "tipsShown",
  "choicesShown",
  "choicesCorrect",
  "choicesWrong",
  "lastSolicitedAt",
  "solicitationsThatDay",
  "acquiredAt",
  "relapses",
] as const satisfies readonly (keyof RuleState)[];

const colonne = (champ: string) => champ.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
/** Colonnes de `rule_states` lues sous le nom des champs de `RuleState`. */
const SELECT_ETAT = CHAMPS_ETAT.map((c) => `${colonne(c)} AS ${c}`).join(", ");
const COLONNES_ETAT = CHAMPS_ETAT.map(colonne).join(", ");
const SQL_SAUVER = `INSERT OR REPLACE INTO rule_states (${COLONNES_ETAT})
  VALUES (${CHAMPS_ETAT.map(() => "?").join(", ")})`;
const SQL_JOURNALISER = `INSERT INTO rule_events (rule_key, created_at, type, from_state, to_state)
  VALUES (?, ?, ?, ?, ?)`;
/** Règles qui peuvent devenir « acquises » : celles dont on attend l'usage. */
const EN_ATTENTE_D_USAGE = "state IN ('signalee', 'travaillee') AND last_fault_at <= ?";
/** Types d'événements qui closent un choix à deux formes. */
const TYPES_CHOIX = "('choix', 'reponse_juste', 'reponse_fausse')";
/** Libellé fixe de la règle d'une faute lue (`rule_labels`) ; null s'il est inconnu. */
export const SELECT_LIBELLE =
  "(SELECT label FROM rule_labels WHERE rule_labels.rule_key = faults.rule_key)";
/** Colonnes d'une `DerniereFaute`, lues dans `faults`. */
const SELECT_DERNIERE = `rule_key AS ruleKey, ${SELECT_LIBELLE} AS label, category_name AS categoryName`;
type DerniereFaute = { ruleKey: string } & LibelleConnu;

/** Tables de la Phase 2, une instruction par entrée. Idempotent. */
export const SCHEMA_REGLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rule_states (
    rule_key TEXT NOT NULL PRIMARY KEY,
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
    relapses INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS rule_events (
    id INTEGER PRIMARY KEY,
    rule_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_rule_events_rule ON rule_events(rule_key, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_rule_events_created ON rule_events(created_at)",
];

export const PURGE_REGLES: readonly Statement[] = [
  { sql: "DELETE FROM rule_events" },
  { sql: "DELETE FROM rule_states" },
];

const placeholders = (n: number) => Array(n).fill("?").join(", ");

/** Ordre de `ORDER BY` de SQLite sur du texte (octets UTF-8). */
const encodeur = new TextEncoder();
function comparerBinaire(a: string, b: string): number {
  const x = encodeur.encode(a);
  const y = encodeur.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Libellé fixe d'une règle et catégorie de sa dernière faute (`rule_labels`, `faults`). */
type LibelleConnu = { label: string | null; categoryName: string };

/** Nom d'une règle : titre de sa fiche, sinon son libellé fixe, sa catégorie ou sa clé. */
export function libelleRegle(ruleKey: string, connu: LibelleConnu | null | undefined): string {
  return FICHES[ruleKey]?.titre ?? libelleSansFiche(ruleKey, connu);
}

/** Libellé d'une règle à partir de sa dernière faute journalisée. */
function libelle(
  ruleKey: string,
  derniere: LibelleConnu | null | undefined,
): { label: string; categoryName: string } {
  return { label: libelleRegle(ruleKey, derniere), categoryName: derniere?.categoryName ?? "" };
}

/** Un événement de l'historique en attente d'écriture. */
export interface EvenementEnAttente {
  ruleKey: string;
  at: number;
  type: RuleHistoryType;
  from: EtatCycle | null;
  to: EtatCycle | null;
}

/**
 * État des règles en mémoire pendant un calcul : l'instantané lu, plus les
 * changements en attente. Rien n'est écrit tant que `statements()` n'est pas
 * passé au pilote dans un lot.
 */
class EtatsEnMemoire {
  private readonly etats = new Map<string, RuleState>();
  private readonly modifiees = new Set<string>();
  readonly evenements: EvenementEnAttente[] = [];

  constructor(etats: Iterable<RuleState>) {
    for (const etat of etats) this.etats.set(etat.ruleKey, etat);
  }

  get(ruleKey: string): RuleState | null {
    return this.etats.get(ruleKey) ?? null;
  }

  tous(): IterableIterator<RuleState> {
    return this.etats.values();
  }

  /** Applique un événement, garde l'état et ses transitions. */
  apply(
    ruleKey: string,
    event: RuleEvent,
    context: RuleContext,
    now: number,
    known?: RuleState,
  ): { state: RuleState; transitions: Transition[] } | null {
    const avant = known ?? this.get(ruleKey);
    const result = appliquerEvenement(ruleKey, avant, event, context, now);
    if (!result) return null;
    if (result.state !== avant) {
      this.etats.set(ruleKey, result.state);
      this.modifiees.add(ruleKey);
    }
    for (const t of result.transitions) this.log(t.ruleKey, t.at, t.type, t.from, t.to);
    return result;
  }

  /** Ajoute un événement ; renvoie son rang parmi les événements en attente. */
  log(
    ruleKey: string,
    at: number,
    type: RuleHistoryType,
    from: EtatCycle | null = null,
    to: EtatCycle | null = null,
  ): number {
    return this.evenements.push({ ruleKey, at, type, from, to }) - 1;
  }

  /** Applique une faute ; `previousFaultTimes` : fautes déjà journalisées sur la règle. */
  applyFault(ruleKey: string, count: number, now: number, previousFaultTimes: number[]): RuleState {
    let otherWorkedRules = 0;
    for (const s of this.etats.values()) {
      if (s.state === "travaillee" && s.ruleKey !== ruleKey) otherWorkedRules++;
    }
    const result = this.apply(
      ruleKey,
      { type: "faute", count },
      { previousFaultTimes, otherWorkedRules },
      now,
    );
    // Une faute crée toujours l'état : le résultat n'est jamais null ici.
    return (result as { state: RuleState }).state;
  }

  /**
   * Règles « signalées » ou « travaillées » devenues « acquises » à `now`.
   * `textes` donne les dates des textes corrigés après une date (texte courant
   * compris) ; il peut en donner davantage, la logique filtre elle-même.
   */
  checkAcquisitions(
    now: number,
    textes: (depuis: number) => number[],
    emplois?: (ruleKey: string) => number[],
  ): string[] {
    const limite = now - SEUILS.acquisitionJoursSansFaute * JOUR_MS;
    const states = [...this.etats.values()]
      .filter(
        (s) => (s.state === "signalee" || s.state === "travaillee") && s.lastFaultAt <= limite,
      )
      .sort((a, b) => comparerBinaire(a.ruleKey, b.ruleKey));
    if (states.length === 0) return [];
    const texts = textes(Math.min(...states.map((s) => s.lastFaultAt)));
    const acquises: string[] = [];
    for (const state of states) {
      const result = this.apply(
        state.ruleKey,
        { type: "usage" },
        { textTimesSinceLastFault: texts, correctUseTimes: emplois?.(state.ruleKey) },
        now,
        state,
      );
      if (result?.state.state === "acquise") acquises.push(state.ruleKey);
    }
    return acquises;
  }

  /**
   * Instructions du lot : les états modifiés, puis les événements dans
   * l'ordre. L'événement de rang `i` est l'instruction `nombreEtats + i`.
   */
  statements(): { statements: Statement[]; nombreEtats: number } {
    const statements: Statement[] = [];
    for (const ruleKey of this.modifiees) {
      const s = this.etats.get(ruleKey) as RuleState;
      statements.push({ sql: SQL_SAUVER, params: CHAMPS_ETAT.map((c) => s[c]) });
    }
    const nombreEtats = statements.length;
    for (const e of this.evenements) {
      statements.push({ sql: SQL_JOURNALISER, params: [e.ruleKey, e.at, e.type, e.from, e.to] });
    }
    return { statements, nombreEtats };
  }
}

/** Candidat du texte courant, avant la mise à jour de son état. */
type CandidatTexte = Omit<Candidat, "state"> & { state: RuleState; count: number };

/** Règles fautives du texte qui entrent dans le cycle, dans l'ordre du texte. */
function candidatsDuTexte(analysis: Analysis): Map<string, CandidatTexte> {
  // Seules les fautes classées et comptées dans la note entrent dans le cycle.
  const candidats = new Map<string, CandidatTexte>();
  for (const correction of analysis.corrections) {
    for (const fault of correction.faults) {
      if (!entreDansLeCycle(fault)) continue;
      let candidat = candidats.get(fault.ruleKey);
      if (!candidat) {
        candidat = {
          // remplacé par l'état à jour après la faute
          state: undefined as unknown as RuleState,
          titre: correction.fiche?.titre ?? libelleSansFiche(fault.ruleKey, fault),
          astuce: correction.fiche?.astuce ?? null,
          passages: [],
          count: 0,
        };
        candidats.set(fault.ruleKey, candidat);
      }
      candidat.count++;
      candidat.passages.push({
        start: correction.start,
        end: correction.end,
        avant: correction.avant,
        apres: correction.apres,
      });
    }
  }
  return candidats;
}

/** Instantané nécessaire au suivi d'un texte (voir `requetesSuivi`). */
export interface InstantaneSuivi {
  /** États des règles du texte et de toutes les règles signalées ou travaillées. */
  etats: RuleState[];
  /** Fautes comptées récentes des règles du texte (fenêtre du signalement). */
  fautesRecentes: { ruleKey: string; at: number }[];
  /** Dates des textes depuis la plus ancienne dernière faute des règles en attente d'usage. */
  textes: { at: number }[];
  /** Dernière faute de chaque règle en attente d'usage, pour son libellé. */
  dernieresFautes: DerniereFaute[];
  /** Emplois corrects journalisés des règles en attente d'usage (issue #60). */
  emplois: { ruleKey: string; at: number }[];
}

/**
 * Requêtes de l'instantané du suivi d'un texte à `now`, à lire dans un
 * `readMany` (dans cet ordre, à la suite d'autres requêtes au besoin). Rien
 * n'y dépend de la taille de l'historique au-delà des fenêtres utiles.
 */
export function requetesSuivi(analysis: Analysis, now: number): Query[] {
  const cles = [...candidatsDuTexte(analysis).keys()];
  const limite = now - SEUILS.acquisitionJoursSansFaute * JOUR_MS;
  const dansLeTexte = cles.length ? `rule_key IN (${placeholders(cles.length)}) OR ` : "";
  return [
    {
      sql: `SELECT ${SELECT_ETAT} FROM rule_states
            WHERE ${dansLeTexte}state IN ('signalee', 'travaillee')`,
      params: cles,
    },
    {
      sql: cles.length
        ? `SELECT rule_key AS ruleKey, created_at AS at FROM faults
           WHERE rule_key IN (${placeholders(cles.length)}) AND counted = 1 AND created_at > ?
           ORDER BY id`
        : "SELECT rule_key AS ruleKey, created_at AS at FROM faults WHERE 0",
      params: cles.length ? [...cles, now - SEUILS.signalementFenetreJours * JOUR_MS] : [],
    },
    {
      sql: `SELECT created_at AS at FROM texts
            WHERE created_at > (SELECT MIN(last_fault_at) FROM rule_states WHERE ${EN_ATTENTE_D_USAGE})
              AND created_at <= ?
            ORDER BY created_at, id`,
      params: [limite, now],
    },
    {
      sql: `SELECT ${SELECT_DERNIERE} FROM faults
            WHERE id IN (SELECT MAX(id) FROM faults
                         WHERE rule_key IN (SELECT rule_key FROM rule_states WHERE ${EN_ATTENTE_D_USAGE})
                         GROUP BY rule_key)`,
      params: [limite],
    },
    {
      sql: `SELECT rule_key AS ruleKey, created_at AS at FROM rule_events
            WHERE type = 'emploi'
              AND rule_key IN (SELECT rule_key FROM rule_states WHERE ${EN_ATTENTE_D_USAGE})
            ORDER BY created_at, id`,
      params: [limite],
    },
  ];
}

export function lireInstantaneSuivi(lignes: unknown[][]): InstantaneSuivi {
  const [etats, fautesRecentes, textes, dernieresFautes, emplois] = lignes;
  return { etats, fautesRecentes, textes, dernieresFautes, emplois } as InstantaneSuivi;
}

/** Résultat pur du suivi d'un texte : ce qu'il faut écrire et ce qu'il faut afficher. */
export interface PlanSuivi {
  suivi: Suivi;
  statements: Statement[];
  /** Rang, dans `statements`, de l'événement « choix » (son id est le `choiceId`). */
  indexChoix: number | null;
  /** Événements en attente, dans l'ordre d'écriture. */
  evenements: EvenementEnAttente[];
}

/**
 * Suivi d'un texte journalisé à `now` : calcul pur sur l'instantané et les
 * changements en attente (fautes du texte, transitions, acquisitions,
 * intervention). Le texte et ses fautes sont écrits par l'appelant, avant
 * les instructions renvoyées, dans le même lot.
 */
export function planifierSuivi(
  analysis: Analysis,
  instantane: InstantaneSuivi,
  now: number,
  options: FollowOptions = {},
): PlanSuivi {
  const candidats = candidatsDuTexte(analysis);
  const etats = new EtatsEnMemoire(instantane.etats);

  const recentes = new Map<string, number[]>();
  for (const f of instantane.fautesRecentes) {
    const liste = recentes.get(f.ruleKey);
    if (liste) liste.push(f.at);
    else recentes.set(f.ruleKey, [f.at]);
  }
  for (const [ruleKey, candidat] of candidats) {
    candidat.state = etats.applyFault(ruleKey, candidat.count, now, recentes.get(ruleKey) ?? []);
  }

  // Le texte courant compte parmi les textes de l'usage.
  const textes = [...instantane.textes.map((t) => t.at), now];

  // Emplois corrects (issue #60) : une règle suivie, employée sans faute dans ce
  // texte, reçoit un événement daté « emploi » (ni mot ni phrase). Sans le
  // texte d'origine, on ne sait rien des emplois : le critère reste celui des textes.
  let emploisDe: ((ruleKey: string) => number[]) | undefined;
  if (options.original !== undefined) {
    const emplois = new Map<string, number[]>();
    for (const e of instantane.emplois ?? []) {
      const liste = emplois.get(e.ruleKey);
      if (liste) liste.push(e.at);
      else emplois.set(e.ruleKey, [e.at]);
    }
    for (const ruleKey of reglesEmployees(options.original, analysis.corrections)) {
      if (candidats.has(ruleKey)) continue;
      const etat = etats.get(ruleKey)?.state;
      if (etat !== "signalee" && etat !== "travaillee") continue;
      etats.log(ruleKey, now, "emploi");
      const liste = emplois.get(ruleKey);
      if (liste) liste.push(now);
      else emplois.set(ruleKey, [now]);
    }
    emploisDe = (ruleKey) => emplois.get(ruleKey) ?? [];
  }
  const acquises = etats.checkAcquisitions(now, () => textes, emploisDe);

  // Libellé : la dernière faute journalisée sur la règle, texte courant compris.
  const dernieres = new Map(instantane.dernieresFautes.map((f) => [f.ruleKey, f]));
  for (const correction of analysis.corrections) {
    for (const f of correction.faults) dernieres.set(f.ruleKey, f);
  }
  const reussites: Reussite[] = acquises.map((ruleKey) => ({
    ruleKey,
    titre: libelle(ruleKey, dernieres.get(ruleKey)).label,
  }));

  const proposee = options.sansIntervention
    ? null
    : choisirIntervention(
        [...candidats.values()],
        options.original ?? "",
        now,
        options.random,
        undefined,
        options.corrected,
      );

  let intervention: Intervention | null = null;
  let rangChoix: number | null = null;
  if (proposee) {
    etats.apply(proposee.ruleKey, { type: proposee.type }, {}, now);
    const rang = etats.log(proposee.ruleKey, now, proposee.type);
    if (proposee.type === "choix") {
      rangChoix = rang;
      // L'identifiant est celui de l'événement « choix », connu après le lot.
      intervention = { ...proposee, choiceId: 0 };
    } else {
      intervention = proposee;
    }
  }
  const { statements, nombreEtats } = etats.statements();
  return {
    suivi: { intervention, reussites },
    statements,
    indexChoix: rangChoix === null ? null : nombreEtats + rangChoix,
    evenements: etats.evenements,
  };
}

/** Première position de `valeurs` (triées) strictement supérieure à `x`. */
function apres(valeurs: readonly number[], x: number): number {
  let bas = 0;
  let haut = valeurs.length;
  while (bas < haut) {
    const milieu = (bas + haut) >>> 1;
    if (valeurs[milieu] <= x) bas = milieu + 1;
    else haut = milieu;
  }
  return bas;
}

/** Lectures de la migration v0.2.0 → état des règles. */
export const REQUETES_REJEU: readonly Query[] = [
  { sql: "SELECT COUNT(*) AS n FROM rule_states" },
  { sql: "SELECT id, created_at AS at FROM texts ORDER BY created_at, id" },
  {
    sql: `SELECT text_id AS textId, rule_key AS ruleKey, created_at AS at, id FROM faults
          WHERE counted = 1 ORDER BY id`,
  },
];

/**
 * Migration d'une base v0.2.0 : reconstruit l'état des règles, s'il n'en
 * existe aucun, en rejouant le journal texte par texte, dans l'ordre
 * chronologique et avec les dates d'origine : les fautes du texte, puis
 * l'usage (acquisition). Une règle acquise depuis longtemps l'est donc dès
 * la migration, à sa date historique, sans message de réussite au premier
 * texte corrigé ensuite. Calcul pur sur les lignes de `REQUETES_REJEU` ; les
 * tables `texts` et `faults` ne sont jamais modifiées.
 */
export function planifierRejeu(lignes: unknown[][]): {
  statements: Statement[];
  evenements: EvenementEnAttente[];
} {
  const [[{ n }], texts, faults] = lignes as [
    { n: number }[],
    { id: number; at: number }[],
    { textId: number; ruleKey: string; at: number; id: number }[],
  ];
  if (n > 0) return { statements: [], evenements: [] };

  // Fautes de chaque texte, par règle, dans l'ordre de leur première faute.
  const parTexte = new Map<number, Map<string, number>>();
  // Fautes de chaque règle, triées par date, pour la fenêtre du signalement.
  const parRegle = new Map<string, { at: number; textId: number }[]>();
  for (const f of faults) {
    let regles = parTexte.get(f.textId);
    if (!regles) parTexte.set(f.textId, (regles = new Map()));
    regles.set(f.ruleKey, (regles.get(f.ruleKey) ?? 0) + 1);
    const liste = parRegle.get(f.ruleKey);
    if (liste) liste.push(f);
    else parRegle.set(f.ruleKey, [f]);
  }
  const datesParRegle = new Map<string, number[]>();
  for (const [ruleKey, liste] of parRegle) {
    liste.sort((a, b) => a.at - b.at);
    datesParRegle.set(
      ruleKey,
      liste.map((f) => f.at),
    );
  }
  const datesTextes = texts.map((t) => t.at); // triées

  const etats = new EtatsEnMemoire([]);
  for (const text of texts) {
    for (const [ruleKey, count] of parTexte.get(text.id) ?? []) {
      if (!entreDansLeCycle({ ruleKey, counted: true })) continue;
      // Fautes des textes d'identifiant inférieur, dans la fenêtre (la logique
      // ne retient que celles datées au plus tard du texte).
      const liste = parRegle.get(ruleKey) ?? [];
      const dates = datesParRegle.get(ruleKey) ?? [];
      const previous: number[] = [];
      const debut = text.at - SEUILS.signalementFenetreJours * JOUR_MS;
      for (let i = apres(dates, debut); i < liste.length && liste[i].at <= text.at; i++) {
        if (liste[i].textId < text.id) previous.push(liste[i].at);
      }
      etats.applyFault(ruleKey, count, text.at, previous);
    }
    etats.checkAcquisitions(text.at, (depuis) =>
      datesTextes.slice(apres(datesTextes, depuis), apres(datesTextes, text.at)),
    );
  }
  return { statements: etats.statements().statements, evenements: etats.evenements };
}

/** Motif `LIKE … ESCAPE '\'` des identifiants par mot d'une règle de `REGLES_PAR_MOT`. */
export const motifParMot = (ruleKey: string) => `${ruleKey.replaceAll("_", "\\_")}\\_%`;

/**
 * États des règles de `REGLES_PAR_MOT` (identifiants par mot et règle
 * d'origine), à fusionner par la migration v3 (`fusionnerEtatsParMot`).
 */
export function requeteEtatsParMot(): Query {
  const cles = Object.keys(REGLES_PAR_MOT);
  return {
    sql: `SELECT ${SELECT_ETAT} FROM rule_states
          WHERE ${cles.map(() => "rule_key = ? OR rule_key LIKE ? ESCAPE '\\'").join(" OR ")}`,
    params: cles.flatMap((cle) => [cle, motifParMot(cle)]),
  };
}

/**
 * Fusionne les états de `requeteEtatsParMot` en un état par règle d'origine :
 * compteurs additionnés, première et dernière dates conservées, état et dates
 * d'état de la règle fautive le plus récemment. Calcul pur ; instructions du lot.
 */
export function fusionnerEtatsParMot(etats: readonly RuleState[]): Statement[] {
  const groupes = new Map<string, RuleState[]>();
  for (const etat of etats) {
    const cle = regleParMot(etat.ruleKey);
    if (!cle) continue;
    groupes.set(cle, [...(groupes.get(cle) ?? []), etat]);
  }
  const statements: Statement[] = [];
  for (const [ruleKey, groupe] of groupes) {
    if (groupe.length === 1 && groupe[0].ruleKey === ruleKey) continue;
    const recente = groupe.reduce((a, b) => (b.lastFaultAt > a.lastFaultAt ? b : a));
    const sollicitee = groupe.reduce((a, b) =>
      (b.lastSolicitedAt ?? -1) > (a.lastSolicitedAt ?? -1) ? b : a,
    );
    type Compteur =
      | "occurrences"
      | "tipsShown"
      | "choicesShown"
      | "choicesCorrect"
      | "choicesWrong"
      | "relapses";
    const somme = (champ: Compteur) => groupe.reduce((n, e) => n + e[champ], 0);
    const fusion: RuleState = {
      ruleKey,
      state: recente.state,
      stateSince: recente.stateSince,
      occurrences: somme("occurrences"),
      firstFaultAt: Math.min(...groupe.map((e) => e.firstFaultAt)),
      lastFaultAt: recente.lastFaultAt,
      tipsShown: somme("tipsShown"),
      choicesShown: somme("choicesShown"),
      choicesCorrect: somme("choicesCorrect"),
      choicesWrong: somme("choicesWrong"),
      lastSolicitedAt: sollicitee.lastSolicitedAt,
      solicitationsThatDay: sollicitee.solicitationsThatDay,
      acquiredAt: recente.acquiredAt,
      relapses: somme("relapses"),
    };
    statements.push(
      {
        sql: `DELETE FROM rule_states WHERE rule_key LIKE ? ESCAPE '\\'`,
        params: [motifParMot(ruleKey)],
      },
      { sql: SQL_SAUVER, params: CHAMPS_ETAT.map((c) => fusion[c]) },
    );
  }
  return statements;
}

/**
 * État des règles dans la base du journal : une ligne par règle
 * (`rule_states`) et l'historique daté des transitions et des sollicitations
 * (`rule_events`). Toute la logique est dans `src/analysis/regles/` et dans
 * les fonctions pures ci-dessus ; cette classe ne fait que lire et écrire par
 * le pilote.
 */
export class RuleStore {
  constructor(private driver: JournalDriver) {}

  /**
   * Enregistre la réponse à un choix à deux formes précis, une seule fois.
   * « unknown » : aucun choix ne porte cet identifiant. « conflict » : le choix
   * a déjà reçu sa réponse, ou un choix plus récent l'a remplacé pour la règle.
   */
  async answer(choiceId: number, correct: boolean, now: number): Promise<AnswerResult> {
    const lire = async () => {
      const [[choix], [{ n }], etats] = (await this.driver.readMany([
        {
          sql: "SELECT rule_key AS ruleKey FROM rule_events WHERE id = ? AND type = 'choix'",
          params: [choiceId],
        },
        // Les événements d'une règle se suivent : un choix est en attente tant
        // qu'aucun autre choix ni aucune réponse ne le suit.
        {
          sql: `SELECT COUNT(*) AS n FROM rule_events
                WHERE rule_key = (SELECT rule_key FROM rule_events WHERE id = ?1 AND type = 'choix')
                  AND id > ?1 AND type IN ${TYPES_CHOIX}`,
          params: [choiceId],
        },
        {
          sql: `SELECT ${SELECT_ETAT} FROM rule_states
                WHERE rule_key = (SELECT rule_key FROM rule_events WHERE id = ? AND type = 'choix')`,
          params: [choiceId],
        },
      ])) as [{ ruleKey: string }[], { n: number }[], RuleState[]];
      return { choix, n, state: etats[0] ?? null };
    };
    const { choix, n, state } = await lire();
    if (!choix) return "unknown";
    if (n > 0 || !state) return "conflict";

    const etats = new EtatsEnMemoire([state]);
    etats.apply(choix.ruleKey, { type: "reponse", correct }, {}, now, state);
    etats.log(choix.ruleKey, now, correct ? "reponse_juste" : "reponse_fausse");
    const { statements, nombreEtats } = etats.statements();
    // Garde : l'état n'est écrit que si le choix est toujours en attente ; sinon
    // `expectChanges` annule le lot entier (réponse concurrente).
    const garde = `SELECT ${placeholders(CHAMPS_ETAT.length)} WHERE NOT EXISTS (
      SELECT 1 FROM rule_events WHERE rule_key = ? AND id > ? AND type IN ${TYPES_CHOIX})`;
    const gardees = statements.map((st, i) =>
      i < nombreEtats
        ? {
            sql: `INSERT OR REPLACE INTO rule_states (${COLONNES_ETAT}) ${garde}`,
            params: [...(st.params ?? []), choix.ruleKey, choiceId],
            expectChanges: 1,
          }
        : st,
    );
    try {
      await this.driver.batch(gardees);
    } catch (error) {
      // `expectChanges` non respecté (« Conflit : », même erreur pour les deux
      // pilotes) : le choix a reçu sa réponse ou a été remplacé entre-temps.
      if (estConflit(error)) return "conflict";
      throw error;
    }
    return "recorded";
  }

  /**
   * Question de révision à poser à `now` (issue #62), ou null si aucune règle
   * n'est due. La question est journalisée (événement « revision ») et compte
   * comme la sollicitation du jour pour la règle. Elle porte sur une phrase
   * d'exemple : rien du texte de l'utilisateur n'est lu ni écrit.
   */
  async revision(
    now: number,
    random: () => number = Math.random,
  ): Promise<QuestionRevision | null> {
    const [states, justes] = (await this.driver.readMany([
      { sql: `SELECT ${SELECT_ETAT} FROM rule_states WHERE state IN ('signalee', 'travaillee')` },
      {
        sql: `SELECT e.rule_key AS ruleKey, COUNT(*) AS n FROM rule_events e
              JOIN rule_states s ON s.rule_key = e.rule_key
              WHERE e.type = 'revision_juste' AND e.created_at > s.last_fault_at
              GROUP BY e.rule_key`,
      },
    ])) as [RuleState[], { ruleKey: string; n: number }[]];
    const parRegle = new Map(justes.map((j) => [j.ruleKey, j.n]));
    const proposee = choisirRevision(states, (k) => parRegle.get(k) ?? 0, now, random);
    if (!proposee) return null;

    const etats = new EtatsEnMemoire(states);
    etats.apply(proposee.ruleKey, { type: "revision" }, {}, now);
    const rang = etats.log(proposee.ruleKey, now, "revision");
    const { statements, nombreEtats } = etats.statements();
    const resultats = await this.driver.batch(statements);
    return { ...proposee, reviewId: Number(resultats[nombreEtats + rang].lastInsertRowid) };
  }

  /**
   * Enregistre la réponse à une question de révision précise, une seule fois.
   * « unknown » : aucune question ne porte cet identifiant. « conflict » : elle
   * a déjà reçu sa réponse.
   */
  async answerRevision(reviewId: number, correct: boolean, now: number): Promise<AnswerResult> {
    const [[question], [{ n }]] = (await this.driver.readMany([
      {
        sql: "SELECT rule_key AS ruleKey FROM rule_events WHERE id = ? AND type = 'revision'",
        params: [reviewId],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM rule_events
              WHERE rule_key = (SELECT rule_key FROM rule_events WHERE id = ?1 AND type = 'revision')
                AND id > ?1 AND type IN ('revision', 'revision_juste', 'revision_fausse')`,
        params: [reviewId],
      },
    ])) as [{ ruleKey: string }[], { n: number }[]];
    if (!question) return "unknown";
    if (n > 0) return "conflict";
    await this.driver.batch([
      {
        sql: SQL_JOURNALISER,
        params: [question.ruleKey, now, correct ? "revision_juste" : "revision_fausse", null, null],
      },
    ]);
    return "recorded";
  }

  /** Toutes les règles suivies, de la plus récemment fautive à la plus ancienne. */
  async list(): Promise<RuleView[]> {
    const [states, dernieres, emplois] = await this.driver.readMany(REQUETES_LISTE);
    return vueRegles(
      states as RuleState[],
      dernieres as DerniereFaute[],
      emplois as { ruleKey: string; n: number }[],
    );
  }

  /** Historique daté, du plus récent au plus ancien ; toutes les règles sans `ruleKey`. */
  async events(options: { limit?: number; ruleKey?: string } = {}): Promise<RuleHistoryEntry[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1000);
    return this.driver.read<RuleHistoryEntry>(
      `SELECT id, rule_key AS ruleKey, created_at AS at, type,
              from_state AS "from", to_state AS "to"
       FROM rule_events WHERE (?1 IS NULL OR rule_key = ?1) ORDER BY id DESC LIMIT ?2`,
      [options.ruleKey || null, limit],
    );
  }
}

/** Lectures de la liste des règles : états et dernière faute de chaque règle. */
export const REQUETES_LISTE: readonly Query[] = [
  { sql: `SELECT ${SELECT_ETAT} FROM rule_states ORDER BY last_fault_at DESC, rule_key` },
  {
    sql: `SELECT ${SELECT_DERNIERE} FROM faults
          WHERE id IN (SELECT MAX(id) FROM faults
                       WHERE rule_key IN (SELECT rule_key FROM rule_states) GROUP BY rule_key)`,
  },
  {
    sql: `SELECT e.rule_key AS ruleKey, COUNT(*) AS n FROM rule_events e
          JOIN rule_states s ON s.rule_key = e.rule_key
          WHERE e.type = 'emploi' AND e.created_at > s.last_fault_at
          GROUP BY e.rule_key`,
  },
];

export function vueRegles(
  states: RuleState[],
  dernieres: DerniereFaute[],
  emplois: { ruleKey: string; n: number }[] = [],
): RuleView[] {
  const parRegle = new Map(dernieres.map((f) => [f.ruleKey, f]));
  const emploisParRegle = new Map(emplois.map((e) => [e.ruleKey, e.n]));
  return states.map((state) => ({
    ...state,
    ...libelle(state.ruleKey, parRegle.get(state.ruleKey)),
    fiche: FICHES[state.ruleKey] ?? null,
    correctUses: detecteEmplois(state.ruleKey) ? (emploisParRegle.get(state.ruleKey) ?? 0) : null,
  }));
}

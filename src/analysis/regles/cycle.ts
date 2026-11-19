/**
 * Cycle de vie d'une règle : observée → signalée → travaillée → acquise, avec
 * retour à « signalée » en cas de rechute.
 *
 * Logique pure : un état, un événement, les faits utiles (contexte) et
 * l'heure donnent le nouvel état et les transitions franchies. Aucun accès à
 * la base ni à l'horloge du système : le journal fournit les faits, les tests
 * et les écrans de synthèse peuvent rejouer la même logique.
 */
import { JOUR_MS, REGLES_HORS_CYCLE, SEUILS, type Seuils } from "./seuils";

export const ETATS_CYCLE = ["observee", "signalee", "travaillee", "acquise"] as const;
export type EtatCycle = (typeof ETATS_CYCLE)[number];

/** État conservé pour une règle (`rule_key` du journal). Dates en millisecondes. */
export interface RuleState {
  ruleKey: string;
  state: EtatCycle;
  /** Date d'entrée dans l'état courant. */
  stateSince: number;
  /** Nombre total de fautes sur la règle. */
  occurrences: number;
  firstFaultAt: number;
  lastFaultAt: number;
  /** Astuces affichées depuis la dernière entrée en « signalée ». */
  tipsShown: number;
  /** Choix à deux formes proposés sur le bouton Copier, et réponses données. */
  choicesShown: number;
  choicesCorrect: number;
  choicesWrong: number;
  /** Dernière sollicitation (astuce ou choix). */
  lastSolicitedAt: number | null;
  /** Nombre de sollicitations le jour de `lastSolicitedAt`. */
  solicitationsThatDay: number;
  /** Date d'acquisition ; null tant que la règle n'est pas « acquise ». */
  acquiredAt: number | null;
  /** Nombre de rechutes (faute après acquisition). */
  relapses: number;
}

/** Ce qui arrive à une règle. */
export type RuleEvent =
  /** Un texte corrigé contient `count` faute(s) sur la règle. */
  | { type: "faute"; count: number }
  /** Un texte a été corrigé sans faute sur la règle. */
  | { type: "usage" }
  /** Une astuce a été affichée près du bouton Copier. */
  | { type: "astuce" }
  /** Le choix à deux formes a été proposé sur le bouton Copier. */
  | { type: "choix" }
  /** L'utilisateur a cliqué l'une des deux formes. */
  | { type: "reponse"; correct: boolean };

/** Faits fournis par le journal ; la logique applique elle-même les seuils. */
export interface RuleContext {
  /** Dates des fautes déjà journalisées sur la règle, avant cet événement. */
  previousFaultTimes?: number[];
  /** Nombre d'autres règles actuellement « travaillées ». */
  otherWorkedRules?: number;
  /** Dates des textes corrigés depuis la dernière faute, texte courant compris. */
  textTimesSinceLastFault?: number[];
}

/** Type d'une transition : l'état atteint, ou « rechute » (acquise → signalée). */
export type TransitionType = EtatCycle | "rechute";

export interface Transition {
  ruleKey: string;
  at: number;
  type: TransitionType;
  /** null à la création de la règle. */
  from: EtatCycle | null;
  to: EtatCycle;
}

interface TransitionResult {
  state: RuleState;
  transitions: Transition[];
}

/**
 * Vrai si une faute entre dans le cycle de vie : elle doit être classée et
 * comptée dans la note (orthographe, grammaire), sur une règle suivie.
 */
export function entreDansLeCycle(fault: { ruleKey: string; counted: boolean }): boolean {
  return fault.counted && !REGLES_HORS_CYCLE.includes(fault.ruleKey);
}

/** Jour calendaire local, pour « une sollicitation par jour » et les jours d'usage. */
export function jourLocal(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Vrai si la règle a déjà été sollicitée le jour calendaire de `now`. */
function solliciteeCeJour(state: RuleState, now: number): boolean {
  return state.lastSolicitedAt !== null && jourLocal(state.lastSolicitedAt) === jourLocal(now);
}

/** Vrai si le budget du jour autorise encore une astuce ou un choix pour la règle. */
export function peutSolliciter(state: RuleState, now: number, seuils: Seuils = SEUILS): boolean {
  return (
    !solliciteeCeJour(state, now) ||
    state.solicitationsThatDay < seuils.sollicitationsParRegleEtParJour
  );
}

/** Nombre de règles dans chaque état du cycle, dans l'ordre de `ETATS_CYCLE`. */
export function compterEtats(rules: readonly { state: EtatCycle }[]): Record<EtatCycle, number> {
  const counts = Object.fromEntries(ETATS_CYCLE.map((etat) => [etat, 0]));
  for (const rule of rules) counts[rule.state]++;
  return counts as Record<EtatCycle, number>;
}

function nouvelEtat(ruleKey: string, now: number): RuleState {
  return {
    ruleKey,
    state: "observee",
    stateSince: now,
    occurrences: 0,
    firstFaultAt: now,
    lastFaultAt: now,
    tipsShown: 0,
    choicesShown: 0,
    choicesCorrect: 0,
    choicesWrong: 0,
    lastSolicitedAt: null,
    solicitationsThatDay: 0,
    acquiredAt: null,
    relapses: 0,
  };
}

function solliciter(state: RuleState, now: number): RuleState {
  return {
    ...state,
    lastSolicitedAt: now,
    solicitationsThatDay: solliciteeCeJour(state, now) ? state.solicitationsThatDay + 1 : 1,
  };
}

/**
 * Applique un événement à l'état d'une règle.
 *
 * `state` vaut null pour une règle jamais vue : seul l'événement « faute » la
 * crée, les autres renvoient alors null. `now` est l'heure de l'événement
 * (horloge injectée). L'état reçu n'est jamais modifié.
 */
export function appliquerEvenement(
  ruleKey: string,
  state: RuleState | null,
  event: RuleEvent,
  context: RuleContext,
  now: number,
  seuils: Seuils = SEUILS,
): TransitionResult | null {
  const transitions: Transition[] = [];
  const passer = (current: RuleState, to: EtatCycle, type: TransitionType = to): RuleState => {
    transitions.push({ ruleKey, at: now, type, from: current.state, to });
    return { ...current, state: to, stateSince: now };
  };

  if (event.type === "faute") {
    if (event.count <= 0) return state ? { state, transitions } : null;
    let next: RuleState;
    if (state) {
      next = { ...state };
    } else {
      next = nouvelEtat(ruleKey, now);
      transitions.push({ ruleKey, at: now, type: "observee", from: null, to: "observee" });
    }
    next.occurrences += event.count;
    next.lastFaultAt = now;

    if (next.state === "observee") {
      const debut = now - seuils.signalementFenetreJours * JOUR_MS;
      const recentes =
        (context.previousFaultTimes ?? []).filter((t) => t > debut && t <= now).length +
        event.count;
      if (recentes >= seuils.signalementOccurrences) {
        next = { ...passer(next, "signalee"), tipsShown: 0 };
      }
    } else if (next.state === "signalee") {
      const placeLibre = (context.otherWorkedRules ?? 0) < seuils.travailleesMax;
      if (next.tipsShown >= seuils.astucesAvantTravail && placeLibre) {
        next = passer(next, "travaillee");
      }
    } else if (next.state === "acquise") {
      next = {
        ...passer(next, "signalee", "rechute"),
        tipsShown: 0,
        acquiredAt: null,
        relapses: next.relapses + 1,
      };
    }
    return { state: next, transitions };
  }

  if (!state) return null;

  switch (event.type) {
    case "usage": {
      if (state.state !== "signalee" && state.state !== "travaillee") break;
      if (now - state.lastFaultAt < seuils.acquisitionJoursSansFaute * JOUR_MS) break;
      const textes = (context.textTimesSinceLastFault ?? []).filter(
        (t) => t > state.lastFaultAt && t <= now,
      );
      const jours = new Set(textes.map(jourLocal));
      if (
        textes.length >= seuils.acquisitionTextesMin &&
        jours.size >= seuils.acquisitionJoursActifsMin
      ) {
        return { state: { ...passer(state, "acquise"), acquiredAt: now }, transitions };
      }
      break;
    }
    case "astuce":
      return {
        state: { ...solliciter(state, now), tipsShown: state.tipsShown + 1 },
        transitions,
      };
    case "choix":
      return {
        state: { ...solliciter(state, now), choicesShown: state.choicesShown + 1 },
        transitions,
      };
    case "reponse":
      return {
        state: event.correct
          ? { ...state, choicesCorrect: state.choicesCorrect + 1 }
          : { ...state, choicesWrong: state.choicesWrong + 1 },
        transitions,
      };
  }
  return { state, transitions };
}

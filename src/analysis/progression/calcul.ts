/**
 * Calcul de l'écran « Progression » à partir du journal.
 *
 * Logique pure : des lignes du journal et l'heure (horloge injectée) donnent
 * tout ce qu'affiche l'écran. Aucun accès à la base ni à l'horloge du système,
 * pour que les tests puissent rejouer n'importe quelle situation. Les
 * semaines commencent le lundi à minuit, heure locale de la machine qui
 * exécute le calcul (le serveur web, ou l'ordinateur pour l'application de
 * bureau).
 *
 * L'état des règles est repris tel qu'il est enregistré : l'état « acquise »
 * n'est réévalué qu'au moment d'une analyse (`POST /api/analyze`).
 */
import { compterEtats, type EtatCycle } from "../regles/cycle";
import { libelleSansFiche } from "../fiches";
import { noteSur20 } from "../score";
import { PROGRESSION } from "./reglages";

/** Un texte corrigé (table `texts`). */
export interface LigneTexte {
  at: number;
  words: number;
  faults: number;
}

/** Une faute comptée dans la note (table `faults`, `counted = 1`). */
export interface LigneFaute {
  at: number;
  ruleKey: string;
  /** Libellé fixe de la règle (`rule_labels`) ; null s'il est inconnu. */
  label: string | null;
  categoryName: string;
}

/** Une règle suivie, telle que la renvoie `Journal.rules()`. */
export interface RegleSuivie {
  ruleKey: string;
  label: string;
  categoryName: string;
  state: EtatCycle;
  stateSince: number;
  occurrences: number;
  lastFaultAt: number;
  acquiredAt: number | null;
}

interface EntreeProgression {
  texts: LigneTexte[];
  /** Fautes comptées depuis le début de la première semaine affichée. */
  faults: LigneFaute[];
  rules: RegleSuivie[];
}

/** Agrégat d'un ensemble de textes. */
interface Volume {
  texts: number;
  words: number;
  faults: number;
  /** Note sur 20 ; null sans aucun mot. */
  score: number | null;
  /** Fautes pour 100 mots ; null sans aucun mot. */
  faultsPer100: number | null;
}

export interface Semaine extends Volume {
  /** Lundi 0 h (heure locale), en millisecondes. */
  start: number;
  /** Lundi suivant 0 h, exclu. */
  end: number;
}

export type Tendance = "baisse" | "hausse" | "stable";

interface ScoreMaitrise {
  /** Score de 0 à 100 ; null tant qu'il n'y a pas assez de textes récents. */
  score: number | null;
  /** Libellé du palier (« Bonne maîtrise »…) ; null sans score. */
  level: string | null;
  /** Qualité récente sur 100 (note récente ramenée sur 100) ; null sans mot récent. */
  quality: number | null;
  /** Part des règles acquises sur 100 ; null si aucune règle n'est entrée dans le cycle. */
  rulesShare: number | null;
  /** Règles acquises et règles entrées dans le cycle (signalées, travaillées, acquises). */
  acquired: number;
  inCycle: number;
  /** Ce qui a été corrigé sur la fenêtre récente, et le minimum exigé. */
  recent: { texts: number; words: number };
  minimum: { texts: number; words: number };
  weights: { quality: number; rules: number };
  recentWeeks: number;
}

/** Règle affichée dans les listes de l'écran (champs de `RegleSuivie` seulement). */
export type RegleResumee = RegleSuivie;

interface RegleFrequente {
  ruleKey: string;
  label: string;
  categoryName: string;
  count: number;
  /** État dans le cycle ; null pour une règle hors cycle. */
  state: EtatCycle | null;
}

/** Réponse de `GET /api/progress`. */
export interface Progression {
  generatedAt: number;
  /** Vrai quand le journal ne contient aucun texte. */
  empty: boolean;
  weeks: number;
  /** Début de la première semaine affichée. */
  since: number;
  mastery: ScoreMaitrise;
  /** Depuis le premier texte du journal. */
  totals: Volume;
  /** Semaines affichées. */
  period: Volume;
  /** Semaines récentes et semaines d'avant, de même durée. */
  recent: Volume;
  previous: Volume;
  /** Tendance des fautes pour 100 mots ; null si l'une des deux périodes n'a aucun mot. */
  trend: Tendance | null;
  series: Semaine[];
  rules: {
    counts: Record<EtatCycle, number>;
    /** Règles signalées ou travaillées, les plus récemment fautives d'abord. */
    active: RegleResumee[];
    /** Règles acquises, les plus récemment acquises d'abord. */
    acquired: RegleResumee[];
  };
  frequentRules: RegleFrequente[];
}

const arrondi = (n: number, chiffres = 1) => {
  const p = 10 ** chiffres;
  return Math.round(n * p) / p;
};

/** Lundi 0 h (heure locale) de la semaine contenant `timestamp`. */
export function debutSemaine(timestamp: number): number {
  const d = new Date(timestamp);
  const decalage = (d.getDay() + 6) % 7; // lundi = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - decalage).getTime();
}

/** Lundi 0 h situé `n` semaines après (ou avant si négatif) le lundi donné. */
function decalerSemaines(lundi: number, n: number): number {
  const d = new Date(lundi);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * n).getTime();
}

/** Début de la première semaine affichée : les fautes plus anciennes ne servent pas. */
export function debutPremiereSemaine(now: number): number {
  return decalerSemaines(debutSemaine(now), -(PROGRESSION.semainesAffichees - 1));
}

/** Agrège des textes :mots et fautes sont additionnés avant de calculer la note. */
export function volume(texts: LigneTexte[]): Volume {
  let words = 0;
  let faults = 0;
  for (const t of texts) {
    words += t.words;
    faults += t.faults;
  }
  return {
    texts: texts.length,
    words,
    faults,
    score: noteSur20(faults, words),
    faultsPer100: words > 0 ? arrondi((faults / words) * 100, 2) : null,
  };
}

/** Compare les fautes pour 100 mots : moins de fautes, c'est une « baisse ». */
export function tendance(recent: Volume, previous: Volume): Tendance | null {
  if (recent.faultsPer100 === null || previous.faultsPer100 === null) return null;
  const ecart = recent.faultsPer100 - previous.faultsPer100;
  if (Math.abs(ecart) < PROGRESSION.ecartTendanceStable) return "stable";
  return ecart < 0 ? "baisse" : "hausse";
}

/** Libellé du palier correspondant à un score. */
export function palier(score: number): string {
  const trouve = PROGRESSION.paliers.find((p) => score >= p.minimum);
  return (trouve ?? PROGRESSION.paliers[PROGRESSION.paliers.length - 1]).libelle;
}

/**
 * Score de maîtrise : voir la formule dans `reglages.ts`. `recent` est le
 * volume des semaines récentes, `rules` l'état enregistré des règles.
 */
export function scoreMaitrise(recent: Volume, rules: RegleSuivie[]): ScoreMaitrise {
  const acquired = rules.filter((r) => r.state === "acquise").length;
  const inCycle = rules.filter((r) => r.state !== "observee").length;
  const quality = recent.score === null ? null : recent.score / 20;
  const share = inCycle > 0 ? acquired / inCycle : null;
  const assez =
    recent.texts >= PROGRESSION.minimumTextesRecents &&
    recent.words >= PROGRESSION.minimumMotsRecents;

  let score: number | null = null;
  if (assez && quality !== null) {
    const valeur =
      share === null
        ? quality
        : PROGRESSION.poidsQualite * quality + PROGRESSION.poidsRegles * share;
    score = Math.round(100 * valeur);
  }
  return {
    score,
    level: score === null ? null : palier(score),
    quality: quality === null ? null : Math.round(100 * quality),
    rulesShare: share === null ? null : Math.round(100 * share),
    acquired,
    inCycle,
    recent: { texts: recent.texts, words: recent.words },
    minimum: {
      texts: PROGRESSION.minimumTextesRecents,
      words: PROGRESSION.minimumMotsRecents,
    },
    weights: { quality: PROGRESSION.poidsQualite, rules: PROGRESSION.poidsRegles },
    recentWeeks: PROGRESSION.semainesRecentes,
  };
}

/** Ne garde que les champs de `RegleSuivie` (une `RuleView` en porte davantage). */
function resumer(r: RegleSuivie): RegleResumee {
  return {
    ruleKey: r.ruleKey,
    label: r.label,
    categoryName: r.categoryName,
    state: r.state,
    stateSince: r.stateSince,
    occurrences: r.occurrences,
    lastFaultAt: r.lastFaultAt,
    acquiredAt: r.acquiredAt,
  };
}

/**
 * Règles les plus fréquentes, hors fautes de frappe : la détection générique
 * « faute de frappe possible » n'est pas une règle à apprendre (voir
 * `REGLES_HORS_CYCLE`).
 */
export function reglesFrequentes(faults: LigneFaute[], rules: RegleSuivie[]): RegleFrequente[] {
  const parCle = new Map(rules.map((r) => [r.ruleKey, r]));
  const compte = new Map<string, { count: number; last: LigneFaute }>();
  for (const f of faults) {
    if (f.ruleKey === PROGRESSION.regleOrthographe) continue;
    const c = compte.get(f.ruleKey);
    if (!c) compte.set(f.ruleKey, { count: 1, last: f });
    else {
      c.count++;
      if (f.at >= c.last.at) c.last = f;
    }
  }
  return [...compte.entries()]
    .map(([ruleKey, { count, last }]) => {
      const suivie = parCle.get(ruleKey);
      return {
        ruleKey,
        label: suivie?.label ?? libelleSansFiche(ruleKey, last),
        categoryName: suivie?.categoryName ?? last.categoryName,
        count,
        state: suivie?.state ?? null,
      };
    })
    .sort((a, b) => b.count - a.count || a.ruleKey.localeCompare(b.ruleKey))
    .slice(0, PROGRESSION.reglesFrequentesMax);
}

/** Tout l'écran « Progression » en un seul calcul. */
export function calculerProgression(entree: EntreeProgression, now: number): Progression {
  const courante = debutSemaine(now);
  const n = PROGRESSION.semainesAffichees;
  const r = PROGRESSION.semainesRecentes;
  const since = debutPremiereSemaine(now);
  const finCourante = decalerSemaines(courante, 1);
  const debutRecent = decalerSemaines(courante, -(r - 1));
  const debutPrecedent = decalerSemaines(courante, -(2 * r - 1));

  // Un texte daté dans le futur (horloge déréglée) reste compté dans le total
  // mais pas dans les semaines.
  const entre = (debut: number, fin: number) =>
    entree.texts.filter((t) => t.at >= debut && t.at < fin);

  const series: Semaine[] = [];
  for (let i = 0; i < n; i++) {
    const start = decalerSemaines(since, i);
    const end = decalerSemaines(since, i + 1);
    series.push({ start, end, ...volume(entre(start, end)) });
  }

  const recent = volume(entre(debutRecent, finCourante));
  const previous = volume(entre(debutPrecedent, debutRecent));
  const faults = entree.faults.filter((f) => f.at >= since && f.at < finCourante);

  const active = entree.rules
    .filter((x) => x.state === "signalee" || x.state === "travaillee")
    .sort((a, b) => b.lastFaultAt - a.lastFaultAt || a.ruleKey.localeCompare(b.ruleKey))
    .map(resumer);
  const acquired = entree.rules
    .filter((x) => x.state === "acquise")
    .sort(
      (a, b) =>
        (b.acquiredAt ?? b.stateSince) - (a.acquiredAt ?? a.stateSince) ||
        a.ruleKey.localeCompare(b.ruleKey),
    )
    .map(resumer);

  return {
    generatedAt: now,
    empty: entree.texts.length === 0,
    weeks: n,
    since,
    mastery: scoreMaitrise(recent, entree.rules),
    totals: volume(entree.texts),
    period: volume(entre(since, finCourante)),
    recent,
    previous,
    trend: tendance(recent, previous),
    series,
    rules: { counts: compterEtats(entree.rules), active, acquired },
    frequentRules: reglesFrequentes(faults, entree.rules),
  };
}

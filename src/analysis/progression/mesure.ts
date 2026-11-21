/**
 * « Ce que ça change » : la faute revient-elle moins souvent après la
 * première astuce ? (issue #33)
 *
 * Logique pure : les lignes du journal donnent, règle par règle, le taux de
 * fautes avant et depuis la première intervention, et le même calcul pour un
 * groupe de comparaison qui ne reçoit jamais d'intervention. Aucune date
 * calendaire n'intervient (seulement des écarts en millisecondes) : le
 * résultat ne dépend pas du fuseau horaire.
 *
 * Aucun test statistique : seulement des chiffres et leurs volumes. Ce n'est
 * pas une preuve (peu de textes, pas de tirage au sort) ; l'écran et l'export
 * le disent.
 *
 * Règles suivies — toute règle qui a reçu au moins une intervention. Le pivot
 * est la date de la première astuce (ou du premier choix à deux formes, s'il
 * n'y a jamais eu d'astuce). « Avant » : fautes de la règle jusqu'au pivot
 * compris (l'astuce s'affiche après la correction du texte fautif), sur les
 * mots écrits entre la première faute de la règle et le pivot. « Depuis » :
 * fautes et mots après le pivot.
 *
 * Groupe de comparaison — les fautes comptées qui ne reçoivent jamais
 * d'intervention : les règles hors cycle (`REGLES_HORS_CYCLE`, les fautes de
 * frappe). Leur pivot est le moment où elles remplissent le même critère de
 * signalement que les règles suivies (`signalementOccurrences` fautes en
 * `signalementFenetreJours` jours) : les deux groupes sont choisis au même
 * moment de « pic », ce qui neutralise en partie le retour naturel à la
 * moyenne (une faute qui vient de revenir trois fois revient souvent moins
 * ensuite, astuce ou pas).
 *
 * Les règles suivies qui ont atteint le critère sans jamais être sollicitées
 * ne servent PAS de comparaison : une seule intervention est proposée par
 * texte, et une règle signalée est sollicitée dès sa faute suivante. Une
 * règle signalée jamais sollicitée est donc, presque toujours, une règle dont
 * la faute n'est jamais revenue : ce groupe serait choisi sur son résultat et
 * montrerait une baisse trompeuse.
 */
import type { EtatCycle } from "../regles/cycle";
import {
  JOUR_MS,
  REGLE_ORTHOGRAPHE,
  REGLES_HORS_CYCLE,
  SEUILS,
  type Seuils,
} from "../regles/seuils";
import { MESURE, PROGRESSION } from "./reglages";

/** Un texte corrigé. */
export interface TexteMesure {
  at: number;
  words: number;
}

/** Une faute comptée dans la note. */
export interface FauteMesure {
  at: number;
  ruleKey: string;
  categoryId: string;
}

/** Un événement de l'historique des règles (`rule_events`), dans l'ordre d'écriture. */
export interface EvenementMesure {
  ruleKey: string;
  at: number;
  type: string;
}

export interface EntreeMesure {
  texts: readonly TexteMesure[];
  /** Fautes comptées seulement (`counted = 1`). */
  faults: readonly FauteMesure[];
  events: readonly EvenementMesure[];
  /** État actuel de chaque règle suivie ; son libellé, pour l'écran seulement. */
  states: readonly { ruleKey: string; state: EtatCycle; label?: string }[];
}

/** Volume d'une période et son taux. */
export interface Periode {
  textes: number;
  mots: number;
  fautes: number;
  /** Fautes pour `MESURE.motsParTaux` mots, arrondi au dixième ; null sans mot. */
  taux: number | null;
}

export type Groupe = "suivie" | "comparaison";

export interface MesureRegle {
  ruleKey: string;
  /** Nom lisible, pour l'écran (jamais exporté) : libellé de la règle, sinon sa clé. */
  label: string;
  /** Catégorie du moteur de la dernière faute. */
  categoryId: string;
  groupe: Groupe;
  /** État dans le cycle ; null hors cycle. */
  etat: EtatCycle | null;
  /** Première intervention (suivie) ou critère de signalement atteint (comparaison). */
  pivot: number;
  avant: Periode;
  depuis: Periode;
  /** Vrai quand les deux périodes atteignent le volume minimal : les taux sont alors comparables. */
  suffisant: boolean;
  /** Période « avant » trop courte : elle ne s'allongera plus. */
  avantTropCourt: boolean;
  /** Textes qu'il faudrait encore écrire pour que « depuis » soit suffisant (0 si c'est le cas). */
  textesManquants: number;
  /** Évolution relative du taux, en % (négatif : baisse) ; null si non suffisant. */
  evolution: number | null;
  astuces: number;
  choix: number;
  reponsesJustes: number;
  reponsesFausses: number;
  rechutes: number;
  /** Première acquisition ; null si la règle n'a jamais été acquise. */
  acquiseLe: number | null;
}

export interface SyntheseGroupe {
  /** Règles du groupe, et celles dont le volume suffit (seules additionnées). */
  regles: number;
  reglesSuffisantes: number;
  /** Somme des fautes et des mots des règles suffisantes, période par période. */
  avant: Periode;
  depuis: Periode;
  evolution: number | null;
}

export interface Mesure {
  /** Unité des taux, en mots (1 000). */
  motsParTaux: number;
  minimum: {
    avant: { textes: number; mots: number };
    depuis: { textes: number; mots: number };
  };
  /** Premier texte corrigé ; null si le journal est vide. */
  premierTexte: number | null;
  suivies: MesureRegle[];
  comparaison: MesureRegle[];
  synthese: { suivies: SyntheseGroupe; comparaison: SyntheseGroupe };
  /** Choix à deux formes : réponses justes, fausses, et taux de bonnes réponses en %. */
  choix: { justes: number; fausses: number; taux: number | null };
  /** Règles acquises au moins une fois, et celles qui n'ont jamais rechuté depuis. */
  acquises: { total: number; restees: number; rechutes: number };
}

const arrondi = (n: number, chiffres = 1) => {
  const p = 10 ** chiffres;
  return Math.round(n * p) / p;
};

/** Taux de `fautes` pour `MESURE.motsParTaux` mots. */
export function taux(fautes: number, mots: number): number | null {
  return mots > 0 ? arrondi((fautes / mots) * MESURE.motsParTaux) : null;
}

/**
 * Évolution relative du taux de `avant` à `depuis`, en % entier (négatif :
 * baisse), calculée sur les nombres exacts ; null si l'une des périodes n'a
 * aucun mot ou si « avant » n'a aucune faute.
 */
export function evolution(
  avant: Pick<Periode, "fautes" | "mots">,
  depuis: Pick<Periode, "fautes" | "mots">,
): number | null {
  if (avant.mots <= 0 || depuis.mots <= 0 || avant.fautes <= 0) return null;
  const a = avant.fautes / avant.mots;
  const d = depuis.fautes / depuis.mots;
  return Math.round(((d - a) / a) * 100);
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

/** Première position de `valeurs` (triées) supérieure ou égale à `x`. */
function aPartirDe(valeurs: readonly number[], x: number): number {
  let bas = 0;
  let haut = valeurs.length;
  while (bas < haut) {
    const milieu = (bas + haut) >>> 1;
    if (valeurs[milieu] < x) bas = milieu + 1;
    else haut = milieu;
  }
  return bas;
}

/**
 * Date à laquelle une suite de fautes (triées) remplit le critère de
 * signalement : `signalementOccurrences` fautes dans une fenêtre glissante de
 * `signalementFenetreJours` jours (même règle que `cycle.ts`). Null sinon.
 */
export function dateCritere(dates: readonly number[], seuils: Seuils = SEUILS): number | null {
  const fenetre = seuils.signalementFenetreJours * JOUR_MS;
  for (let i = 0; i < dates.length; i++) {
    // Fautes de la fenêtre ]t − fenêtre, t], celles du même texte comprises.
    const fin = apres(dates, dates[i]);
    const debut = apres(dates, dates[i] - fenetre);
    if (fin - debut >= seuils.signalementOccurrences) return dates[i];
  }
  return null;
}

/** Calcule la mesure. `seuils` : ceux du cycle (critère de signalement). */
export function calculerMesure(entree: EntreeMesure, seuils: Seuils = SEUILS): Mesure {
  const textes = [...entree.texts].sort((a, b) => a.at - b.at);
  const datesTextes = textes.map((t) => t.at);
  // Mots cumulés : motsCumules[i] = mots des i premiers textes.
  const motsCumules = [0];
  for (const t of textes) motsCumules.push(motsCumules[motsCumules.length - 1] + t.words);
  const motsMoyens =
    textes.length > 0 ? motsCumules[motsCumules.length - 1] / textes.length : MESURE.motsParTaux;

  /** Textes de l'intervalle [debut, fin] (bornes en positions de `textes`). */
  const volumeTextes = (i: number, j: number) => ({
    textes: Math.max(0, j - i),
    mots: j > i ? motsCumules[j] - motsCumules[i] : 0,
  });

  const fautesParRegle = new Map<string, FauteMesure[]>();
  for (const f of entree.faults) {
    const liste = fautesParRegle.get(f.ruleKey);
    if (liste) liste.push(f);
    else fautesParRegle.set(f.ruleKey, [f]);
  }

  interface Historique {
    premiereAstuce: number | null;
    premierChoix: number | null;
    astuces: number;
    choix: number;
    justes: number;
    fausses: number;
    rechutes: number;
    acquiseLe: number | null;
  }
  const historiques = new Map<string, Historique>();
  for (const e of entree.events) {
    let h = historiques.get(e.ruleKey);
    if (!h) {
      h = {
        premiereAstuce: null,
        premierChoix: null,
        astuces: 0,
        choix: 0,
        justes: 0,
        fausses: 0,
        rechutes: 0,
        acquiseLe: null,
      };
      historiques.set(e.ruleKey, h);
    }
    switch (e.type) {
      case "astuce":
        h.astuces++;
        h.premiereAstuce = Math.min(h.premiereAstuce ?? e.at, e.at);
        break;
      case "choix":
        h.choix++;
        h.premierChoix = Math.min(h.premierChoix ?? e.at, e.at);
        break;
      case "reponse_juste":
        h.justes++;
        break;
      case "reponse_fausse":
        h.fausses++;
        break;
      case "rechute":
        h.rechutes++;
        break;
      case "acquise":
        h.acquiseLe = Math.min(h.acquiseLe ?? e.at, e.at);
        break;
    }
  }
  const etats = new Map(entree.states.map((s) => [s.ruleKey, s]));

  const mesurer = (ruleKey: string, groupe: Groupe, pivot: number): MesureRegle => {
    const fautes = (fautesParRegle.get(ruleKey) ?? []).slice().sort((a, b) => a.at - b.at);
    const dates = fautes.map((f) => f.at);
    const premiere = dates.length > 0 ? Math.min(dates[0], pivot) : pivot;
    const fautesAvant = apres(dates, pivot);
    const iPivot = apres(datesTextes, pivot);
    const avantVolume = volumeTextes(aPartirDe(datesTextes, premiere), iPivot);
    const depuisVolume = volumeTextes(iPivot, textes.length);
    const avant: Periode = {
      ...avantVolume,
      fautes: fautesAvant,
      taux: taux(fautesAvant, avantVolume.mots),
    };
    const depuis: Periode = {
      ...depuisVolume,
      fautes: dates.length - fautesAvant,
      taux: taux(dates.length - fautesAvant, depuisVolume.mots),
    };
    const avantTropCourt =
      avant.textes < MESURE.avantMinimumTextes || avant.mots < MESURE.avantMinimumMots;
    const textesManquants = Math.max(
      0,
      MESURE.depuisMinimumTextes - depuis.textes,
      Math.ceil((MESURE.depuisMinimumMots - depuis.mots) / Math.max(1, motsMoyens)),
    );
    const suffisant = !avantTropCourt && textesManquants === 0;
    const h = historiques.get(ruleKey);
    return {
      ruleKey,
      categoryId: fautes.length > 0 ? fautes[fautes.length - 1].categoryId : "",
      groupe,
      label:
        ruleKey === REGLE_ORTHOGRAPHE
          ? PROGRESSION.libelleOrthographe
          : (etats.get(ruleKey)?.label ?? ruleKey),
      etat: etats.get(ruleKey)?.state ?? null,
      pivot,
      avant,
      depuis,
      suffisant,
      avantTropCourt,
      textesManquants,
      evolution: suffisant ? evolution(avant, depuis) : null,
      astuces: h?.astuces ?? 0,
      choix: h?.choix ?? 0,
      reponsesJustes: h?.justes ?? 0,
      reponsesFausses: h?.fausses ?? 0,
      rechutes: h?.rechutes ?? 0,
      acquiseLe: h?.acquiseLe ?? null,
    };
  };

  const ordre = (a: MesureRegle, b: MesureRegle) =>
    a.pivot - b.pivot || (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0);

  const suivies: MesureRegle[] = [];
  for (const [ruleKey, h] of historiques) {
    if (REGLES_HORS_CYCLE.includes(ruleKey)) continue;
    const pivot = h.premiereAstuce ?? h.premierChoix;
    if (pivot === null) continue;
    suivies.push(mesurer(ruleKey, "suivie", pivot));
  }
  suivies.sort(ordre);

  const comparaison: MesureRegle[] = [];
  for (const ruleKey of REGLES_HORS_CYCLE) {
    const dates = (fautesParRegle.get(ruleKey) ?? []).map((f) => f.at).sort((a, b) => a - b);
    const pivot = dateCritere(dates, seuils);
    if (pivot !== null) comparaison.push(mesurer(ruleKey, "comparaison", pivot));
  }
  comparaison.sort(ordre);

  let justes = 0;
  let fausses = 0;
  let acquises = 0;
  let restees = 0;
  let rechutes = 0;
  for (const h of historiques.values()) {
    justes += h.justes;
    fausses += h.fausses;
    rechutes += h.rechutes;
    if (h.acquiseLe !== null) {
      acquises++;
      if (h.rechutes === 0) restees++;
    }
  }

  return {
    motsParTaux: MESURE.motsParTaux,
    minimum: {
      avant: { textes: MESURE.avantMinimumTextes, mots: MESURE.avantMinimumMots },
      depuis: { textes: MESURE.depuisMinimumTextes, mots: MESURE.depuisMinimumMots },
    },
    premierTexte: textes.length > 0 ? textes[0].at : null,
    suivies,
    comparaison,
    synthese: { suivies: synthese(suivies), comparaison: synthese(comparaison) },
    choix: {
      justes,
      fausses,
      taux: justes + fausses > 0 ? Math.round((justes / (justes + fausses)) * 100) : null,
    },
    acquises: { total: acquises, restees, rechutes },
  };
}

/**
 * Synthèse d'un groupe : somme des fautes sur somme des mots des règles dont
 * le volume suffit (pas une moyenne de taux : une règle mesurée sur peu de
 * mots ne pèse pas autant qu'une règle mesurée sur beaucoup).
 */
export function synthese(regles: readonly MesureRegle[]): SyntheseGroupe {
  const retenues = regles.filter((r) => r.suffisant);
  const somme = (periode: "avant" | "depuis"): Periode => {
    let textes = 0;
    let mots = 0;
    let fautes = 0;
    for (const r of retenues) {
      textes += r[periode].textes;
      mots += r[periode].mots;
      fautes += r[periode].fautes;
    }
    return { textes, mots, fautes, taux: taux(fautes, mots) };
  };
  const avant = somme("avant");
  const depuis = somme("depuis");
  return {
    regles: regles.length,
    reglesSuffisantes: retenues.length,
    avant,
    depuis,
    evolution: retenues.length > 0 ? evolution(avant, depuis) : null,
  };
}

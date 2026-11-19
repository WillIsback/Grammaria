/**
 * Évaluation des badges de progression.
 *
 * Logique pure : les faits du journal et l'heure (horloge injectée) donnent,
 * pour chaque badge du catalogue, la date à laquelle son critère a été rempli
 * et la progression vers son seuil. Aucun accès à la base ni à l'horloge du
 * système : `journal.badges.ts` fournit les faits et conserve le résultat.
 *
 * La date d'obtention est celle du fait qui a fait franchir le seuil (le
 * dixième texte, la règle acquise…). Sur une base existante, les badges déjà
 * mérités reçoivent donc leur vraie date, et non celle de la mise à jour.
 */
import { FICHES } from "../fiches";
import { debutSemaine, type LigneTexte, volume } from "../progression/calcul";
import { jourLocal } from "../regles/cycle";
import { JOUR_MS } from "../regles/seuils";
import { noteSur20 } from "../score";
import {
  BADGES,
  type DefinitionBadge,
  type MesureBadge,
  MOTS_MIN_SANS_FAUTE,
  NOTE_MOYENNE,
  PREFIXE_HOMOPHONES,
} from "./catalogue";

/** Un événement de l'historique des règles utile aux badges (`rule_events`). */
export interface FaitEvenement {
  ruleKey: string;
  at: number;
  type: "acquise" | "rechute" | "reponse_juste";
}

/** Faits du journal sur lesquels reposent les badges. */
export interface FaitsBadges {
  textes: LigneTexte[];
  /** Dans l'ordre où ils ont été enregistrés. */
  evenements: FaitEvenement[];
}

export interface EtatBadge {
  id: string;
  /** Date à laquelle le critère a été rempli ; null s'il ne l'est pas encore. */
  rempliLe: number | null;
  /** Valeur actuelle de la mesure (pour `noteMoyenne` : la note des 30 derniers jours). */
  valeur: number;
  seuil: number;
  /** Précision affichée sous la progression, quand la valeur seule ne suffit pas. */
  detail?: string;
  /**
   * Part du chemin parcouru (0 à 1), quand elle ne se déduit pas de
   * `valeur / seuil` (badge à plusieurs conditions).
   */
  ratio?: number;
}

/** Dates triées des éléments qui comptent : la valeur est leur nombre. */
interface Serie {
  dates: number[];
}

/** Première date de chaque clé distincte, dans l'ordre chronologique. */
function premieresDates<T>(items: T[], cle: (item: T) => string, date: (item: T) => number) {
  const vues = new Map<string, number>();
  for (const item of items) {
    const k = cle(item);
    const at = date(item);
    const deja = vues.get(k);
    if (deja === undefined || at < deja) vues.set(k, at);
  }
  return [...vues.values()].sort((a, b) => a - b);
}

/** Règles redevenues acquises après une rechute : une date par rechute surmontée. */
function rechutesSurmontees(evenements: FaitEvenement[]): number[] {
  const enRechute = new Set<string>();
  const dates: number[] = [];
  for (const e of evenements) {
    if (e.type === "rechute") enRechute.add(e.ruleKey);
    else if (e.type === "acquise" && enRechute.has(e.ruleKey)) {
      enRechute.delete(e.ruleKey);
      dates.push(e.at);
    }
  }
  return dates.sort((a, b) => a - b);
}

function series(
  faits: FaitsBadges,
  now: number,
): Record<Exclude<MesureBadge, "noteMoyenne">, Serie> {
  const textes = faits.textes.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
  const evenements = faits.evenements.filter((e) => e.at <= now);
  const acquises = evenements.filter((e) => e.type === "acquise");
  return {
    textes: { dates: textes.map((t) => t.at) },
    jours: {
      dates: premieresDates(
        textes,
        (t) => jourLocal(t.at),
        (t) => t.at,
      ),
    },
    semaines: {
      dates: premieresDates(
        textes,
        (t) => String(debutSemaine(t.at)),
        (t) => t.at,
      ),
    },
    textesSansFaute: {
      dates: textes
        .filter((t) => t.faults === 0 && t.words >= MOTS_MIN_SANS_FAUTE)
        .map((t) => t.at),
    },
    reglesAcquises: {
      dates: premieresDates(
        acquises,
        (e) => e.ruleKey,
        (e) => e.at,
      ),
    },
    homophonesAcquis: {
      dates: premieresDates(
        acquises.filter((e) => e.ruleKey.startsWith(PREFIXE_HOMOPHONES) && e.ruleKey in FICHES),
        (e) => e.ruleKey,
        (e) => e.at,
      ),
    },
    rechutesSurmontees: { dates: rechutesSurmontees(evenements) },
    reponsesJustes: {
      dates: evenements
        .filter((e) => e.type === "reponse_juste")
        .map((e) => e.at)
        .sort((a, b) => a - b),
    },
  };
}

/**
 * Badge de note moyenne : première fin de fenêtre glissante (à chaque texte)
 * où la fenêtre compte assez de textes et atteint la note visée.
 */
function evaluerNoteMoyenne(def: DefinitionBadge, faits: FaitsBadges, now: number): EtatBadge {
  const fenetre = NOTE_MOYENNE.fenetreJours * JOUR_MS;
  const textes = faits.textes.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);

  let rempliLe: number | null = null;
  let debut = 0;
  let mots = 0;
  let fautes = 0;
  for (let fin = 0; fin < textes.length && rempliLe === null; fin++) {
    mots += textes[fin].words;
    fautes += textes[fin].faults;
    while (textes[debut].at <= textes[fin].at - fenetre) {
      mots -= textes[debut].words;
      fautes -= textes[debut].faults;
      debut++;
    }
    const note = noteSur20(fautes, mots);
    if (fin - debut + 1 >= NOTE_MOYENNE.textesMin && note !== null && note >= def.seuil) {
      rempliLe = textes[fin].at;
    }
  }

  const recents = textes.filter((t) => t.at > now - fenetre);
  // Note sur 20 de la somme des fautes et des mots de la fenêtre.
  const { score: note } = volume(recents);
  const n = recents.length;
  const manque = Math.max(0, NOTE_MOYENNE.textesMin - n);
  const detail =
    `${n} ${n > 1 ? "textes corrigés" : "texte corrigé"} sur les ${NOTE_MOYENNE.fenetreJours} derniers jours` +
    (manque > 0 ? ` (${NOTE_MOYENNE.textesMin} au minimum).` : ".");
  // La barre tient compte des deux conditions : la note et le nombre de textes.
  const ratio = Math.min(1, (note ?? 0) / def.seuil, n / NOTE_MOYENNE.textesMin);
  return { id: def.id, rempliLe, valeur: note ?? 0, seuil: def.seuil, detail, ratio };
}

/**
 * État de chaque badge du catalogue, dans l'ordre du catalogue. Seuls les
 * faits datés au plus tard de `now` sont pris en compte.
 */
export function evaluerBadges(
  faits: FaitsBadges,
  now: number,
  catalogue: readonly DefinitionBadge[] = BADGES,
): EtatBadge[] {
  const parMesure = series(faits, now);
  return catalogue.map((def) => {
    if (def.mesure === "noteMoyenne") return evaluerNoteMoyenne(def, faits, now);
    const { dates } = parMesure[def.mesure];
    return {
      id: def.id,
      rempliLe: dates.length >= def.seuil ? dates[def.seuil - 1] : null,
      valeur: dates.length,
      seuil: def.seuil,
    };
  });
}

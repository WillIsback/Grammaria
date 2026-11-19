/**
 * Catalogue des badges de progression.
 *
 * Module de données unique : le serveur, l'interface, la documentation et les
 * tests lisent les badges depuis ce fichier, et nulle part ailleurs. Chaque
 * badge repose uniquement sur des faits du journal (textes corrigés, état des
 * règles, réponses au choix à deux formes).
 *
 * Les identifiants sont stables : ils sont conservés dans la base du journal.
 * Ne jamais renommer ni réutiliser un identifiant ; pour retirer un badge,
 * supprimer sa définition (les lignes déjà enregistrées sont alors ignorées).
 *
 * Ton : sobre et adulte. Les badges constatent un progrès, ils ne
 * culpabilisent jamais ; la régularité est cumulative (jours ou semaines
 * distincts), il n'existe aucune série qui « se casse ».
 */
import { SEUILS } from "../regles/seuils";

export const FAMILLES_BADGES = [
  { id: "premiers-pas", titre: "Premiers pas" },
  { id: "regularite", titre: "Régularité" },
  { id: "justesse", titre: "Justesse" },
  { id: "maitrise", titre: "Maîtrise des règles" },
  { id: "perseverance", titre: "Persévérance" },
] as const;

export type FamilleBadge = (typeof FAMILLES_BADGES)[number]["id"];

/**
 * Ce que l'on compte pour un badge. La logique de chaque mesure est dans
 * `evaluation.ts` ; l'icône du badge en dépend aussi.
 */
export type MesureBadge =
  /** Textes corrigés. */
  | "textes"
  /** Jours calendaires distincts avec au moins un texte corrigé. */
  | "jours"
  /** Semaines distinctes (lundi à dimanche) avec au moins un texte corrigé. */
  | "semaines"
  /** Textes d'au moins `MOTS_MIN_SANS_FAUTE` mots sans faute comptée. */
  | "textesSansFaute"
  /** Note moyenne sur une fenêtre glissante (voir `NOTE_MOYENNE`). */
  | "noteMoyenne"
  /** Règles distinctes devenues « acquises » au moins une fois. */
  | "reglesAcquises"
  /** Fiches d'homophones (clé `PAIRE:…`) devenues « acquises » au moins une fois. */
  | "homophonesAcquis"
  /** Règles redevenues « acquises » après une rechute. */
  | "rechutesSurmontees"
  /** Bonnes réponses au choix à deux formes du bouton Copier. */
  | "reponsesJustes";

export interface UniteBadge {
  singulier: string;
  pluriel: string;
}

export interface DefinitionBadge {
  /** Identifiant stable, conservé dans la base. */
  id: string;
  famille: FamilleBadge;
  titre: string;
  /** Ce que le badge constate, affiché une fois obtenu et dans la notification. */
  description: string;
  /** Critère en clair, affiché tant que le badge est à venir. */
  critere: string;
  mesure: MesureBadge;
  /** Valeur à atteindre (le palier). Pour `noteMoyenne`, une note sur 20. */
  seuil: number;
  unite: UniteBadge;
}

/** Un texte trop court ne compte pas comme « sans faute ». */
export const MOTS_MIN_SANS_FAUTE = 30;

/** Paramètres du badge de note moyenne. */
export const NOTE_MOYENNE = {
  /** Fenêtre glissante, en jours. */
  fenetreJours: 30,
  /** Nombre minimum de textes corrigés dans la fenêtre. */
  textesMin: 10,
} as const;

/** Préfixe des clés des fiches d'homophones dans `fiches.ts`. */
export const PREFIXE_HOMOPHONES = "PAIRE:";

const TEXTE: UniteBadge = { singulier: "texte", pluriel: "textes" };
const JOUR: UniteBadge = { singulier: "jour", pluriel: "jours" };
const SEMAINE: UniteBadge = { singulier: "semaine", pluriel: "semaines" };
const REGLE: UniteBadge = { singulier: "règle", pluriel: "règles" };
const FICHE: UniteBadge = { singulier: "fiche", pluriel: "fiches" };
const NOTE: UniteBadge = { singulier: "sur 20", pluriel: "sur 20" };
const REPONSE: UniteBadge = { singulier: "bonne réponse", pluriel: "bonnes réponses" };

const ACQUISE = `une règle est « acquise » après ${SEUILS.acquisitionJoursSansFaute} jours sans faute, sur au moins ${SEUILS.acquisitionTextesMin} textes corrigés et ${SEUILS.acquisitionJoursActifsMin} jours d'utilisation`;

export const BADGES: readonly DefinitionBadge[] = [
  // — Premiers pas —
  {
    id: "premier-texte",
    famille: "premiers-pas",
    titre: "Premier texte",
    description: "Votre premier texte est corrigé : le journal de progression commence.",
    critere: "Corriger un premier texte.",
    mesure: "textes",
    seuil: 1,
    unite: TEXTE,
  },
  {
    id: "textes-10",
    famille: "premiers-pas",
    titre: "Dix textes",
    description: "Dix textes corrigés : la relecture devient une habitude.",
    critere: "Corriger 10 textes.",
    mesure: "textes",
    seuil: 10,
    unite: TEXTE,
  },
  {
    id: "textes-50",
    famille: "premiers-pas",
    titre: "Cinquante textes",
    description: "Cinquante textes relus avec Grammaria.",
    critere: "Corriger 50 textes.",
    mesure: "textes",
    seuil: 50,
    unite: TEXTE,
  },
  {
    id: "textes-200",
    famille: "premiers-pas",
    titre: "Deux cents textes",
    description: "Deux cents textes corrigés : un usage installé dans la durée.",
    critere: "Corriger 200 textes.",
    mesure: "textes",
    seuil: 200,
    unite: TEXTE,
  },

  // — Régularité (cumulative : rien ne se perd si vous faites une pause) —
  {
    id: "jours-5",
    famille: "regularite",
    titre: "Cinq jours d'écriture",
    description: "Des textes corrigés sur cinq jours différents.",
    critere: "Corriger des textes sur 5 jours différents, consécutifs ou non.",
    mesure: "jours",
    seuil: 5,
    unite: JOUR,
  },
  {
    id: "jours-30",
    famille: "regularite",
    titre: "Trente jours d'écriture",
    description: "Des textes corrigés sur trente jours différents.",
    critere: "Corriger des textes sur 30 jours différents, consécutifs ou non.",
    mesure: "jours",
    seuil: 30,
    unite: JOUR,
  },
  {
    id: "semaines-4",
    famille: "regularite",
    titre: "Quatre semaines",
    description: "Grammaria vous a accompagné au cours de quatre semaines différentes.",
    critere: "Corriger au moins un texte au cours de 4 semaines différentes, consécutives ou non.",
    mesure: "semaines",
    seuil: 4,
    unite: SEMAINE,
  },
  {
    id: "semaines-12",
    famille: "regularite",
    titre: "Douze semaines",
    description: "Grammaria vous a accompagné au cours de douze semaines différentes.",
    critere: "Corriger au moins un texte au cours de 12 semaines différentes, consécutives ou non.",
    mesure: "semaines",
    seuil: 12,
    unite: SEMAINE,
  },

  // — Justesse —
  {
    id: "premier-sans-faute",
    famille: "justesse",
    titre: "Premier sans-faute",
    description: `Un texte d'au moins ${MOTS_MIN_SANS_FAUTE} mots, sans aucune faute comptée dans la note.`,
    critere: `Corriger un texte d'au moins ${MOTS_MIN_SANS_FAUTE} mots sans faute comptée dans la note.`,
    mesure: "textesSansFaute",
    seuil: 1,
    unite: TEXTE,
  },
  {
    id: "sans-faute-10",
    famille: "justesse",
    titre: "Dix sans-faute",
    description: `Dix textes d'au moins ${MOTS_MIN_SANS_FAUTE} mots sans faute comptée dans la note.`,
    critere: `Corriger 10 textes d'au moins ${MOTS_MIN_SANS_FAUTE} mots sans faute comptée dans la note.`,
    mesure: "textesSansFaute",
    seuil: 10,
    unite: TEXTE,
  },
  {
    id: "note-18",
    famille: "justesse",
    titre: "Plume sûre",
    description: `Une note moyenne d'au moins 18 sur 20 sur ${NOTE_MOYENNE.fenetreJours} jours.`,
    critere: `Atteindre une note moyenne d'au moins 18 sur 20 sur ${NOTE_MOYENNE.fenetreJours} jours glissants, avec au moins ${NOTE_MOYENNE.textesMin} textes corrigés sur la période.`,
    mesure: "noteMoyenne",
    seuil: 18,
    unite: NOTE,
  },

  // — Maîtrise des règles —
  {
    id: "premiere-regle",
    famille: "maitrise",
    titre: "Première règle acquise",
    description: "Une règle sur laquelle vous butiez est désormais acquise.",
    critere: `Acquérir une première règle (${ACQUISE}).`,
    mesure: "reglesAcquises",
    seuil: 1,
    unite: REGLE,
  },
  {
    id: "regles-3",
    famille: "maitrise",
    titre: "Trois règles acquises",
    description: "Trois règles sur lesquelles vous butiez sont désormais acquises.",
    critere: `Acquérir 3 règles différentes.`,
    mesure: "reglesAcquises",
    seuil: 3,
    unite: REGLE,
  },
  {
    id: "regles-5",
    famille: "maitrise",
    titre: "Cinq règles acquises",
    description: "Cinq règles sur lesquelles vous butiez sont désormais acquises.",
    critere: `Acquérir 5 règles différentes.`,
    mesure: "reglesAcquises",
    seuil: 5,
    unite: REGLE,
  },
  {
    id: "regles-10",
    famille: "maitrise",
    titre: "Dix règles acquises",
    description: "Dix règles sur lesquelles vous butiez sont désormais acquises.",
    critere: `Acquérir 10 règles différentes.`,
    mesure: "reglesAcquises",
    seuil: 10,
    unite: REGLE,
  },
  {
    id: "homophones-3",
    famille: "maitrise",
    titre: "Homophones apprivoisés",
    description: "Trois fiches d'homophones (a / à, et / est, on / ont…) sont acquises.",
    critere:
      "Acquérir 3 fiches d'homophones différentes : a / à, ou / où, et / est, on / ont, son / sont, ces / ses, ce / se, c'est / s'est, la / là, sa / ça, peu / peut / peux.",
    mesure: "homophonesAcquis",
    seuil: 3,
    unite: FICHE,
  },

  // — Persévérance —
  {
    id: "rechute-surmontee",
    famille: "perseverance",
    titre: "Rechute surmontée",
    description: "Une règle est redevenue acquise après une rechute : la maîtrise se consolide.",
    critere: "Acquérir de nouveau une règle après une rechute (une faute sur une règle acquise).",
    mesure: "rechutesSurmontees",
    seuil: 1,
    unite: REGLE,
  },
  {
    id: "choix-10",
    famille: "perseverance",
    titre: "Dix bons choix",
    description: "Dix fois, vous avez choisi la bonne forme sur le bouton Copier.",
    critere: "Choisir 10 fois la bonne forme lorsque le bouton Copier propose deux formes.",
    mesure: "reponsesJustes",
    seuil: 10,
    unite: REPONSE,
  },
];

/** Définition d'un badge par identifiant ; undefined pour un identifiant inconnu. */
export function definitionBadge(id: string): DefinitionBadge | undefined {
  return BADGES.find((b) => b.id === id);
}

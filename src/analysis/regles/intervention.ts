/**
 * Intervention à afficher près du bouton Copier pour un texte corrigé.
 *
 * Logique pure, décidée côté serveur : parmi les règles fautives du texte, on
 * retient au plus une intervention (un choix à deux formes pour une règle
 * « travaillée », sinon une astuce), dans le respect du budget de friction.
 */
import { diffHunks } from "../diff";
import { peutSolliciter, type RuleState } from "./cycle";
import { SEUILS, type Seuils } from "./seuils";

export interface FormeChoix {
  texte: string;
  correcte: boolean;
}

/** Une ligne d'astuce près du bouton Copier (règle « signalée »). */
export interface InterventionAstuce {
  type: "astuce";
  ruleKey: string;
  titre: string;
  texte: string;
}

/** Le bouton Copier remplacé par deux formes (règle « travaillée »). */
export interface InterventionChoix {
  type: "choix";
  /**
   * Identifiant de ce choix précis (événement « choix » de l'historique),
   * attribué par le journal ; la réponse de l'utilisateur s'y rattache.
   */
  choiceId: number;
  ruleKey: string;
  titre: string;
  /** Affichée quand la mauvaise forme est cliquée. */
  explication: string;
  /** Extrait de la phrase de l'utilisateur avant et après la forme. */
  avant: string;
  apres: string;
  /** Les deux formes, déjà dans l'ordre d'affichage (aléatoire). */
  formes: [FormeChoix, FormeChoix];
  /**
   * Position de la bonne forme dans le texte corrigé (fin exclue) : l'écran la
   * masque tant que le choix attend une réponse, sinon la réponse se lirait
   * dans le résultat affiché (issue #59). Absente si elle n'a pas pu être
   * située ; rien n'est alors masqué.
   */
  masque?: { start: number; end: number };
}

export type Intervention = InterventionAstuce | InterventionChoix;

/** Choix décidé par la logique pure, avant que le journal lui donne son identifiant. */
type ChoixPropose = Omit<InterventionChoix, "choiceId">;

/** Règle devenue « acquise » avec ce texte : message de réussite. */
export interface Reussite {
  ruleKey: string;
  titre: string;
}

/** Passage corrigé sur lequel porte l'intervention. */
export interface PassageCorrige {
  /** Position dans le texte d'origine. */
  start: number;
  end: number;
  avant: string;
  apres: string;
}

/** Règle fautive dans le texte courant, état à jour après la faute. */
export interface Candidat {
  state: RuleState;
  titre: string;
  /** Astuce de la fiche de règle, quand elle existe. */
  astuce: string | null;
  /** Passages du texte fautifs sur cette règle, dans l'ordre du texte. */
  passages: PassageCorrige[];
}

const estFrontiere = (ch: string) => ch === "." || ch === "!" || ch === "?" || ch === "\n";
const compacter = (s: string) => s.replace(/\s+/g, " ");

function couperDebut(texte: string, max: number): string {
  if (texte.length <= max) return texte;
  const coupe = texte.slice(texte.length - max);
  const espace = coupe.indexOf(" ");
  return `… ${espace >= 0 && espace < coupe.length - 1 ? coupe.slice(espace + 1) : coupe}`;
}

function couperFin(texte: string, max: number): string {
  if (texte.length <= max) return texte;
  const coupe = texte.slice(0, max);
  const espace = coupe.lastIndexOf(" ");
  return `${espace > 0 ? coupe.slice(0, espace) : coupe} …`;
}

/**
 * Position, dans le texte corrigé, de la forme `forme` qui remplace le passage
 * `[debut, fin[` du texte d'origine. Null si le passage n'a pas été corrigé en
 * cette forme. Les corrections précédentes décalent le texte : la position est
 * recalculée à partir de la comparaison mot à mot des deux textes.
 */
export function positionDansCorrige(
  original: string,
  corrected: string,
  debut: number,
  fin: number,
  forme: string,
): { start: number; end: number } | null {
  if (!forme) return null;
  let decalage = 0;
  for (const hunk of diffHunks(original, corrected)) {
    if (hunk.end <= debut) {
      decalage += hunk.after.length - hunk.before.length;
      continue;
    }
    if (hunk.start >= fin) break;
    const index = hunk.after.indexOf(forme);
    if (index < 0) return null;
    const start = hunk.start + decalage + index;
    const end = start + forme.length;
    return corrected.slice(start, end) === forme ? { start, end } : null;
  }
  return null;
}

/**
 * Construit le choix à deux formes sur la phrase de l'utilisateur, ou null si
 * le passage ne s'y prête pas (ajout ou suppression pure, forme trop longue).
 * `random` (valeur dans [0, 1[) tire l'ordre des deux formes.
 */
export function construireChoix(
  original: string,
  passage: PassageCorrige,
  random: () => number = Math.random,
  seuils: Seuils = SEUILS,
  corrected?: string,
): Pick<InterventionChoix, "avant" | "apres" | "formes" | "masque"> | null {
  const fautive = passage.avant.trim();
  const corrigee = passage.apres.trim();
  if (!fautive || !corrigee || fautive === corrigee) return null;
  if (fautive.includes("\n") || corrigee.includes("\n")) return null;
  if (Math.max(fautive.length, corrigee.length) > seuils.choixLongueurMaxForme) return null;

  const debut = passage.start + (passage.avant.length - passage.avant.trimStart().length);
  const fin = passage.end - (passage.avant.length - passage.avant.trimEnd().length);
  if (original.slice(debut, fin) !== fautive) return null;

  let debutPhrase = debut;
  while (debutPhrase > 0 && !estFrontiere(original[debutPhrase - 1])) debutPhrase--;
  let finPhrase = fin;
  while (finPhrase < original.length && !estFrontiere(original[finPhrase])) finPhrase++;
  if (finPhrase < original.length && original[finPhrase] !== "\n") finPhrase++;

  const avant = couperDebut(
    compacter(original.slice(debutPhrase, debut)).trimStart(),
    seuils.choixContexteMax,
  );
  const apres = couperFin(
    compacter(original.slice(fin, finPhrase)).trimEnd(),
    seuils.choixContexteMax,
  );
  const bonne: FormeChoix = { texte: corrigee, correcte: true };
  const mauvaise: FormeChoix = { texte: fautive, correcte: false };
  const formes: [FormeChoix, FormeChoix] = random() < 0.5 ? [bonne, mauvaise] : [mauvaise, bonne];
  const masque =
    corrected === undefined ? null : positionDansCorrige(original, corrected, debut, fin, corrigee);
  return masque ? { avant, apres, formes, masque } : { avant, apres, formes };
}

/** Astuce d'une règle sans fiche : la correction faite sur le texte lui-même. */
function astuceParDefaut(passage: PassageCorrige | undefined): string {
  const fautive = passage?.avant.trim();
  const corrigee = passage?.apres.trim();
  if (fautive && corrigee) {
    return `Vous avez écrit « ${fautive} » ; la forme correcte ici est « ${corrigee} ».`;
  }
  return "Cette faute revient souvent dans vos textes : relisez ce passage avant d'envoyer.";
}

/**
 * Choisit l'intervention du texte : au plus une, un choix à deux formes
 * passant avant une astuce. Entre deux règles de même rang, celle qui a été
 * sollicitée il y a le plus longtemps, puis la plus fréquente.
 */
export function choisirIntervention(
  candidats: Candidat[],
  original: string,
  now: number,
  random: () => number = Math.random,
  seuils: Seuils = SEUILS,
  corrected?: string,
): InterventionAstuce | ChoixPropose | null {
  const rang = (c: Candidat) => (c.state.state === "travaillee" ? 0 : 1);
  const eligibles = candidats
    .filter((c) => c.state.state === "signalee" || c.state.state === "travaillee")
    .filter((c) => peutSolliciter(c.state, now, seuils))
    .sort(
      (a, b) =>
        rang(a) - rang(b) ||
        (a.state.lastSolicitedAt ?? 0) - (b.state.lastSolicitedAt ?? 0) ||
        b.state.occurrences - a.state.occurrences ||
        a.state.ruleKey.localeCompare(b.state.ruleKey),
    );

  // Un choix d'abord, s'il est constructible pour l'une des règles travaillées.
  for (const c of eligibles) {
    if (c.state.state !== "travaillee") continue;
    for (const passage of c.passages) {
      const choix = construireChoix(original, passage, random, seuils, corrected);
      if (!choix) continue;
      return {
        type: "choix",
        ruleKey: c.state.ruleKey,
        titre: c.titre,
        explication: c.astuce ?? astuceParDefaut(passage),
        ...choix,
      };
    }
  }

  // Sinon une astuce. Une règle travaillée dont le passage ne se prête pas au
  // choix reçoit elle aussi une simple astuce.
  const premier = eligibles[0];
  if (!premier) return null;
  return {
    type: "astuce",
    ruleKey: premier.state.ruleKey,
    titre: premier.titre,
    texte: premier.astuce ?? astuceParDefaut(premier.passages[0]),
  };
}

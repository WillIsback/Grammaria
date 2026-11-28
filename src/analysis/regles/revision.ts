/**
 * Question de révision posée pendant que le modèle écrit (issue #62).
 *
 * Sans elle, rien ne se passe tant que la faute n'est pas refaite : aucun
 * rappel espacé. Le temps d'attente de la correction est libre ; y poser une
 * question ne retarde pas la copie.
 *
 * Le journal ne garde aucun texte : la question ne peut pas reprendre une
 * phrase de l'utilisateur. Elle porte donc sur une phrase d'exemple à trou,
 * écrite ici pour chaque fiche de type paire.
 *
 * Logique pure : les états des règles, le nombre de bonnes réponses et
 * l'heure donnent la question, ou null si aucune règle n'est due.
 */
import { FICHES } from "../fiches";
import { peutSolliciter, type RuleState } from "./cycle";
import type { FormeChoix } from "./intervention";
import { JOUR_MS, SEUILS, type Seuils } from "./seuils";

/** Phrase à trou : `avant` + forme + `apres`. */
export interface ExempleRevision {
  avant: string;
  apres: string;
  bonne: string;
  mauvaise: string;
}

const ex = (avant: string, apres: string, bonne: string, mauvaise: string): ExempleRevision => ({
  avant,
  apres,
  bonne,
  mauvaise,
});

/** Phrases d'exemple par fiche de type paire. Des phrases de travail, courtes. */
export const EXEMPLES_REVISION: Record<string, readonly ExempleRevision[]> = {
  "PAIRE:a/à": [
    ex("Elle habite ", " Lyon depuis deux ans.", "à", "a"),
    ex("Il ", " terminé le rapport hier.", "a", "à"),
  ],
  "PAIRE:ou/où": [
    ex("Dis-moi ", " tu ranges les clés.", "où", "ou"),
    ex("Tu préfères le train ", " la voiture ?", "ou", "où"),
  ],
  "PAIRE:et/est": [
    ex("Le dossier ", " prêt depuis ce matin.", "est", "et"),
    ex("J'ai relu le contrat ", " ses annexes.", "et", "est"),
  ],
  "PAIRE:on/ont": [
    ex("Les clients ", " confirmé leur venue.", "ont", "on"),
    ex("Demain, ", " se retrouve à neuf heures.", "on", "ont"),
  ],
  "PAIRE:son/sont": [
    ex("Les factures ", " parties ce matin.", "sont", "son"),
    ex("Elle a oublié ", " badge au bureau.", "son", "sont"),
  ],
  "PAIRE:ces/ses": [
    ex("Il a rangé ", " affaires avant de partir.", "ses", "ces"),
    ex("Regarde ", " nuages, il va pleuvoir.", "ces", "ses"),
  ],
  "PAIRE:ce/se": [
    ex("Elle ", " lève tôt tous les jours.", "se", "ce"),
    ex("J'ai lu ", " document hier soir.", "ce", "se"),
  ],
  "PAIRE:c'est/s'est": [
    ex("Il ", " trompé de salle.", "s'est", "c'est"),
    ex("Je crois que ", " une bonne idée.", "c'est", "s'est"),
  ],
  "PAIRE:la/là": [
    ex("Pose le colis ", ", près de la porte.", "là", "la"),
    ex("Je ", " rappelle dans une heure.", "la", "là"),
  ],
  "PAIRE:sa/ça": [
    ex("Elle a prévenu ", " responsable.", "sa", "ça"),
    ex("Ne t'inquiète pas, ", " arrive à tout le monde.", "ça", "sa"),
  ],
  "PAIRE:peu/peut/peux": [
    ex("Il reste ", " de temps avant la réunion.", "peu", "peut"),
    ex("Elle ", " venir dès lundi.", "peut", "peu"),
  ],
};

/** Question choisie par la logique pure, avant que le journal lui donne son identifiant. */
export interface RevisionProposee {
  ruleKey: string;
  titre: string;
  /** Affichée quand la mauvaise forme est cliquée. */
  explication: string;
  avant: string;
  apres: string;
  /** Les deux formes, déjà dans l'ordre d'affichage (aléatoire). */
  formes: [FormeChoix, FormeChoix];
}

/** Question de révision telle que l'envoie le serveur. */
export interface QuestionRevision extends RevisionProposee {
  /** Identifiant de cette question (événement « revision ») ; la réponse s'y rattache. */
  reviewId: number;
}

/**
 * Jours à attendre avant la prochaine révision d'une règle, selon le nombre de
 * bonnes réponses données depuis sa dernière faute : l'intervalle grandit à
 * chaque réussite (rappel espacé), jusqu'à un plafond.
 */
export function intervalleRevisionJours(justes: number, seuils: Seuils = SEUILS): number {
  const intervalle = seuils.revisionIntervalleJours * seuils.revisionFacteur ** Math.max(0, justes);
  return Math.min(intervalle, seuils.revisionIntervalleMaxJours);
}

/**
 * Choisit la question de révision à poser à `now`, ou null. Une règle est due
 * si elle est signalée ou travaillée, possède des phrases d'exemple, n'a pas
 * encore été sollicitée ce jour-là, et n'a eu ni faute ni sollicitation depuis
 * son intervalle. `justes(ruleKey)` : bonnes réponses aux révisions depuis la
 * dernière faute. `random` tire la phrase et l'ordre des deux formes.
 */
export function choisirRevision(
  states: readonly RuleState[],
  justes: (ruleKey: string) => number,
  now: number,
  random: () => number = Math.random,
  seuils: Seuils = SEUILS,
): RevisionProposee | null {
  const reference = (s: RuleState) => Math.max(s.lastFaultAt, s.lastSolicitedAt ?? 0);
  const dues = states
    .filter((s) => s.state === "signalee" || s.state === "travaillee")
    .filter((s) => (EXEMPLES_REVISION[s.ruleKey]?.length ?? 0) > 0 && FICHES[s.ruleKey])
    .filter((s) => peutSolliciter(s, now, seuils))
    .filter(
      (s) => now - reference(s) >= intervalleRevisionJours(justes(s.ruleKey), seuils) * JOUR_MS,
    )
    .sort((a, b) => reference(a) - reference(b) || a.ruleKey.localeCompare(b.ruleKey));
  const regle = dues[0];
  if (!regle) return null;

  const exemples = EXEMPLES_REVISION[regle.ruleKey];
  const exemple = exemples[Math.min(Math.floor(random() * exemples.length), exemples.length - 1)];
  const bonne: FormeChoix = { texte: exemple.bonne, correcte: true };
  const mauvaise: FormeChoix = { texte: exemple.mauvaise, correcte: false };
  const fiche = FICHES[regle.ruleKey];
  return {
    ruleKey: regle.ruleKey,
    titre: fiche.titre,
    explication: fiche.astuce,
    avant: exemple.avant,
    apres: exemple.apres,
    formes: random() < 0.5 ? [bonne, mauvaise] : [mauvaise, bonne],
  };
}

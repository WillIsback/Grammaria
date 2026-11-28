/**
 * Seuils du cycle de vie des règles (Phase 2).
 *
 * Tous les réglages de l'intervention sur les fautes récurrentes sont ici, et
 * nulle part ailleurs : la logique de transition (`cycle.ts`), le choix de
 * l'intervention (`intervention.ts`), le journal et l'interface les lisent
 * depuis ce module. Ce sont des choix de conception de départ, à ajuster sur
 * des données réelles.
 */
export const SEUILS = {
  /** Observée → signalée : nombre de fautes sur la règle… */
  signalementOccurrences: 3,
  /** … dans cette fenêtre glissante, en jours. */
  signalementFenetreJours: 7,

  /**
   * Signalée → travaillée : la faute revient alors que ce nombre d'astuces a
   * déjà été affiché pour la règle. Une seule : ces fautes viennent plus souvent
   * d'un défaut d'attention que d'une règle inconnue, et relire plusieurs fois
   * la même ligne apporte peu (issue #61). La question active arrive donc tôt.
   */
  astucesAvantTravail: 1,

  /** → Acquise : jours écoulés depuis la dernière faute sur la règle… */
  acquisitionJoursSansFaute: 14,
  /** … pendant lesquels au moins ce nombre de textes a été corrigé… */
  acquisitionTextesMin: 5,
  /**
   * … sur au moins ce nombre de jours distincts. Sans ces deux minimums, une
   * règle deviendrait « acquise » simplement parce que l'application est
   * restée fermée.
   */
  acquisitionJoursActifsMin: 3,
  /**
   * Pour les règles dont on sait reconnaître l'emploi correct (les paires :
   * a / à, on / ont…), l'acquisition ne compte plus les textes corrigés mais
   * ceux où la règle a été employée sans faute : au moins ce nombre, sur
   * `acquisitionJoursActifsMin` jours distincts (issue #60).
   */
  acquisitionEmploisMin: 5,

  /** Budget de friction : règles « travaillées » en même temps, au plus. */
  travailleesMax: 3,
  /**
   * Budget de friction : sollicitations (astuce ou choix) par règle et par
   * jour calendaire. Au-delà, le bouton Copier reste normal.
   */
  sollicitationsParRegleEtParJour: 1,

  /**
   * Question de révision posée pendant l'attente de la correction (issue #62).
   * Une règle suivie est due quand elle n'a eu ni faute ni sollicitation depuis
   * ce nombre de jours…
   */
  revisionIntervalleJours: 2,
  /** … multiplié par ce facteur à chaque bonne réponse (rappel espacé)… */
  revisionFacteur: 2,
  /** … sans dépasser ce nombre de jours. */
  revisionIntervalleMaxJours: 16,

  /**
   * Longueur maximale d'une forme proposée sur le bouton Copier. Au-delà, le
   * choix ne tient pas sur un bouton : la règle reçoit une astuce à la place.
   */
  choixLongueurMaxForme: 24,
  /** Longueur maximale de l'extrait de phrase affiché de chaque côté de la forme. */
  choixContexteMax: 60,
} as const;

/** Règle LanguageTool des fautes de frappe (mots mal orthographiés). */
export const REGLE_ORTHOGRAPHE = "FR_SPELLING_RULE";

/**
 * Règles tenues hors du cycle de vie, bien que comptées dans la note.
 *
 * `REGLE_ORTHOGRAPHE` (`FR_SPELLING_RULE`) est la détection générique « faute de frappe » du
 * correcteur grammatical : elle regroupe tous les mots mal orthographiés. Ce
 * n'est pas une règle que l'on peut acquérir, et elle occuperait en permanence
 * l'une des places de règle « travaillée ».
 */
export const REGLES_HORS_CYCLE: readonly string[] = [REGLE_ORTHOGRAPHE];

/** Forme des seuils ; les tests et les simulations peuvent en fournir d'autres valeurs. */
export type Seuils = { readonly [K in keyof typeof SEUILS]: number };

export const JOUR_MS = 24 * 60 * 60 * 1000;

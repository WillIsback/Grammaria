/**
 * Réglages de l'écran « Progression » (issue #15).
 *
 * Toutes les constantes du tableau de bord sont ici, et nulle part ailleurs :
 * le calcul (`calcul.ts`), le serveur, l'interface et la documentation
 * utilisateur (`utiliser/progression.mdx`) s'y réfèrent. Comme les seuils du
 * cycle de vie des règles, ce sont des choix de départ, à ajuster sur des
 * données réelles.
 */
import { REGLE_ORTHOGRAPHE } from "../regles/seuils";

export const PROGRESSION = {
  /** Nombre de semaines affichées dans les graphiques (semaine en cours comprise). */
  semainesAffichees: 12,
  /**
   * Fenêtre « récente », en semaines (semaine en cours comprise) : qualité
   * récente du score de maîtrise et tendance des fautes pour 100 mots.
   */
  semainesRecentes: 4,

  /**
   * Score de maîtrise (0 à 100) :
   *
   *   score = 100 × (poidsQualite × qualité + poidsRegles × part des règles acquises)
   *
   * - qualité : note moyenne des semaines récentes ramenée entre 0 et 1
   *   (note / 20). La note dépend de la proportion de fautes (fautes pour
   *   100 mots), jamais du nombre de textes : écrire plus ne fait pas baisser
   *   le score.
   * - part des règles acquises : règles « acquises » divisées par les règles
   *   entrées dans le cycle (signalées, travaillées ou acquises). Une règle
   *   seulement « observée » (faute isolée) n'y entre pas.
   *
   * Tant qu'aucune règle n'est entrée dans le cycle, le score vaut la qualité
   * seule. Les deux poids font 1.
   */
  poidsQualite: 0.6,
  poidsRegles: 0.4,

  /**
   * En dessous de ces minimums sur la fenêtre récente, le score n'est pas
   * calculé : l'écran affiche « pas encore assez de textes » plutôt qu'un
   * chiffre trompeur. Les deux conditions doivent être remplies.
   */
  minimumTextesRecents: 5,
  minimumMotsRecents: 300,

  /**
   * Tendance des fautes pour 100 mots (semaines récentes contre les semaines
   * d'avant, de même durée) : un écart plus petit que ce nombre de fautes pour
   * 100 mots est considéré comme stable.
   */
  ecartTendanceStable: 0.25,

  /** Règles les plus fréquentes affichées (fautes des semaines affichées). */
  reglesFrequentesMax: 8,
  /**
   * Règle des fautes de frappe : listée parmi les règles fréquentes sous un
   * libellé à part (`libelleOrthographe`), mais toujours hors du cycle.
   */
  regleOrthographe: REGLE_ORTHOGRAPHE,
  libelleOrthographe: "Fautes de frappe",

  /**
   * Paliers du score de maîtrise, pour une lecture en mots (la couleur n'est
   * jamais seule porteuse d'information). Chaque palier s'applique à partir
   * de son minimum.
   */
  paliers: [
    { minimum: 85, libelle: "Excellente maîtrise" },
    { minimum: 70, libelle: "Bonne maîtrise" },
    { minimum: 50, libelle: "En bonne voie" },
    { minimum: 0, libelle: "Les bases à consolider" },
  ],
} as const;

/**
 * Réglages de la mesure « avant / depuis la première astuce » (issue #33,
 * `mesure.ts`) et de l'export anonyme de la bêta (issue #34, `export.ts`).
 * Ils sont recopiés dans chaque export : deux exports ne se comparent que
 * s'ils ont été calculés avec les mêmes valeurs.
 */
export const MESURE = {
  /**
   * Unité des taux : fautes pour 1 000 mots. Pour une seule règle, « pour
   * 100 mots » donne des nombres minuscules (une faute tous les deux ou trois
   * textes de 150 mots ≈ 0,3 pour 100 mots, mais 3 pour 1 000 mots).
   */
  motsParTaux: 1000,

  /**
   * Volume minimal de la période « avant » (de la première faute de la règle
   * à la première astuce). Cette période est courte par construction :
   * l'astuce arrive dès que la faute revient 3 fois en 7 jours. Exiger
   * 1 000 mots écarterait la plupart des règles d'un utilisateur qui écrit un
   * texte de 150 mots par jour ; 3 textes et 400 mots couvrent au moins
   * plusieurs jours d'écriture.
   */
  avantMinimumTextes: 3,
  avantMinimumMots: 400,
  /**
   * Volume minimal de la période « depuis » : au moins 5 textes et
   * 1 000 mots (une semaine d'écriture quotidienne). Au taux typique d'une
   * faute signalée (3 à 6 pour 1 000 mots), on attendrait encore 3 à 6 fautes
   * sur 1 000 mots si rien ne changeait : en dessous, un « zéro faute » ne
   * dirait rien.
   */
  depuisMinimumTextes: 5,
  depuisMinimumMots: 1000,
} as const;

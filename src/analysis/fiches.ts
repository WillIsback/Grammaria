/**
 * Fiches de règles au format « remplacez par X, car Y ».
 *
 * Les confusions les plus courantes (homophones, terminaisons -er/-é) sont
 * reconnues directement dans le diff, sans dépendre de LanguageTool : la clé
 * est donc stable quel que soit le moteur.
 */

export interface Fiche {
  titre: string;
  astuce: string;
}

/**
 * Nom lisible d'une règle sans fiche : son libellé fixe (description de la règle
 * du moteur), sinon sa catégorie, sinon la clé de la règle. Jamais le message du
 * correcteur, qui peut citer les mots du texte.
 */
export function libelleSansFiche(
  ruleKey: string,
  faute?: { label?: string | null; categoryName?: string | null } | null,
): string {
  return faute?.label || faute?.categoryName || ruleKey;
}

export const FICHES: Record<string, Fiche> = {
  "PAIRE:a/à": {
    titre: "a / à",
    astuce:
      "Remplacez par « avait ». Si la phrase reste correcte, écrivez « a », car c'est le verbe avoir ; sinon écrivez « à », la préposition.",
  },
  "PAIRE:ou/où": {
    titre: "ou / où",
    astuce:
      "Remplacez par « ou bien ». Si la phrase reste correcte, écrivez « ou », car il exprime un choix ; sinon écrivez « où », qui indique un lieu ou un moment.",
  },
  "PAIRE:et/est": {
    titre: "et / est",
    astuce:
      "Remplacez par « était ». Si la phrase reste correcte, écrivez « est », car c'est le verbe être ; sinon écrivez « et », qui relie deux éléments.",
  },
  "PAIRE:on/ont": {
    titre: "on / ont",
    astuce:
      "Remplacez par « avaient ». Si la phrase reste correcte, écrivez « ont », car c'est le verbe avoir ; sinon écrivez « on », le pronom, remplaçable par « il ».",
  },
  "PAIRE:son/sont": {
    titre: "son / sont",
    astuce:
      "Remplacez par « étaient ». Si la phrase reste correcte, écrivez « sont », car c'est le verbe être ; sinon écrivez « son », le possessif, remplaçable par « mon ».",
  },
  "PAIRE:ces/ses": {
    titre: "ces / ses",
    astuce:
      "Mettez le groupe au singulier. Si vous obtenez « son » ou « sa », écrivez « ses », car c'est un possessif ; si vous obtenez « ce » ou « cette », écrivez « ces ».",
  },
  "PAIRE:ce/se": {
    titre: "ce / se",
    astuce:
      "Remplacez par « me » en changeant le sujet en « je ». Si la phrase reste correcte, écrivez « se », car c'est un pronom placé devant un verbe ; sinon écrivez « ce ».",
  },
  "PAIRE:c'est/s'est": {
    titre: "c'est / s'est",
    astuce:
      "Remplacez par « cela est ». Si la phrase reste correcte, écrivez « c'est » ; sinon écrivez « s'est », car il s'agit d'un verbe pronominal (« il s'est levé », « je me suis levé »).",
  },
  "PAIRE:la/là": {
    titre: "la / là",
    astuce:
      "Remplacez par « là-bas ». Si la phrase reste correcte, écrivez « là », car il indique un lieu ; sinon écrivez « la », l'article ou le pronom.",
  },
  "PAIRE:sa/ça": {
    titre: "sa / ça",
    astuce:
      "Remplacez par « cela ». Si la phrase reste correcte, écrivez « ça » ; sinon écrivez « sa », car c'est un possessif, remplaçable par « ma ».",
  },
  "PAIRE:peu/peut/peux": {
    titre: "peu / peut / peux",
    astuce:
      "Remplacez par « pouvait ». Si la phrase reste correcte, c'est le verbe pouvoir : « peut » avec il ou elle, « peux » avec je ou tu. Sinon écrivez « peu », le contraire de « beaucoup ».",
  },
  "TERMINAISON:er/é": {
    titre: "Terminaison -er, -é ou -ez",
    astuce:
      "Remplacez le verbe par « vendre » ou « vendu ». Si « vendre » convient, écrivez -er, car c'est un infinitif ; si « vendu » convient, écrivez -é, car c'est un participe passé. La terminaison -ez est réservée au sujet « vous ».",
  },
  "NOM_VERBE:ail/aille": {
    titre: "Nom ou verbe : travail / travaille",
    astuce:
      "Mettez « un » ou « le » devant le mot. Si la phrase reste correcte, écrivez le nom en -ail, -eil ou -euil (« un travail », « un conseil »), car c'est une chose ; sinon écrivez le verbe, qui double le l : « je travaille », « ils travaillent », « j'ai travaillé ».",
  },
};

const GROUPES: string[][] = [
  ["a", "à"],
  ["ou", "où"],
  ["et", "est"],
  ["on", "ont"],
  ["son", "sont"],
  ["ces", "ses"],
  ["ce", "se"],
  ["c'est", "s'est"],
  ["la", "là"],
  ["sa", "ça"],
  ["peu", "peut", "peux"],
];

const TERMINAISONS = ["ées", "ée", "és", "er", "ez", "é"];

function normaliser(mot: string): string {
  return mot.trim().toLowerCase().replace(/’/g, "'");
}

function decouper(mot: string): { radical: string; terminaison: string } | null {
  for (const terminaison of TERMINAISONS) {
    if (mot.endsWith(terminaison) && mot.length - terminaison.length >= 2) {
      return { radical: mot.slice(0, -terminaison.length), terminaison };
    }
  }
  return null;
}

/** Noms en -ail, -eil, -euil dont le verbe double le l : travail / travaille. */
const NOM_EN_IL = /^[\p{L}]{2,}(ail|eil|euil|ueil)$/u;
const FINALES_VERBE = new Set(["e", "es", "ent", "er", "é", "és", "ée", "ées", "ez", "ons"]);
/** Adjectifs dont le féminin double aussi le l : « pareil → pareille » est un accord. */
const ADJECTIFS_EN_IL = new Set(["pareil", "nonpareil", "vermeil", "vieil"]);

/** Vrai si l'un des mots est le nom et l'autre le verbe : « travail / travaillent ». */
function nomOuVerbe(a: string, b: string): boolean {
  const verifier = (nom: string, verbe: string) =>
    NOM_EN_IL.test(nom) &&
    !ADJECTIFS_EN_IL.has(nom) &&
    verbe.startsWith(`${nom}l`) &&
    FINALES_VERBE.has(verbe.slice(nom.length + 1));
  return verifier(a, b) || verifier(b, a);
}

/** Clé de fiche si le remplacement « avant → après » est une confusion connue. */
export function detecterConfusion(avant: string, apres: string): string | null {
  const a = normaliser(avant);
  const b = normaliser(apres);
  if (!a || !b || a === b) return null;

  const paire = (x: string, y: string) =>
    GROUPES.find((groupe) => groupe.includes(x) && groupe.includes(y));

  const groupe = paire(a, b);
  if (groupe) return `PAIRE:${groupe.join("/")}`;

  // Mot composé : « la-bas → là-bas », « celle-la → celle-là ». Limité à
  // la / là : pour « peu-être → peut-être », le test de la fiche peu / peut
  // (« remplacez par pouvait ») ne s'applique pas à l'adverbe.
  const pa = a.split("-");
  const pb = b.split("-");
  if (pa.length > 1 && pa.length === pb.length) {
    const differentes = pa.map((p, i) => [p, pb[i]]).filter(([x, y]) => x !== y);
    if (differentes.length === 1 && paire(differentes[0][0], differentes[0][1])?.[0] === "la") {
      return "PAIRE:la/là";
    }
  }

  if (nomOuVerbe(a, b)) return "NOM_VERBE:ail/aille";

  const da = decouper(a);
  const db = decouper(b);
  if (da && db && da.radical === db.radical) {
    // « mangé → mangée » est un accord, pas une confusion infinitif/participe.
    const infinitifOuVous = (t: string) => t === "er" || t === "ez";
    if (infinitifOuVous(da.terminaison) || infinitifOuVous(db.terminaison)) {
      return "TERMINAISON:er/é";
    }
  }
  return null;
}

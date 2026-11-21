/**
 * Collecte des exports de la bêta (issue #34).
 *
 *   npm run beta:agreger -- <dossier>
 *
 * Lit tous les fichiers `.json` du dossier (sans descendre dans les
 * sous-dossiers), refuse en le nommant, sans afficher son contenu, tout
 * fichier qui ne passe pas `validerExport`, garde l'export le plus récent de
 * chaque participant (celui qui couvre le plus de semaines), puis écrit dans
 * le même dossier `synthese.md` (à lire) et `synthese.csv` (à ouvrir dans un
 * tableur : séparateur « ; », virgule décimale).
 *
 * Aucun test statistique : des sommes, des comptes et une médiane, avec
 * les mêmes mises en garde que l'écran Progression.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExportBeta,
  LIMITES_EXPORT,
  type SyntheseExport,
  validerTexteExport,
} from "../../src/analysis/progression/export.ts";

export interface FichierLu {
  nom: string;
  /** Contenu ; null pour un fichier trop gros, refusé sans être lu. */
  texte: string | null;
}

/** Taux avant / depuis d'un groupe, et évolution relative. */
interface Taux {
  avant: number | null;
  depuis: number | null;
  /** En % (négatif : baisse) ; null si non mesurable. */
  evolution: number | null;
}

export interface LigneParticipant {
  /** 8 premiers caractères de l'identifiant (comme le nom du fichier). */
  participant: string;
  fichier: string;
  application: string;
  plateforme: string;
  semaines: number;
  textes: number;
  mots: number;
  reglesSuivies: number;
  reglesSuffisantes: number;
  suivies: Taux;
  comparaison: Taux;
  /** Bonnes réponses aux choix, en % ; null sans réponse. */
  bonsChoix: number | null;
  reponses: number;
  acquises: number;
  acquisesRestees: number;
}

export interface Agregat {
  refuses: { fichier: string; raison: string }[];
  /** Exports plus anciens d'un participant déjà retenu. */
  ecartes: string[];
  participants: LigneParticipant[];
  global: {
    suivies: Taux & { participants: number };
    comparaison: Taux & { participants: number };
    /** Participants dont le taux des fautes suivies baisse, parmi ceux qui ont une mesure. */
    enBaisse: number;
    mesures: number;
    /** Médiane des évolutions des fautes suivies, en % ; null sans mesure. */
    medianeEvolution: number | null;
  };
  /** Vrai si les exports n'ont pas tous été calculés avec les mêmes seuils. */
  seuilsDifferents: boolean;
}

const PAR_MOTS = 1000;
const arrondi = (n: number, chiffres = 1) => Math.round(n * 10 ** chiffres) / 10 ** chiffres;
const taux = (fautes: number, mots: number) => (mots > 0 ? (fautes / mots) * PAR_MOTS : null);

function evolution(fa: number, ma: number, fd: number, md: number): number | null {
  if (ma <= 0 || md <= 0 || fa <= 0) return null;
  const a = fa / ma;
  return Math.round(((fd / md - a) / a) * 100);
}

function tauxGroupe(s: SyntheseExport): Taux {
  const mesurable = s.reglesSuffisantes > 0;
  return {
    avant: mesurable ? taux(s.avant.fautes, s.avant.mots) : null,
    depuis: mesurable ? taux(s.depuis.fautes, s.depuis.mots) : null,
    evolution: mesurable
      ? evolution(s.avant.fautes, s.avant.mots, s.depuis.fautes, s.depuis.mots)
      : null,
  };
}

function mediane(valeurs: number[]): number | null {
  if (valeurs.length === 0) return null;
  const tri = [...valeurs].sort((a, b) => a - b);
  const m = tri.length >> 1;
  return tri.length % 2 ? tri[m] : (tri[m - 1] + tri[m]) / 2;
}

/** Agrège des fichiers déjà lus (calcul pur, testable). */
export function agreger(fichiers: readonly FichierLu[]): Agregat {
  const refuses: Agregat["refuses"] = [];
  const parParticipant = new Map<string, { exp: ExportBeta; fichier: string }>();
  const ecartes: string[] = [];
  const total = (e: ExportBeta) => e.semaines.reduce((n, s) => n + s.textes, 0);

  for (const { nom, texte } of [...fichiers].sort((a, b) => (a.nom < b.nom ? -1 : 1))) {
    const resultat =
      texte === null
        ? { ok: false as const, erreur: "fichier trop gros" }
        : validerTexteExport(texte);
    if (!resultat.ok) {
      refuses.push({ fichier: nom, raison: resultat.erreur });
      continue;
    }
    const exp = resultat.export;
    const deja = parParticipant.get(exp.participant);
    const plusRecent =
      !deja ||
      exp.semaines.length > deja.exp.semaines.length ||
      (exp.semaines.length === deja.exp.semaines.length && total(exp) > total(deja.exp));
    if (plusRecent) {
      if (deja) ecartes.push(deja.fichier);
      parParticipant.set(exp.participant, { exp, fichier: nom });
    } else {
      ecartes.push(nom);
    }
  }

  const retenus = [...parParticipant.values()];
  const participants: LigneParticipant[] = retenus.map(({ exp, fichier }) => {
    const s = exp.synthese;
    const reponses = s.choix.justes + s.choix.fausses;
    return {
      participant: exp.participant.slice(0, 8),
      fichier,
      application: exp.application,
      plateforme: exp.plateforme,
      semaines: exp.semaines.length,
      textes: total(exp),
      mots: exp.semaines.reduce((n, x) => n + x.mots, 0),
      reglesSuivies: s.suivies.regles,
      reglesSuffisantes: s.suivies.reglesSuffisantes,
      suivies: tauxGroupe(s.suivies),
      comparaison: tauxGroupe(s.comparaison),
      bonsChoix: reponses > 0 ? Math.round((s.choix.justes / reponses) * 100) : null,
      reponses,
      acquises: s.acquises.total,
      acquisesRestees: s.acquises.restees,
    };
  });
  participants.sort((a, b) => (a.participant < b.participant ? -1 : 1));

  /** Somme des fautes sur somme des mots, tous participants mesurés confondus. */
  const sommeGroupe = (groupe: "suivies" | "comparaison") => {
    let fa = 0;
    let ma = 0;
    let fd = 0;
    let md = 0;
    let n = 0;
    for (const { exp } of retenus) {
      const s = exp.synthese[groupe];
      if (s.reglesSuffisantes === 0) continue;
      n++;
      fa += s.avant.fautes;
      ma += s.avant.mots;
      fd += s.depuis.fautes;
      md += s.depuis.mots;
    }
    return {
      participants: n,
      avant: taux(fa, ma),
      depuis: taux(fd, md),
      evolution: evolution(fa, ma, fd, md),
    };
  };
  const evolutions = participants
    .map((p) => p.suivies.evolution)
    .filter((e): e is number => e !== null);
  const seuils = new Set(retenus.map(({ exp }) => JSON.stringify(exp.seuils)));

  return {
    refuses,
    ecartes,
    participants,
    global: {
      suivies: sommeGroupe("suivies"),
      comparaison: sommeGroupe("comparaison"),
      enBaisse: evolutions.filter((e) => e < 0).length,
      mesures: evolutions.length,
      medianeEvolution: mediane(evolutions),
    },
    seuilsDifferents: seuils.size > 1,
  };
}

// ───────────────────────── Mise en forme ─────────────────────────

const fr = (n: number | null, chiffres = 1) =>
  n === null ? "–" : arrondi(n, chiffres).toLocaleString("fr-FR").replace(/ /g, " ");
const evo = (e: number | null) =>
  e === null
    ? "–"
    : e === 0
      ? "inchangé"
      : e < 0
        ? `${fr(-e, 0)} % de moins`
        : `${fr(e, 0)} % de plus`;

const MISES_EN_GARDE = [
  "Ce n'est pas une preuve. Peu de participants, peu de textes, et personne n'a été tiré au sort : les testeurs sont des volontaires, et rien ne dit que l'astuce, plutôt qu'autre chose, explique l'évolution.",
  "Une faute qui vient de revenir plusieurs fois revient souvent moins ensuite, astuce ou pas (retour à la normale). La ligne « fautes de frappe », qui ne reçoivent jamais d'astuce et sont prises au même moment (même seuil de 3 fautes en 7 jours), sert à en juger : si elles baissent autant, l'astuce n'y est sans doute pour rien.",
  "Les taux portent seulement sur les fautes que le correcteur a repérées dans les textes corrigés avec Grammaria, pas sur tout ce que les testeurs écrivent.",
  "Aucun texte n'a été collecté : chaque fichier ne contient que des nombres et des identifiants de règle.",
];

/** `synthese.md` : à lire sans connaissance technique. */
export function versMarkdown(a: Agregat): string {
  const l: string[] = [];
  const unite = `pour ${fr(PAR_MOTS, 0)} mots`;
  l.push("# Bêta de Grammaria : synthèse des résultats", "");
  l.push(
    `${a.participants.length} participant${a.participants.length > 1 ? "s" : ""} retenu${a.participants.length > 1 ? "s" : ""} (un seul fichier par personne : le plus récent).`,
  );
  if (a.refuses.length > 0) {
    l.push(
      "",
      `**${a.refuses.length} fichier${a.refuses.length > 1 ? "s refusés" : " refusé"}** (format non reconnu ou contenu non autorisé ; ${a.refuses.length > 1 ? "ils n'ont" : "il n'a"} pas été lu${a.refuses.length > 1 ? "s" : ""} plus loin) :`,
    );
    for (const r of a.refuses) l.push(`- ${r.fichier} (${r.raison})`);
  }
  if (a.ecartes.length > 0) {
    l.push(
      "",
      `Fichiers plus anciens d'un même participant, laissés de côté : ${a.ecartes.join(", ")}.`,
    );
  }
  if (a.seuilsDifferents) {
    l.push(
      "",
      "**Attention** : les fichiers n'ont pas tous été calculés avec les mêmes réglages (versions différentes de Grammaria). Les chiffres ci-dessous sont moins comparables.",
    );
  }

  const g = a.global;
  l.push("", "## En bref", "");
  if (g.suivies.participants === 0) {
    l.push("Pas encore assez de textes pour mesurer quoi que ce soit.");
  } else {
    l.push(
      `- **Fautes qui ont reçu une astuce** : ${fr(g.suivies.avant)} ${unite} avant la première astuce, ${fr(g.suivies.depuis)} depuis (${evo(g.suivies.evolution)}), tous participants confondus (${g.suivies.participants} participant${g.suivies.participants > 1 ? "s" : ""} avec assez de textes).`,
      `- **Pour comparer, les fautes de frappe** (jamais d'astuce) : ${g.comparaison.participants === 0 ? "pas encore assez de textes." : `${fr(g.comparaison.avant)} ${unite} avant le même seuil, ${fr(g.comparaison.depuis)} depuis (${evo(g.comparaison.evolution)}), sur ${g.comparaison.participants} participant${g.comparaison.participants > 1 ? "s" : ""}.`}`,
      `- **Le taux baisse pour ${g.enBaisse} participant${g.enBaisse > 1 ? "s" : ""} sur ${g.mesures}** ayant une mesure. Évolution médiane : ${evo(g.medianeEvolution === null ? null : Math.round(g.medianeEvolution))}.`,
    );
  }

  l.push("", "## Par participant", "");
  l.push(
    `| Participant | Semaines | Textes | Mots | Règles suivies (mesurées) | Avant l'astuce (${unite}) | Depuis | Évolution | Fautes de frappe : évolution | Bons choix | Acquises restées acquises |`,
    "|---|---:|---:|---:|---:|---:|---:|---|---|---:|---:|",
  );
  for (const p of a.participants) {
    l.push(
      `| ${p.participant} | ${p.semaines} | ${fr(p.textes, 0)} | ${fr(p.mots, 0)} | ${p.reglesSuivies} (${p.reglesSuffisantes}) | ${fr(p.suivies.avant)} | ${fr(p.suivies.depuis)} | ${evo(p.suivies.evolution)} | ${evo(p.comparaison.evolution)} | ${p.bonsChoix === null ? "–" : `${p.bonsChoix} % (sur ${p.reponses})`} | ${p.acquises === 0 ? "–" : `${p.acquisesRestees} sur ${p.acquises}`} |`,
    );
  }
  l.push(
    "",
    "Lecture : « Règles suivies (mesurées) » compte les fautes qui ont reçu une astuce, et entre parenthèses celles qui ont assez de textes avant et depuis pour être mesurées ; seules ces dernières entrent dans les taux. « – » : pas encore assez de textes.",
  );

  l.push("", "## À dire avant de citer ces chiffres", "");
  for (const m of MISES_EN_GARDE) l.push(`- ${m}`);
  l.push("");
  return l.join("\n");
}

/** `synthese.csv` : une ligne par participant, puis l'ensemble. Séparateur « ; », virgule décimale. */
export function versCsv(a: Agregat): string {
  const n = (x: number | null) => (x === null ? "" : String(arrondi(x, 2)).replace(".", ","));
  const lignes = [
    [
      "participant",
      "semaines",
      "textes",
      "mots",
      "regles_suivies",
      "regles_mesurees",
      "taux_avant_pour_1000_mots",
      "taux_depuis_pour_1000_mots",
      "evolution_pct",
      "frappe_taux_avant",
      "frappe_taux_depuis",
      "frappe_evolution_pct",
      "bons_choix_pct",
      "reponses",
      "acquises",
      "acquises_restees",
    ].join(";"),
  ];
  for (const p of a.participants) {
    lignes.push(
      [
        p.participant,
        p.semaines,
        p.textes,
        p.mots,
        p.reglesSuivies,
        p.reglesSuffisantes,
        n(p.suivies.avant),
        n(p.suivies.depuis),
        n(p.suivies.evolution),
        n(p.comparaison.avant),
        n(p.comparaison.depuis),
        n(p.comparaison.evolution),
        n(p.bonsChoix),
        p.reponses,
        p.acquises,
        p.acquisesRestees,
      ].join(";"),
    );
  }
  const g = a.global;
  lignes.push(
    [
      "ensemble",
      "",
      a.participants.reduce((s, p) => s + p.textes, 0),
      a.participants.reduce((s, p) => s + p.mots, 0),
      a.participants.reduce((s, p) => s + p.reglesSuivies, 0),
      a.participants.reduce((s, p) => s + p.reglesSuffisantes, 0),
      n(g.suivies.avant),
      n(g.suivies.depuis),
      n(g.suivies.evolution),
      n(g.comparaison.avant),
      n(g.comparaison.depuis),
      n(g.comparaison.evolution),
      "",
      a.participants.reduce((s, p) => s + p.reponses, 0),
      a.participants.reduce((s, p) => s + p.acquises, 0),
      a.participants.reduce((s, p) => s + p.acquisesRestees, 0),
    ].join(";"),
  );
  return `${lignes.join("\n")}\n`;
}

/** Lit les `.json` du dossier : un fichier trop gros est refusé sans être lu. */
export function lireDossier(dossier: string): FichierLu[] {
  const fichiers: FichierLu[] = [];
  for (const nom of readdirSync(dossier)) {
    if (!nom.toLowerCase().endsWith(".json")) continue;
    const chemin = join(dossier, nom);
    const info = statSync(chemin);
    if (!info.isFile()) continue;
    const texte = info.size > LIMITES_EXPORT.octets ? null : readFileSync(chemin, "utf8");
    fichiers.push({ nom, texte });
  }
  return fichiers;
}

if (import.meta.main) {
  const dossier = process.argv[2];
  if (!dossier) {
    console.error("Usage : npm run beta:agreger -- <dossier des exports>");
    process.exit(1);
  }
  const agregat = agreger(lireDossier(dossier));
  for (const r of agregat.refuses) {
    console.error(`Fichier refusé : ${r.fichier} (${r.raison})`);
  }
  writeFileSync(join(dossier, "synthese.md"), versMarkdown(agregat));
  writeFileSync(join(dossier, "synthese.csv"), versCsv(agregat));
  console.log(
    `${agregat.participants.length} participant(s) retenu(s), ${agregat.refuses.length} fichier(s) refusé(s). ` +
      `Synthèse écrite dans ${join(dossier, "synthese.md")} et synthese.csv.`,
  );
}

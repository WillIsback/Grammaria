/**
 * Compare deux moteurs grammaticaux à partir de leurs mesures (mesurer-moteur.ts,
 * mesurer-serveur.ts) : la référence (dernière version publiée) et la version expérimentale.
 *
 * Qualité, à réponse du modèle égale (corrigés écrits à la main, corriges.ts) :
 *  - fautes de référence = modifications du corrigé, hors ponctuation (comme l'application) ;
 *  - couverture : part de ces fautes sur lesquelles le moteur a une détection ;
 *  - résultat dans l'application : `analyze()` (fiches, détections, accord) → modifications
 *    classées ou non, fautes comptées, note ;
 *  - bruit : détections qui ne touchent aucune modification (écartées par l'application) ;
 *  - exemples de règles de LanguageTool : faute marquée détectée, phrase correcte laissée propre.
 *
 * Usage (Bun) :
 *   bun scripts/comparaison/rapport.ts --reference <moteur.json> --experimental <moteur.json>
 *       [--serveur-reference <serveur.json> --serveur-experimental <serveur.json>]
 *       [--sortie <rapport.json>]
 * Écrit le résumé en Markdown sur la sortie standard.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { analyze, isCounted, isPunctuationOnly } from "../../src/analysis/analyze.ts";
import { diffHunks, type Hunk } from "../../src/analysis/diff.ts";
import type { LTMatch } from "../../src/types.ts";
import { CORPUS } from "../../tests/fixtures/correcteur/corpus.ts";
import { CORRIGES } from "./corriges.ts";
import type { Detection, ExempleLt, MesureMoteur } from "./mesurer-moteur.ts";
import type { MesureServeur } from "./mesurer-serveur.ts";

const args = process.argv.slice(2);
const option = (nom: string): string | undefined => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};
const lire = <T>(chemin: string): T => JSON.parse(readFileSync(chemin, "utf8")) as T;

const versMatch = (d: Detection): LTMatch => ({
  message: d.message,
  shortMessage: "",
  offset: d.debut,
  length: d.longueur,
  replacements: d.suggestions.map((value) => ({ value })),
  rule: { id: d.regle, issueType: d.issueType, category: { id: d.categorie, name: d.categorie } },
});

/** Même règle de recouvrement que l'application (analyze.ts). */
function touche(hunk: Hunk, d: { debut: number; longueur: number }): boolean {
  const fin = d.debut + d.longueur;
  if (hunk.start === hunk.end) return d.debut <= hunk.start && hunk.start <= fin;
  return d.debut < hunk.end && hunk.start < fin;
}

const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(0)} %` : "—");
const somme = (valeurs: number[]) => valeurs.reduce((a, b) => a + b, 0);

/** Textes composés : exclus des comptes de qualité (ils répètent les autres). */
const COMPOSES = new Set(["long", "tres-long"]);

interface FauteReference {
  texte: string;
  avant: string;
  apres: string;
  /** Règles des détections qui touchent la faute, par moteur. */
  regles: [string[], string[]];
}

interface QualiteTexte {
  nom: string;
  fautes: number;
  couvertes: number;
  detections: number;
  /** Détections qui ne touchent aucune modification du corrigé. */
  bruit: number;
  classees: number;
  parSource: { fiche: number; lt: number; accord: number };
  nonClassees: number;
  fautesComptees: number;
  note: number | null;
}

function qualite(moteur: MesureMoteur, indice: 0 | 1, fautes: Map<string, FauteReference[]>) {
  const textes: QualiteTexte[] = [];
  const bruit: { texte: string; regle: string; passage: string }[] = [];
  for (const { nom, texte } of CORPUS) {
    if (COMPOSES.has(nom)) continue;
    const mesure = moteur.corpus.find((t) => t.nom === nom);
    if (!mesure) throw new Error(`Texte « ${nom} » absent des mesures de ${moteur.nom}`);
    const corrige = CORRIGES[nom];
    const hunks = diffHunks(texte, corrige);
    const references = hunks.filter((h) => !isPunctuationOnly(h.before, h.after));
    if (!fautes.has(nom)) {
      fautes.set(
        nom,
        references.map((h) => ({ texte: nom, avant: h.before, apres: h.after, regles: [[], []] })),
      );
    }
    const liste = fautes.get(nom) ?? [];
    let couvertes = 0;
    for (const [i, hunk] of references.entries()) {
      const regles = mesure.detections.filter((d) => touche(hunk, d)).map((d) => d.regle);
      liste[i].regles[indice] = regles;
      if (regles.length > 0) couvertes++;
    }
    const horsModification = mesure.detections.filter((d) => !hunks.some((h) => touche(h, d)));
    for (const d of horsModification) {
      bruit.push({
        texte: nom,
        regle: d.regle,
        passage: texte.slice(d.debut, d.debut + d.longueur),
      });
    }
    const analyse = analyze(texte, corrige, mesure.detections.map(versMatch));
    const source = (s: string) =>
      analyse.corrections.filter((c) => c.faults.some((f) => f.source === s)).length;
    textes.push({
      nom,
      fautes: references.length,
      couvertes,
      detections: mesure.detections.length,
      bruit: horsModification.length,
      classees: analyse.corrections.filter((c) => c.faults.length > 0).length,
      parSource: { fiche: source("fiche"), lt: source("lt"), accord: source("accord") },
      nonClassees: analyse.unclassifiedCount,
      fautesComptees: analyse.faultCount,
      note: analyse.score,
    });
  }
  const total = (champ: (t: QualiteTexte) => number) => somme(textes.map(champ));
  return {
    textes,
    bruit,
    total: {
      fautes: total((t) => t.fautes),
      couvertes: total((t) => t.couvertes),
      detections: total((t) => t.detections),
      bruit: total((t) => t.bruit),
      classees: total((t) => t.classees),
      fiche: total((t) => t.parSource.fiche),
      lt: total((t) => t.parSource.lt),
      accord: total((t) => t.parSource.accord),
      nonClassees: total((t) => t.nonClassees),
      fautesComptees: total((t) => t.fautesComptees),
    },
  };
}

/** Exemples de règles de LanguageTool : faute marquée détectée, phrase correcte laissée propre. */
function exemples(liste: ExempleLt[]) {
  const fautifs = liste.filter((e) => e.marques.length > 0);
  const corrects = liste.filter((e) => e.marques.length === 0);
  const surMarque = (e: ExempleLt) =>
    e.detections.filter((d) => e.marques.some(([a, b]) => d.debut < b && d.debut + d.longueur > a));
  return {
    fautifs: fautifs.length,
    detectes: fautifs.filter((e) => surMarque(e).length > 0).length,
    memeRegle: fautifs.filter((e) => surMarque(e).some((d) => d.regle === e.regle)).length,
    corrects: corrects.length,
    propres: corrects.filter((e) => e.detections.length === 0).length,
  };
}

function main() {
  const cheminReference = option("--reference");
  const cheminExperimental = option("--experimental");
  if (!cheminReference || !cheminExperimental) {
    throw new Error("--reference et --experimental sont requis");
  }
  const reference = lire<MesureMoteur>(cheminReference);
  const experimental = lire<MesureMoteur>(cheminExperimental);
  const fautes = new Map<string, FauteReference[]>();
  const q = [qualite(reference, 0, fautes), qualite(experimental, 1, fautes)] as const;
  const noms = [reference.nom, experimental.nom] as const;
  const lignes: string[] = [];
  const ecrire = (ligne = "") => lignes.push(ligne);
  const tableau = (entetes: string[], rangs: (string | number)[][]) => {
    ecrire(`| ${entetes.join(" | ")} |`);
    ecrire(`| ${entetes.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`);
    for (const rang of rangs) ecrire(`| ${rang.join(" | ")} |`);
    ecrire();
  };

  // ───────────── Qualité sur le corpus ─────────────
  ecrire("## Qualité sur le corpus du correcteur");
  ecrire();
  const [a, b] = [q[0].total, q[1].total];
  ecrire(
    `${q[0].textes.length} textes, ${a.fautes} fautes de référence (modifications du corrigé, hors ponctuation).`,
  );
  ecrire();
  tableau(
    ["", noms[0], noms[1]],
    [
      ["Détections brutes", a.detections, b.detections],
      [
        "Fautes de référence couvertes par une détection",
        `${a.couvertes} (${pct(a.couvertes, a.fautes)})`,
        `${b.couvertes} (${pct(b.couvertes, b.fautes)})`,
      ],
      [
        "Détections hors de toute modification (écartées)",
        `${a.bruit} (${pct(a.bruit, a.detections)})`,
        `${b.bruit} (${pct(b.bruit, b.detections)})`,
      ],
      [
        "Dans l'application : modifications classées",
        `${a.classees} (${pct(a.classees, a.classees + a.nonClassees)})`,
        `${b.classees} (${pct(b.classees, b.classees + b.nonClassees)})`,
      ],
      ["— par une fiche de confusion", a.fiche, b.fiche],
      ["— par une règle du moteur", a.lt, b.lt],
      ["— par le repli « accord »", a.accord, b.accord],
      ["Modifications non classées", a.nonClassees, b.nonClassees],
      ["Fautes comptées dans la note", a.fautesComptees, b.fautesComptees],
    ],
  );

  ecrire("### Par texte");
  ecrire();
  tableau(
    [
      "Texte",
      "Fautes",
      `Couvertes ${noms[0]}`,
      `Couvertes ${noms[1]}`,
      `Non classées ${noms[0]}`,
      `Non classées ${noms[1]}`,
      `Note ${noms[0]}`,
      `Note ${noms[1]}`,
    ],
    q[0].textes.map((t, i) => {
      const e = q[1].textes[i];
      return [
        t.nom,
        t.fautes,
        t.couvertes,
        e.couvertes,
        t.nonClassees,
        e.nonClassees,
        t.note ?? "—",
        e.note ?? "—",
      ];
    }),
  );

  // Fautes couvertes par un seul des deux moteurs, et accord sur la règle.
  const toutes = [...fautes.values()].flat();
  const lesDeux = toutes.filter((f) => f.regles[0].length > 0 && f.regles[1].length > 0);
  const seulReference = toutes.filter((f) => f.regles[0].length > 0 && f.regles[1].length === 0);
  const seulExperimental = toutes.filter((f) => f.regles[0].length === 0 && f.regles[1].length > 0);
  const aucun = toutes.filter((f) => f.regles[0].length === 0 && f.regles[1].length === 0);
  const memeRegle = lesDeux.filter((f) => f.regles[0].some((r) => f.regles[1].includes(r)));
  ecrire("### Fautes de référence : qui les voit");
  ecrire();
  tableau(
    ["", "Fautes"],
    [
      ["Vues par les deux moteurs", lesDeux.length],
      [
        "— dont avec au moins une règle commune",
        `${memeRegle.length} (${pct(memeRegle.length, lesDeux.length)})`,
      ],
      [`Vues seulement par ${noms[0]} (perdues)`, seulReference.length],
      [`Vues seulement par ${noms[1]} (gagnées)`, seulExperimental.length],
      ["Vues par aucun", aucun.length],
    ],
  );
  const lister = (titre: string, liste: FauteReference[], moteur: 0 | 1) => {
    if (liste.length === 0) return;
    ecrire(`**${titre}**`);
    ecrire();
    for (const f of liste) {
      ecrire(
        `- ${f.texte} : « ${f.avant.trim()} » → « ${f.apres.trim()} » (${[...new Set(f.regles[moteur])].join(", ")})`,
      );
    }
    ecrire();
  };
  lister(`Perdues (vues seulement par ${noms[0]})`, seulReference, 0);
  lister(`Gagnées (vues seulement par ${noms[1]})`, seulExperimental, 1);

  // Règles perdues : poids de la règle d'orthographe.
  const compter = (liste: string[]) => {
    const n = new Map<string, number>();
    for (const r of liste) n.set(r, (n.get(r) ?? 0) + 1);
    return [...n.entries()].sort((x, y) => y[1] - x[1]);
  };
  const detectionsDe = (m: MesureMoteur) =>
    m.corpus.filter((t) => !COMPOSES.has(t.nom)).flatMap((t) => t.detections);
  ecrire("### Règles les plus déclenchées (corpus, détections brutes)");
  ecrire();
  for (const [i, m] of [reference, experimental].entries()) {
    const regles = compter(detectionsDe(m).map((d) => d.regle));
    ecrire(
      `- **${noms[i]}** (${regles.length} règles distinctes) : ${regles
        .slice(0, 12)
        .map(([r, n]) => `${r} ×${n}`)
        .join(", ")}`,
    );
  }
  ecrire();
  const comptees = (m: MesureMoteur) =>
    detectionsDe(m).filter((d) => isCounted(versMatch(d))).length;
  const types = (m: MesureMoteur) =>
    compter(detectionsDe(m).map((d) => d.issueType || "(vide)"))
      .map(([t, n]) => `${t} ×${n}`)
      .join(", ");
  ecrire(
    `Types de détection (\`issueType\`, dont dépend ce qui compte dans la note) : ${noms[0]} : ${types(reference)} ; ${noms[1]} : ${types(experimental)}.`,
  );
  ecrire(
    `Détections qui compteraient dans la note : ${noms[0]} ${comptees(reference)}/${detectionsDe(reference).length}, ${noms[1]} ${comptees(experimental)}/${detectionsDe(experimental).length}.`,
  );
  ecrire();

  // Fidélité : quand la même règle se déclenche au même endroit, le passage signalé est-il le
  // même ? L'application enregistre ce passage comme « mot fautif » dans le journal.
  const parTexte = (m: MesureMoteur) =>
    m.corpus.filter((t) => !COMPOSES.has(t.nom)).map((t) => t.detections);
  let memeRegleMemeEndroit = 0;
  let memePassage = 0;
  for (const [i, detectionsReference] of parTexte(reference).entries()) {
    for (const d of parTexte(experimental)[i]) {
      const jumelles = detectionsReference.filter(
        (r) =>
          r.regle === d.regle && r.debut < d.debut + d.longueur && d.debut < r.debut + r.longueur,
      );
      if (jumelles.length === 0) continue;
      memeRegleMemeEndroit++;
      if (jumelles.some((r) => r.debut === d.debut && r.longueur === d.longueur)) memePassage++;
    }
  }
  const moyenne = (m: MesureMoteur) => {
    const d = detectionsDe(m);
    return d.length ? (somme(d.map((x) => x.longueur)) / d.length).toFixed(1) : "—";
  };
  const sansSuggestion = (m: MesureMoteur) =>
    detectionsDe(m).filter((d) => d.suggestions.length === 0).length;
  ecrire("### Fidélité des détections");
  ecrire();
  tableau(
    ["", noms[0], noms[1]],
    [
      [
        "Longueur moyenne du passage signalé (caractères)",
        moyenne(reference),
        moyenne(experimental),
      ],
      [
        "Détections sans suggestion",
        `${sansSuggestion(reference)}/${detectionsDe(reference).length}`,
        `${sansSuggestion(experimental)}/${detectionsDe(experimental).length}`,
      ],
    ],
  );
  ecrire(
    `Sur les ${detectionsDe(experimental).length} détections de ${noms[1]}, ${memeRegleMemeEndroit} portent la même règle qu'une détection de ${noms[0]} au même endroit ; ${memePassage} signalent exactement le même passage.`,
  );
  ecrire();

  ecrire("### Bruit sur les textes sans faute");
  ecrire();
  for (const [i, resultat] of q.entries()) {
    const sansFaute = resultat.bruit.filter((d) => d.texte.startsWith("sans-faute"));
    ecrire(
      `- **${noms[i]}** : ${sansFaute.length} détection(s)${
        sansFaute.length
          ? ` — ${sansFaute.map((d) => `${d.regle} « ${d.passage} »`).join(" ; ")}`
          : ""
      }`,
    );
  }
  ecrire();

  // ───────────── Exemples de LanguageTool ─────────────
  let exemplesLt: [ReturnType<typeof exemples>, ReturnType<typeof exemples>] | null = null;
  if (reference.exemples.length > 0 && experimental.exemples.length > 0) {
    exemplesLt = [exemples(reference.exemples), exemples(experimental.exemples)];
    const [x, y] = exemplesLt;
    ecrire("## Exemples des règles de LanguageTool");
    ecrire();
    ecrire(
      `Échantillon de ${x.fautifs} phrases fautives (passage marqué) et ${x.corrects} phrases correctes, tirées des fichiers de règles.`,
    );
    ecrire();
    tableau(
      ["", noms[0], noms[1]],
      [
        [
          "Faute marquée détectée",
          `${x.detectes} (${pct(x.detectes, x.fautifs)})`,
          `${y.detectes} (${pct(y.detectes, y.fautifs)})`,
        ],
        [
          "— avec la règle attendue",
          `${x.memeRegle} (${pct(x.memeRegle, x.fautifs)})`,
          `${y.memeRegle} (${pct(y.memeRegle, y.fautifs)})`,
        ],
        [
          "Phrase correcte laissée sans détection",
          `${x.propres} (${pct(x.propres, x.corrects)})`,
          `${y.propres} (${pct(y.propres, y.corrects)})`,
        ],
      ],
    );
  }

  // ───────────── Performances ─────────────
  ecrire("## Performances du moteur (dans le processus du serveur)");
  ecrire();
  const fois = (x: number, y: number) => (y > 0 ? `×${(x / y).toFixed(1)}` : "—");
  const rangs: (string | number)[][] = [
    [
      "Chargement (premier contrôle)",
      `${reference.chargementMs} ms`,
      `${experimental.chargementMs} ms`,
      fois(reference.chargementMs, experimental.chargementMs),
    ],
  ];
  for (const nom of ["court", "marche-160-mots", "long", "tres-long"]) {
    const x = reference.corpus.find((t) => t.nom === nom);
    const y = experimental.corpus.find((t) => t.nom === nom);
    if (!x || !y) continue;
    rangs.push([
      `Contrôle à chaud, ${x.mots} mots (médiane)`,
      `${x.ms.mediane} ms`,
      `${y.ms.mediane} ms`,
      fois(x.ms.mediane, y.ms.mediane),
    ]);
  }
  if (reference.exemplesMs && experimental.exemplesMs) {
    rangs.push([
      "Phrase isolée (moyenne sur les exemples)",
      `${reference.exemplesMs.parPhrase} ms`,
      `${experimental.exemplesMs.parPhrase} ms`,
      fois(reference.exemplesMs.parPhrase, experimental.exemplesMs.parPhrase),
    ]);
  }
  const memoire = (m: MesureMoteur) => m.memoireMo.apresCorpus - m.memoireMo.avant;
  rangs.push([
    "Mémoire ajoutée par le moteur (après le corpus)",
    `${memoire(reference).toFixed(0)} Mo`,
    `${memoire(experimental).toFixed(0)} Mo`,
    fois(memoire(reference), memoire(experimental)),
  ]);
  tableau(["", noms[0], noms[1], "Gain"], rangs);

  const cheminServeurReference = option("--serveur-reference");
  const cheminServeurExperimental = option("--serveur-experimental");
  let serveurs: [MesureServeur, MesureServeur] | null = null;
  if (cheminServeurReference && cheminServeurExperimental) {
    serveurs = [
      lire<MesureServeur>(cheminServeurReference),
      lire<MesureServeur>(cheminServeurExperimental),
    ];
    const [x, y] = serveurs;
    const mediane = (v: number[]) => [...v].sort((p, r) => p - r)[Math.floor(v.length / 2)];
    ecrire("## Performances du serveur, de bout en bout (POST /api/check)");
    ecrire();
    const rangsServeur: (string | number)[][] = [
      [
        "Démarrage → premier contrôle servi",
        `${mediane(x.demarrageMs)} ms`,
        `${mediane(y.demarrageMs)} ms`,
        fois(mediane(x.demarrageMs), mediane(y.demarrageMs)),
      ],
    ];
    for (const [i, l] of x.latence.entries()) {
      const e = y.latence[i];
      rangsServeur.push([
        `Latence, ${l.mots} mots (médiane / p95)`,
        `${l.ms.mediane} / ${l.ms.p95} ms`,
        `${e.ms.mediane} / ${e.ms.p95} ms`,
        fois(l.ms.mediane, e.ms.mediane),
      ]);
    }
    rangsServeur.push(
      [
        `Débit, ${x.debit.simultanees} clients (160 mots)`,
        `${x.debit.parSeconde} req/s`,
        `${y.debit.parSeconde} req/s`,
        fois(y.debit.parSeconde, x.debit.parSeconde),
      ],
      [
        "Mémoire du serveur au repos",
        `${x.memoireMo.apresDemarrage.toFixed(0)} Mo`,
        `${y.memoireMo.apresDemarrage.toFixed(0)} Mo`,
        fois(x.memoireMo.apresDemarrage, y.memoireMo.apresDemarrage),
      ],
      [
        "Mémoire du serveur après la charge",
        `${x.memoireMo.apresCharge.toFixed(0)} Mo`,
        `${y.memoireMo.apresCharge.toFixed(0)} Mo`,
        fois(x.memoireMo.apresCharge, y.memoireMo.apresCharge),
      ],
    );
    tableau(["", noms[0], noms[1], "Gain"], rangsServeur);
  }

  const sortie = option("--sortie");
  if (sortie) {
    writeFileSync(
      sortie,
      `${JSON.stringify(
        {
          moteurs: noms,
          corpus: { reference: q[0], experimental: q[1], fautes: toutes },
          exemples: exemplesLt,
          moteur: {
            reference: { chargementMs: reference.chargementMs, memoireMo: reference.memoireMo },
            experimental: {
              chargementMs: experimental.chargementMs,
              memoireMo: experimental.memoireMo,
            },
          },
          serveurs,
        },
        null,
        1,
      )}\n`,
    );
  }
  console.log(lignes.join("\n"));
}

if (import.meta.main) main();

/**
 * Simulation d'un journal réaliste, pour les tests et les vérifications à la
 * main (pas pour les utilisateurs) : un texte d'environ 150 mots par jour
 * ouvré pendant `jours` jours, des confusions de mots (a / à, on / ont…) qui
 * reviennent tous les deux ou trois textes et deviennent plus rares après
 * l'astuce, et des fautes de frappe. Les textes sont inventés et n'existent
 * que le temps de la correction simulée : le journal n'en garde rien.
 *
 *   bun scripts/beta/simuler.ts <journal.db> [jours] [graine]
 */
import { Journal } from "../../journal.ts";
import { ouvrirPiloteBun } from "../../journal.driver.bun.ts";
import { analyze } from "../../src/analysis/analyze.ts";
import type { LTMatch } from "../../src/types.ts";

const JOUR = 24 * 60 * 60 * 1000;

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function aleatoire(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REMPLISSAGE =
  "nous avons préparé le dossier pour la réunion de demain avec toute l équipe du service".split(
    " ",
  );

/** Confusions simulées : forme fautive, forme correcte, probabilité avant et après l'astuce. */
const CONFUSIONS = [
  { fautive: "à", correcte: "a", avant: 0.45, apres: 0.15, cle: "PAIRE:a/à" },
  { fautive: "on", correcte: "ont", avant: 0.35, apres: 0.12, cle: "PAIRE:on/ont" },
  { fautive: "et", correcte: "est", avant: 0.3, apres: 0.2, cle: "PAIRE:et/est" },
  { fautive: "ses", correcte: "ces", avant: 0.12, apres: 0.08, cle: "PAIRE:ces/ses" },
];

export interface OptionsSimulation {
  jours: number;
  graine: number;
  /** Premier jour simulé (midi, heure locale). */
  debut: number;
  /** Fautes de frappe par texte, en moyenne. */
  frappesParTexte?: number;
}

/** Corrige `jours` textes simulés dans `journal`. */
export async function simuler(journal: Journal, options: OptionsSimulation): Promise<void> {
  const hasard = aleatoire(options.graine);
  const astuces = new Set<string>();
  const lambda = options.frappesParTexte ?? 0.6;
  for (let j = 0; j < options.jours; j++) {
    const date = new Date(options.debut + j * JOUR);
    // Pas de texte le week-end, et un jour ouvré sur dix sans texte.
    if (date.getDay() === 0 || date.getDay() === 6 || hasard() < 0.1) continue;
    const at = options.debut + j * JOUR + Math.floor(hasard() * 6 * 60 * 60 * 1000);
    const avant: string[] = [];
    const apres: string[] = [];
    const matches: LTMatch[] = [];
    const ajouter = (a: string, b: string, match?: Omit<LTMatch, "offset" | "length">) => {
      const offset = avant.join(" ").length + (avant.length > 0 ? 1 : 0);
      if (match) matches.push({ ...match, offset, length: a.length });
      avant.push(a);
      apres.push(b);
    };
    const mots = 130 + Math.floor(hasard() * 40);
    const fautes: { a: string; b: string; frappe: boolean }[] = [];
    for (const c of CONFUSIONS) {
      const p = astuces.has(c.cle) ? c.apres : c.avant;
      if (hasard() < p) fautes.push({ a: c.fautive, b: c.correcte, frappe: false });
    }
    // Loi de Poisson approchée pour les fautes de frappe.
    let k = 0;
    for (let seuil = Math.exp(-lambda), produit = hasard(); produit > seuil; produit *= hasard()) {
      k++;
    }
    for (let i = 0; i < k; i++) fautes.push({ a: "dosier", b: "dossier", frappe: true });
    const places = new Map<number, (typeof fautes)[number]>();
    for (const f of fautes) {
      let place = 1 + Math.floor(hasard() * (mots - 2));
      while (places.has(place)) place = (place + 1) % mots;
      places.set(place, f);
    }
    for (let i = 0; i < mots; i++) {
      const f = places.get(i);
      if (!f) {
        const mot = REMPLISSAGE[i % REMPLISSAGE.length];
        ajouter(mot, mot);
      } else if (f.frappe) {
        ajouter(f.a, f.b, {
          message: "Faute de frappe possible trouvée.",
          shortMessage: "",
          replacements: [{ value: f.b }],
          rule: {
            id: "FR_SPELLING_RULE",
            description: "Faute de frappe possible",
            issueType: "misspelling",
            category: { id: "TYPOS", name: "Faute de frappe possible" },
          },
        });
      } else {
        ajouter(f.a, f.b);
      }
    }
    const original = `${avant.join(" ")}.`;
    const corrige = `${apres.join(" ")}.`;
    const suivi = await journal.record(analyze(original, corrige, matches), at, {
      original,
      random: hasard,
    });
    const intervention = suivi.intervention;
    if (intervention) {
      astuces.add(intervention.ruleKey);
      // Réponse au choix à deux formes : juste trois fois sur quatre.
      if (intervention.type === "choix") {
        await journal.answerChoice(intervention.choiceId, hasard() < 0.75, at + 1000);
      }
    }
  }
}

if (import.meta.main) {
  const [chemin, jours = "42", graine = "1"] = process.argv.slice(2);
  if (!chemin) {
    console.error("Usage : bun scripts/beta/simuler.ts <journal.db> [jours] [graine]");
    process.exit(1);
  }
  const journal = await Journal.ouvrir(ouvrirPiloteBun(chemin));
  const debut = new Date();
  debut.setHours(9, 0, 0, 0);
  await simuler(journal, {
    jours: Number(jours),
    graine: Number(graine),
    debut: debut.getTime() - Number(jours) * JOUR,
  });
  await journal.close();
  console.log(`Journal simulé : ${jours} jours dans ${chemin}`);
}

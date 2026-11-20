/**
 * Mesure un moteur grammatical par la classe `GrammarChecker` d'un arbre de sources de
 * Grammaria (grammar.ts) : la dernière version publiée (portage JavaScript de LanguageTool
 * dans un Worker) comme la version expérimentale (moteur Rust grammaria-rc) exposent le même
 * contrat, ce script les mesure donc de la même façon.
 *
 * Produit un JSON : détections sur le corpus du correcteur et sur un échantillon des exemples
 * de règles de LanguageTool, temps (chargement, contrôles à chaud) et mémoire résidente.
 *
 * Usage (Bun) :
 *   bun scripts/comparaison/mesurer-moteur.ts --racine <arbre> --nom <étiquette> --sortie <fichier.json>
 *       [--exemples <lt_examples_fr.json>] [--echantillon 1000] [--repetitions 15]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LTMatch } from "../../src/types.ts";
import { CORPUS } from "../../tests/fixtures/correcteur/corpus.ts";

interface Checker {
  check(text: string): Promise<LTMatch[]>;
  close(): void;
}

export interface Detection {
  regle: string;
  debut: number;
  longueur: number;
  issueType: string;
  categorie: string;
  message: string;
  suggestions: string[];
}

export interface Temps {
  mediane: number;
  p95: number;
  min: number;
  max: number;
}

export interface MesureTexte {
  nom: string;
  mots: number;
  caracteres: number;
  detections: Detection[];
  ms: Temps;
}

export interface ExempleLt {
  /** Règle de LanguageTool dont l'exemple est tiré. */
  regle: string;
  texte: string;
  /** Passages fautifs marqués (unités UTF-16) ; vide : phrase donnée comme correcte. */
  marques: [number, number][];
  detections: { regle: string; debut: number; longueur: number }[];
}

export interface MesureMoteur {
  nom: string;
  racine: string;
  /** Premier contrôle (« Bonjour. »), chargement du moteur compris. */
  chargementMs: number;
  /** Mémoire résidente du processus et de ses enfants, en Mo. */
  memoireMo: { avant: number; apresChargement: number; apresCorpus: number; apresExemples: number };
  corpus: MesureTexte[];
  exemples: ExempleLt[];
  /** Durée totale et par phrase du passage des exemples. */
  exemplesMs: { total: number; parPhrase: number } | null;
}

const args = process.argv.slice(2);
const option = (nom: string): string | undefined => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Mémoire résidente (VmRSS) d'un processus et de tous ses descendants, en Mo. */
function memoireMo(pid: number = process.pid): number {
  let ko = 0;
  try {
    ko = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    const taches = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    for (const enfant of taches.split(/\s+/).filter(Boolean))
      ko += memoireMo(Number(enfant)) * 1024;
  } catch {
    /* processus terminé entre-temps */
  }
  return Math.round((ko / 1024) * 10) / 10;
}

function stat(durees: number[]): Temps {
  const t = [...durees].sort((a, b) => a - b);
  const arrondi = (n: number) => Math.round(n * 100) / 100;
  const rang = (q: number) => t[Math.min(t.length - 1, Math.floor(q * t.length))];
  return {
    mediane: arrondi(rang(0.5)),
    p95: arrondi(rang(0.95)),
    min: arrondi(t[0]),
    max: arrondi(t[t.length - 1]),
  };
}

function resumer(m: LTMatch): Detection {
  return {
    regle: m.rule.id,
    debut: m.offset,
    longueur: m.length,
    issueType: m.rule.issueType ?? "",
    categorie: m.rule.category?.id ?? "",
    message: m.shortMessage || m.message,
    suggestions: m.replacements.slice(0, 5).map((r) => r.value),
  };
}

/** Position en points de code (Python) → position en unités UTF-16 (JavaScript). */
function versUtf16(texte: string, position: number): number {
  let unites = 0;
  let points = 0;
  for (const caractere of texte) {
    if (points >= position) break;
    unites += caractere.length;
    points++;
  }
  return unites;
}

interface ExempleBrut {
  rule: string;
  text: string;
  markers: [number, number][];
}

/** Un exemple sur `pas`, à parts égales entre phrases fautives et phrases correctes. */
function echantillonner(exemples: ExempleBrut[], taille: number): ExempleBrut[] {
  const prendre = (liste: ExempleBrut[]) => {
    const pas = Math.max(1, Math.floor(liste.length / taille));
    return liste.filter((_, i) => i % pas === 0).slice(0, taille);
  };
  return [
    ...prendre(exemples.filter((e) => e.markers.length > 0)),
    ...prendre(exemples.filter((e) => e.markers.length === 0)),
  ];
}

async function main() {
  const racine = resolve(option("--racine") ?? ".");
  const nom = option("--nom") ?? racine;
  const sortie = option("--sortie");
  const repetitions = Number(option("--repetitions") ?? 15);
  const cheminExemples = option("--exemples");
  const echantillon = Number(option("--echantillon") ?? 1000);
  if (!sortie) throw new Error("--sortie <fichier.json> est requis");

  const { GrammarChecker } = (await import(join(racine, "grammar.ts"))) as {
    GrammarChecker: new () => Checker;
  };
  const checker = new GrammarChecker();
  try {
    const avant = memoireMo();
    const t0 = performance.now();
    await checker.check("Bonjour.");
    const chargementMs = Math.round(performance.now() - t0);
    const apresChargement = memoireMo();

    const corpus: MesureTexte[] = [];
    for (const { nom: nomTexte, texte } of CORPUS) {
      const detections = (await checker.check(texte)).map(resumer);
      const durees: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const t = performance.now();
        await checker.check(texte);
        durees.push(performance.now() - t);
      }
      corpus.push({
        nom: nomTexte,
        mots: texte.split(/\s+/).filter(Boolean).length,
        caracteres: texte.length,
        detections,
        ms: stat(durees),
      });
      console.error(
        `[${nom}] ${nomTexte} : ${detections.length} détections, médiane ${stat(durees).mediane} ms`,
      );
    }
    const apresCorpus = memoireMo();

    const exemples: ExempleLt[] = [];
    let exemplesMs: MesureMoteur["exemplesMs"] = null;
    if (cheminExemples) {
      const bruts = echantillonner(
        JSON.parse(readFileSync(cheminExemples, "utf8")) as ExempleBrut[],
        echantillon,
      );
      const debut = performance.now();
      for (const brut of bruts) {
        const texte = brut.text.trimEnd();
        const detections = (await checker.check(texte)).map((m) => ({
          regle: m.rule.id,
          debut: m.offset,
          longueur: m.length,
        }));
        exemples.push({
          regle: brut.rule,
          texte,
          marques: brut.markers.map(([a, b]) => [versUtf16(texte, a), versUtf16(texte, b)]),
          detections,
        });
      }
      const total = performance.now() - debut;
      exemplesMs = {
        total: Math.round(total),
        parPhrase: Math.round((total / Math.max(1, bruts.length)) * 100) / 100,
      };
      console.error(`[${nom}] ${bruts.length} exemples de règles en ${exemplesMs.total} ms`);
    }

    const mesure: MesureMoteur = {
      nom,
      racine,
      chargementMs,
      memoireMo: { avant, apresChargement, apresCorpus, apresExemples: memoireMo() },
      corpus,
      exemples,
      exemplesMs,
    };
    writeFileSync(sortie, `${JSON.stringify(mesure, null, 1)}\n`);
    console.error(`[${nom}] chargement ${chargementMs} ms → ${sortie}`);
  } finally {
    checker.close();
  }
}

if (import.meta.main) await main();

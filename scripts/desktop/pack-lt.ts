/**
 * Construit `lt/fr.pack`, l'archive des ressources LanguageTool du correcteur de l'application de
 * bureau (format décrit dans src/desktop/archive-lt.ts : signature `LTPACK01`, en-tête JSON avec
 * l'index et un CRC-32, puis les fichiers bout à bout).
 *
 * Contenu (décision du PO) : TOUT le paquet français (@valueerror/ltjs-lang-fr) et TOUT le cœur
 * (@valueerror/ltjs-core), sauf ce qui n'appartient qu'à d'autres langues : leurs traductions de
 * l'interface (MessagesBundle_xx), leurs listes de mots courants (resource/xx/, lues seulement
 * pour détecter la langue, jamais avec `language: "fr"`) et leurs profils. hunspell.wasm n'est
 * pas une ressource (le français utilise Morfologik) : il n'y est pas. Un fichier lu seulement
 * dans un cas rare ne peut donc pas manquer.
 *
 * Usage (Node, sans Bun) :
 *   vpx scripts/desktop/pack-lt.ts [sortie] [--tailles]
 *     sortie    : chemin de l'archive (défaut : dist/bureau/lt/fr.pack)
 *     --tailles : affiche aussi la taille compressée en brotli (quelques dizaines de secondes)
 * Le build du bureau (`vp build --mode bureau`, voir vite.config.ts) l'appelle lui-même.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { ecrireArchive } from "../../src/desktop/archive-lt.ts";

const LANGUE = "fr";

/** Ressource propre à une autre langue que le français (exclue de l'archive). */
export function autreLangue(nom: string): boolean {
  // Traductions des messages : la base, l'anglais (repli de ResourceBundle) et le français restent.
  const bundle = /^org\/languagetool\/MessagesBundle_([A-Za-z_]+)\.properties$/.exec(nom);
  if (bundle) return bundle[1] !== LANGUE && bundle[1] !== "en";
  // Mots courants et profils de détection : org/languagetool/resource/<langue>/…
  const dossier = /^org\/languagetool\/resource\/([a-z]{2,3}(?:-[A-Za-z]+)?)\//.exec(nom);
  if (dossier) return dossier[1] !== LANGUE && dossier[1] !== "org";
  return /^languages\/(?!fr\/)/.test(nom);
}

export interface RessourceLt {
  /** Nom de ressource (chemin de classe Java ; n-ième copie sous `.dup/<n>/`). */
  nom: string;
  chemin: string;
}

function parcourir(dossier: string, base = ""): string[] {
  const sortie: string[] = [];
  for (const e of readdirSync(dossier, { withFileTypes: true })) {
    if (e.isDirectory()) sortie.push(...parcourir(join(dossier, e.name), `${base}${e.name}/`));
    else if (e.isFile()) sortie.push(`${base}${e.name}`);
  }
  return sortie;
}

/** Dossier `resources/` d'un paquet ltjs, résolu comme le ferait Node. */
function dossierRessources(paquet: string): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve(`${paquet}/package.json`)), "resources");
}

/**
 * Toutes les ressources que le moteur français peut lire, dans l'ordre de recherche de ltjs
 * (racine du cœur puis celle du français ; la première copie d'un nom gagne).
 */
export function listerRessourcesLt(): { gardees: RessourceLt[]; exclues: RessourceLt[] } {
  const racines = [
    dossierRessources("@valueerror/ltjs-core"),
    dossierRessources("@valueerror/ltjs-lang-fr"),
  ];
  // Dans une racine, `<nom>` est la copie 0 et `.dup/<n>/<nom>` la copie n.
  const copie = (relatif: string) =>
    relatif.startsWith(".dup/") ? Number(relatif.split("/")[1]) : 0;
  const copies = new Map<string, string[]>();
  for (const racine of racines) {
    const relatifs = parcourir(racine).sort(
      (a, b) => copie(a) - copie(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const relatif of relatifs) {
      const nom = copie(relatif) ? relatif.split("/").slice(2).join("/") : relatif;
      if (!copies.has(nom)) copies.set(nom, []);
      copies.get(nom)!.push(join(racine, relatif));
    }
  }
  const gardees: RessourceLt[] = [];
  const exclues: RessourceLt[] = [];
  for (const [nom, chemins] of copies) {
    chemins.forEach((chemin, n) => {
      const ressource = { nom: n === 0 ? nom : `.dup/${n}/${nom}`, chemin };
      (autreLangue(nom) ? exclues : gardees).push(ressource);
    });
  }
  return { gardees, exclues };
}

export interface ArchiveLt {
  octets: Uint8Array;
  fichiers: number;
  exclus: number;
  /** Taille cumulée des fichiers exclus (autres langues). */
  octetsExclus: number;
}

/** Construit l'archive en mémoire. */
export function construireArchiveLt(): ArchiveLt {
  const { gardees, exclues } = listerRessourcesLt();
  const octets = ecrireArchive(
    gardees.map((r) => ({ nom: r.nom, octets: readFileSync(r.chemin) })),
  );
  const octetsExclus = exclues.reduce((total, r) => total + readFileSync(r.chemin).length, 0);
  return { octets, fichiers: gardees.length, exclus: exclues.length, octetsExclus };
}

const mo = (octets: number) => `${(octets / 1048576).toFixed(2)} Mo`;

function principal(): void {
  const args = process.argv.slice(2);
  const racine = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sortie = resolve(
    args.find((a) => !a.startsWith("--")) ?? join(racine, "dist", "bureau", "lt", "fr.pack"),
  );
  const archive = construireArchiveLt();
  mkdirSync(dirname(sortie), { recursive: true });
  writeFileSync(sortie, archive.octets);
  console.log(
    `[pack-lt] ${archive.fichiers} fichiers → ${sortie} (${mo(archive.octets.length)}) ; ` +
      `${archive.exclus} fichiers d'autres langues exclus (${mo(archive.octetsExclus)})`,
  );
  if (args.includes("--tailles")) {
    const gzip = gzipSync(archive.octets, { level: 9 }).length;
    const brotli = brotliCompressSync(archive.octets, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: archive.octets.length,
      },
    }).length;
    console.log(`[pack-lt] compressée : gzip -9 ${mo(gzip)} ; brotli 11 ${mo(brotli)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  principal();
}

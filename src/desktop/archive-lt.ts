/**
 * Archive des ressources de LanguageTool (`lt/fr.pack`) : lecture et écriture.
 *
 * Le moteur du navigateur lit ses règles et dictionnaires de façon synchrone dans un magasin en
 * mémoire (`preloadResources` de ltjs) : il faut donc tout charger avant la première analyse.
 * Plutôt que 140 requêtes, l'application sert UN fichier, construit par
 * `scripts/desktop/pack-lt.ts`.
 *
 * Format (version 1), sans dépendance :
 *
 * | octets          | contenu                                                        |
 * | --------------- | -------------------------------------------------------------- |
 * | 0 – 7           | signature ASCII `LTPACK01`                                     |
 * | 8 – 11          | longueur L de l'en-tête, entier non signé 32 bits petit-boutiste |
 * | 12 – 12+L       | en-tête JSON UTF-8 (voir `EnTeteArchive`)                       |
 * | 12+L – fin      | contenu des fichiers, bout à bout, dans l'ordre de l'en-tête    |
 *
 * L'en-tête donne pour chaque fichier son nom de ressource (chemin de classe Java, par exemple
 * `org/languagetool/rules/fr/grammar.xml` ; la n-ième copie d'un même nom est rangée sous
 * `.dup/<n>/<nom>`, comme dans les dossiers de ltjs), son début relatif à la zone de données et
 * sa longueur, ainsi que la taille totale des données et leur CRC-32 : une archive tronquée ou
 * abîmée est refusée avec un message lisible au lieu de faire échouer le moteur plus loin.
 *
 * Module pur (ni DOM ni Node) : partagé par le Worker, le script de construction et les tests.
 */

export const SIGNATURE_ARCHIVE = "LTPACK01";
export const VERSION_ARCHIVE = 1;

export interface EnTeteArchive {
  version: number;
  /** Taille de la zone de données (octets). */
  taille: number;
  /** CRC-32 (IEEE) de la zone de données. */
  crc32: number;
  /** [nom de ressource, début dans la zone de données, longueur]. */
  fichiers: [string, number, number][];
}

/** Archive illisible : absente, tronquée, abîmée ou d'un autre format. */
export class ArchiveInvalide extends Error {
  constructor(message: string) {
    super(`Archive des règles du correcteur invalide : ${message}`);
    this.name = "ArchiveInvalide";
  }
}

let tableCrc: Uint32Array | null = null;

/** CRC-32 IEEE 802.3 (celui de zip et de gzip). */
export function crc32(octets: Uint8Array): number {
  if (!tableCrc) {
    tableCrc = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tableCrc[n] = c >>> 0;
    }
  }
  const table = tableCrc;
  let crc = 0xffffffff;
  for (let i = 0; i < octets.length; i++) crc = table[(crc ^ octets[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Assemble une archive à partir de fichiers déjà lus (ordre conservé). */
export function ecrireArchive(fichiers: { nom: string; octets: Uint8Array }[]): Uint8Array {
  const taille = fichiers.reduce((total, f) => total + f.octets.length, 0);
  const donnees = new Uint8Array(taille);
  const index: [string, number, number][] = [];
  let debut = 0;
  for (const { nom, octets } of fichiers) {
    donnees.set(octets, debut);
    index.push([nom, debut, octets.length]);
    debut += octets.length;
  }
  const entete: EnTeteArchive = {
    version: VERSION_ARCHIVE,
    taille,
    crc32: crc32(donnees),
    fichiers: index,
  };
  const json = new TextEncoder().encode(JSON.stringify(entete));
  const archive = new Uint8Array(12 + json.length + taille);
  archive.set(new TextEncoder().encode(SIGNATURE_ARCHIVE), 0);
  new DataView(archive.buffer).setUint32(8, json.length, true);
  archive.set(json, 12);
  archive.set(donnees, 12 + json.length);
  return archive;
}

/**
 * Lit une archive. Les fichiers rendus sont des vues sur `archive` (aucune copie).
 * @throws ArchiveInvalide
 */
export function lireArchive(archive: Uint8Array): Map<string, Uint8Array> {
  if (archive.length < 12)
    throw new ArchiveInvalide(`fichier trop court (${archive.length} octets).`);
  const signature = new TextDecoder().decode(archive.subarray(0, 8));
  if (signature !== SIGNATURE_ARCHIVE) {
    throw new ArchiveInvalide("signature absente (ce n'est pas une archive LTPACK).");
  }
  const longueur = new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(
    8,
    true,
  );
  if (12 + longueur > archive.length) throw new ArchiveInvalide("en-tête tronqué.");

  let entete: EnTeteArchive;
  try {
    entete = JSON.parse(new TextDecoder().decode(archive.subarray(12, 12 + longueur)));
  } catch {
    throw new ArchiveInvalide("en-tête illisible.");
  }
  if (entete?.version !== VERSION_ARCHIVE) {
    throw new ArchiveInvalide(`version ${String(entete?.version)} non prise en charge.`);
  }
  if (!Array.isArray(entete.fichiers) || entete.fichiers.length === 0) {
    throw new ArchiveInvalide("aucun fichier.");
  }

  const donnees = archive.subarray(12 + longueur);
  if (donnees.length !== entete.taille) {
    throw new ArchiveInvalide(
      `${donnees.length} octets de données au lieu de ${entete.taille} (fichier tronqué ?).`,
    );
  }
  if (crc32(donnees) !== entete.crc32) {
    throw new ArchiveInvalide("somme de contrôle incorrecte (fichier abîmé).");
  }

  const fichiers = new Map<string, Uint8Array>();
  for (const entree of entete.fichiers as unknown[]) {
    const [nom, debut, taille] = (Array.isArray(entree) ? entree : []) as unknown[];
    if (
      typeof nom !== "string" ||
      typeof debut !== "number" ||
      typeof taille !== "number" ||
      !Number.isInteger(debut) ||
      !Number.isInteger(taille) ||
      debut < 0 ||
      taille < 0 ||
      debut + taille > donnees.length
    ) {
      throw new ArchiveInvalide(`entrée d'index incorrecte (${JSON.stringify(entree)}).`);
    }
    fichiers.set(nom, donnees.subarray(debut, debut + taille));
  }
  return fichiers;
}

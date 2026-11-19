/**
 * Écrit le manifeste de mise à jour (`latest.json`) de l'application de bureau.
 *
 * L'application installée lit ce fichier sur la dernière release stable de
 * GitHub (…/releases/latest/download/latest.json) : il annonce la version, et
 * pour chaque plateforme l'adresse du paquet et sa signature. Seuls
 * l'installeur Windows NSIS et l'AppImage se mettent à jour seuls ; le MSI et
 * le .deb n'y figurent pas.
 *
 * Usage (Node ≥ 22.18, qui exécute ce module TypeScript tel quel ; Bun convient aussi) :
 *   node scripts/desktop/update-manifest.ts <dossier des paquets> <tag> <propriétaire/dépôt>
 * Lancé par .github/workflows/release.yml, pour les versions stables uniquement.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Une signature de mise à jour : nom du fichier `.sig` et son contenu. */
export interface SignatureFile {
  name: string;
  signature: string;
}

export interface UpdateManifest {
  version: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** Suffixes des paquets qui se mettent à jour seuls → plateforme et type d'installeur. */
const PACKAGES: { pattern: RegExp; os: string; installer: string }[] = [
  { pattern: /_([A-Za-z0-9]+)\.AppImage$/, os: "linux", installer: "appimage" },
  { pattern: /_([A-Za-z0-9]+)-setup\.exe$/, os: "windows", installer: "nsis" },
];

/** Architecture dans le nom du paquet → architecture attendue par l'application. */
const ARCHS: Record<string, string> = {
  amd64: "x86_64",
  x64: "x86_64",
  aarch64: "aarch64",
  arm64: "aarch64",
};

/** Systèmes que chaque release doit couvrir. */
const REQUIRED_OS = ["linux", "windows"];

/**
 * Construit le manifeste à partir des signatures trouvées. Refuse une
 * pré-version (jamais proposée aux utilisateurs) et une release incomplète :
 * l'application rejette un manifeste où sa plateforme manque.
 */
export function buildUpdateManifest(options: {
  tag: string;
  repository: string;
  signatures: SignatureFile[];
  pubDate: Date;
}): UpdateManifest {
  const version = options.tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Le manifeste de mise à jour n'est publié que pour une version stable (reçu : ${options.tag}).`,
    );
  }

  const platforms: UpdateManifest["platforms"] = {};
  const covered = new Set<string>();
  for (const { name, signature } of options.signatures) {
    const file = name.replace(/\.sig$/, "");
    const kind = PACKAGES.find(({ pattern }) => pattern.test(file));
    if (!kind) continue; // .deb.sig, .msi.sig : pas de mise à jour automatique
    const arch = ARCHS[kind.pattern.exec(file)?.[1] ?? ""];
    if (!arch) throw new Error(`Architecture inconnue dans le nom du paquet : ${file}`);
    if (!signature.trim()) throw new Error(`Signature vide : ${name}`);
    const entry = {
      signature: signature.trim(),
      url: `https://github.com/${options.repository}/releases/download/${options.tag}/${encodeURIComponent(file)}`,
    };
    // L'application cherche d'abord « système-architecture-installeur », puis
    // « système-architecture » : les deux clés désignent le même paquet.
    platforms[`${kind.os}-${arch}`] = entry;
    platforms[`${kind.os}-${arch}-${kind.installer}`] = entry;
    covered.add(kind.os);
  }

  const missing = REQUIRED_OS.filter((os) => !covered.has(os));
  if (missing.length > 0) {
    throw new Error(`Signature de mise à jour absente pour : ${missing.join(", ")}.`);
  }

  return { version, pub_date: options.pubDate.toISOString(), platforms };
}

// Lancé directement (pas importé par les tests). `import.meta.main` n'existe pas sous Node 22.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, tag, repository] = process.argv.slice(2);
  if (!dir || !tag || !repository) {
    throw new Error("Usage : update-manifest.ts <dossier des paquets> <tag> <propriétaire/dépôt>");
  }
  const signatures = readdirSync(dir)
    .filter((name) => name.endsWith(".sig"))
    .map((name) => {
      if (!existsSync(join(dir, name.replace(/\.sig$/, "")))) {
        throw new Error(`Paquet absent pour la signature ${name}`);
      }
      return { name, signature: readFileSync(join(dir, name), "utf8") };
    });
  const manifest = buildUpdateManifest({ tag, repository, signatures, pubDate: new Date() });
  const out = join(dir, "latest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[mise à jour] ${out} : version ${manifest.version}`);
  for (const [platform, { url }] of Object.entries(manifest.platforms)) {
    console.log(`  ${platform} → ${url}`);
  }
}

/**
 * Prépare le serveur embarqué de l'application de bureau (sidecar Tauri).
 *
 *  1. compile server.ts (et le worker du correcteur) en un exécutable Bun
 *     autonome, nommé selon la convention Tauri : grammaria-server-<triple> ;
 *  2. copie à côté les fichiers que l'exécutable lit à l'exécution : interface
 *     construite (dist/) et règles de LanguageTool.
 *
 * Usage : bun scripts/desktop/prepare-sidecar.ts [--target <triple Rust>]
 * Lancé par `beforeBuildCommand` de src-tauri/tauri.conf.json, après `vp build`.
 */
import { $, type BunPlugin } from "bun";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const TAURI = join(ROOT, "src-tauri");

/** Triple Rust (nom attendu par Tauri) → cible de `bun build --compile`. */
const TARGETS: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
};

async function hostTriple(): Promise<string> {
  const out = await $`rustc -vV`.text();
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("Impossible de lire la plateforme hôte (rustc -vV).");
  return line.slice("host:".length).trim();
}

const argIndex = process.argv.indexOf("--target");
const triple =
  (argIndex > 0 ? process.argv[argIndex + 1] : undefined) ??
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  (await hostTriple());
const bunTarget = TARGETS[triple];
if (!bunTarget) throw new Error(`Plateforme non prise en charge : ${triple}`);

const exe = triple.includes("windows") ? ".exe" : "";
const binaries = join(TAURI, "binaries");
const resources = join(TAURI, "resources");
mkdirSync(binaries, { recursive: true });
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });

// 1. Exécutable du serveur, sans minification (le portage Java de LanguageTool
// s'appuie sur les noms de classes). asset naming garde le nom « hunspell.wasm »
// à la racine du système de fichiers virtuel, là où le module WebAssembly le cherche.
//
// Le moteur découvre ses langues par `import("@valueerror/ltjs-lang-" + code)`,
// que le bundler ne peut pas suivre : dans l'exécutable, ces imports seraient
// résolus sur le disque, depuis le dossier courant et ses parents, et un
// node_modules trouvé là (dossier personnel d'un développeur…) ferait planter le
// correcteur. Le plugin remplace cette découverte par la seule langue embarquée,
// le français, importée statiquement par grammar.engine.ts.
const embeddedLanguagesOnly: BunPlugin = {
  name: "ltjs-embedded-languages",
  setup(build) {
    build.onLoad({ filter: /ltjs-core[\\/]src[\\/]lang[\\/]discover\.js$/ }, () => ({
      loader: "js",
      contents: [
        "export const KNOWN_LANGUAGE_CODES = ['fr'];",
        "export async function discoverLanguagePackages() { return ['fr']; }",
      ].join("\n"),
    }));
  },
};

const outfile = join(binaries, `grammaria-server-${triple}${exe}`);
console.log(`[sidecar] compilation ${bunTarget} → ${outfile}`);
const result = await Bun.build({
  entrypoints: [join(ROOT, "server.ts"), join(ROOT, "grammar.worker.ts")],
  compile: { target: bunTarget as Bun.Build.CompileTarget, outfile },
  naming: { asset: "[name].[ext]" },
  plugins: [embeddedLanguagesOnly],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("La compilation du serveur a échoué.");
}

// 2. Interface construite.
const dist = join(ROOT, "dist");
if (!existsSync(join(dist, "index.html"))) {
  throw new Error("dist/ est absent : lancez d'abord `vp build`.");
}
cpSync(dist, join(resources, "dist"), { recursive: true });

// 3. Règles de LanguageTool : les trois dossiers que grammar.worker.ts ajoute
// au moteur via GRAMMARIA_LT_RESOURCES.
const modules = join(ROOT, "node_modules", "@valueerror");
const lt = join(resources, "lt");
cpSync(join(modules, "ltjs-core", "resources"), join(lt, "core"), { recursive: true });
cpSync(join(modules, "ltjs-lang-fr", "resources"), join(lt, "fr"), { recursive: true });
const unicodeSrc = join(modules, "ltjs-core", "src", "lib", "java", "unicode");
mkdirSync(join(lt, "unicode"), { recursive: true });
for (const file of readdirSync(unicodeSrc).filter((f) => f.endsWith(".json"))) {
  cpSync(join(unicodeSrc, file), join(lt, "unicode", file));
}

console.log("[sidecar] prêt : binaries/ et resources/ (dist, lt)");

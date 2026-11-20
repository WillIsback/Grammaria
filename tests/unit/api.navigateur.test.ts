// @vitest-environment node
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { build, type Plugin, type Rolldown } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

/**
 * Le gestionnaire d'API (`api/handler.ts`) tourne aussi dans la WebView du
 * bureau : lui et tout ce qu'il importe doivent se construire pour le
 * navigateur, sans Bun ni Node. Deux preuves :
 *  1. une construction réelle (Vite, cible navigateur) qui échoue si un module
 *     intégré de Bun ou de Node est résolu, et dont le résultat n'en cite aucun ;
 *  2. un parcours du graphe des imports locaux, qui interdit aussi
 *     `process`, `Bun` et les fichiers propres au serveur (config.ts lit
 *     process.env, journal*.ts ouvre SQLite…).
 */

const root = join(import.meta.dirname, "../..");
const ENTREES = ["api/handler.ts", "api/deps.ts", "api/reglages.ts"];
const INTEGRES = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const estIntegre = (id: string) =>
  id.startsWith("bun:") || id.startsWith("node:") || INTEGRES.has(id);

describe("api/ — construction pour le navigateur", () => {
  it("se construit sans aucun module de Bun ni de Node", async () => {
    const resolus: string[] = [];
    const interdits: string[] = [];
    const garde: Plugin = {
      name: "grammaria-sans-bun-ni-node",
      enforce: "pre",
      resolveId(source, importer) {
        if (estIntegre(source)) {
          interdits.push(`${source} (importé par ${importer ? relative(root, importer) : "?"})`);
        }
        return null;
      },
      load(id) {
        resolus.push(id);
        return null;
      },
    };

    const sortie = (await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [garde],
      build: {
        write: false,
        minify: false,
        target: "es2022",
        lib: { entry: join(root, "api/handler.ts"), formats: ["es"], fileName: "api" },
      },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];

    expect(interdits).toEqual([]);
    const code = (Array.isArray(sortie) ? sortie : [sortie])
      .flatMap((o) => o.output)
      .map((chunk) => ("code" in chunk ? chunk.code : ""))
      .join("\n");
    expect(code).toContain("creerGestionnaire");
    expect(code).not.toMatch(/from\s*["'](bun|node):/);
    expect(code).not.toMatch(/import\(\s*["'](bun|node):/);
    expect(code).not.toMatch(/__vite-browser-external/);
    expect(code).not.toMatch(/\bBun\./);
    expect(code).not.toMatch(/process\.env/);

    const locaux = resolus
      .filter((id) => !id.includes("node_modules"))
      .map((id) => relative(root, id));
    expect(locaux).toContain("api/handler.ts");
    for (const fichier of locaux) {
      expect(fichier, `${fichier} ne doit pas être embarqué dans le bureau`).not.toMatch(
        /^(server|config|settings|telemetry|journal.*|grammar.*)\.ts$/,
      );
    }
  }, 60_000);
});

/** Source sans ses commentaires (qui peuvent citer Bun.serve, process.env…). */
function sansCommentaires(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Imports d'exécution (pas `import type`) d'un fichier source. */
function importsExecution(source: string): string[] {
  const sansTypes = source.replace(
    /^\s*(import|export)\s+type\s[\s\S]*?from\s+["'][^"']+["'];?/gm,
    "",
  );
  return [
    ...sansTypes.matchAll(/^\s*(?:import|export)\s[\s\S]*?\sfrom\s+["']([^"']+)["']/gm),
    ...sansTypes.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ...sansTypes.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
}

function resoudre(depuis: string, specifiant: string): string {
  const base = resolve(dirname(depuis), specifiant);
  for (const candidat of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      readFileSync(candidat);
      return candidat;
    } catch {
      /* candidat suivant */
    }
  }
  throw new Error(`Import introuvable : ${specifiant} depuis ${relative(root, depuis)}`);
}

describe("api/ — graphe des imports", () => {
  it("n'atteint ni Bun, ni Node, ni process, ni les fichiers du serveur", () => {
    const vus = new Set<string>();
    const paquets = new Set<string>();
    const pile = ENTREES.map((e) => join(root, e));
    while (pile.length > 0) {
      const fichier = pile.pop() as string;
      if (vus.has(fichier)) continue;
      vus.add(fichier);
      const source = sansCommentaires(readFileSync(fichier, "utf-8"));
      const nom = relative(root, fichier);
      expect(source, `${nom} lit process`).not.toMatch(/\bprocess\.(env|argv|cwd|exit)/);
      expect(source, `${nom} utilise Bun`).not.toMatch(/\bBun\./);
      for (const specifiant of importsExecution(source)) {
        expect(estIntegre(specifiant), `${nom} importe ${specifiant}`).toBe(false);
        if (specifiant.startsWith(".")) pile.push(resoudre(fichier, specifiant));
        else paquets.add(specifiant);
      }
    }
    const locaux = [...vus].map((f) => relative(root, f));
    for (const fichier of locaux) {
      expect(fichier).not.toMatch(/^(server|config|settings|telemetry|journal.*|grammar.*)\.ts$/);
    }
    // Paquets embarqués : compatibles navigateur.
    expect([...paquets].sort()).toEqual(["@opentelemetry/api", "diff-match-patch"]);
  });
});

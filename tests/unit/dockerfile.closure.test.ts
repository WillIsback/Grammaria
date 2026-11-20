import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { copies, etapesDockerfile } from "./helpers/docker";

// Complète dockerfile.test.ts (qui lit les imports directs de server.ts et
// journal.ts) : depuis la v0.3.0, server.ts importe api/handler.ts, qui
// importe à son tour ../src/… . Tout fichier atteint à l'exécution depuis
// server.ts, de proche en proche, doit être copié dans l'image.

const root = join(import.meta.dirname, "../..");

// Seulement les COPY de l'étape finale (celle qui tourne) : une copie dans une
// étape de construction ne met rien dans l'image.
const copied = copies(etapesDockerfile().at(-1)!)
  .filter((copie) => copie.depuis === null)
  .flatMap((copie) => copie.sources);

const isCopied = (file: string) =>
  copied.some((entry) => entry === file || file.startsWith(`${entry.replace(/\/$/, "")}/`));

/** Imports relatifs d'exécution (les `import type` sont effacés par Bun). */
function runtimeImports(source: string): string[] {
  const withoutTypes = source.replace(
    /^\s*(import|export)\s+type\s[\s\S]*?from\s+["'][^"']+["'];?/gm,
    "",
  );
  return [
    ...withoutTypes.matchAll(/^\s*(?:import|export)\s[\s\S]*?\sfrom\s+["'](\.[^"']+)["']/gm),
    ...withoutTypes.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm),
  ].map((m) => m[1]);
}

function resolveImport(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
    (candidate) => existsSync(candidate) && !candidate.endsWith("/"),
  );
  if (!found) throw new Error(`${specifier} introuvable depuis ${relative(root, from)}`);
  return found;
}

function serverClosure(): string[] {
  const seen = new Set<string>();
  const stack = [join(root, "server.ts")];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(readFileSync(file, "utf-8"))) {
      stack.push(resolveImport(file, specifier));
    }
  }
  return [...seen].map((file) => relative(root, file)).sort();
}

describe("Dockerfile runtime stage — imports transitifs du serveur", () => {
  const closure = serverClosure();

  it("suit le gestionnaire d'API et ses imports", () => {
    expect(closure).toContain("api/handler.ts");
    expect(closure).toContain("api/reglages.ts");
    expect(closure).toContain("src/utils/modeles.ts");
  });

  it.each(closure)("copie %s", (file) => {
    expect(isCopied(file), `${file} is missing from the runtime image`).toBe(true);
  });
});

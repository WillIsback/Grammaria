import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

/**
 * Le journal et la logique pure doivent tourner dans la WebView du bureau :
 * aucun module Bun ni Node, seul `journal.driver.bun.ts` touche à SQLite.
 */
const racine = join(import.meta.dir, "..");
const analyse = [...new Glob("src/analysis/**/*.ts").scanSync(racine)].sort();
const entrees = [
  "journal.ts",
  "journal.rules.ts",
  "journal.badges.ts",
  "journal.driver.ts",
  ...analyse,
];

describe("Journal — compilation pour le navigateur", () => {
  it("couvre toute la logique pure", () => {
    expect(analyse.length).toBeGreaterThan(5);
  });

  it("se compile pour le navigateur sans aucun import bun: ni node:", async () => {
    const importsInterdits: string[] = [];
    const resultat = await Bun.build({
      entrypoints: entrees.map((f) => join(racine, f)),
      target: "browser",
      plugins: [
        {
          name: "imports-interdits",
          setup(build) {
            build.onResolve({ filter: /^(bun|node)(:|$)/ }, (args) => {
              importsInterdits.push(`${args.importer} → ${args.path}`);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    expect(resultat.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(resultat.success).toBe(true);
    expect(importsInterdits).toEqual([]);
    for (const sortie of resultat.outputs) {
      const code = await sortie.text();
      expect(code).not.toMatch(/["'](bun|node):/);
      expect(code).not.toContain("bun:sqlite");
    }
  });

  it("seul le pilote Bun importe bun:sqlite", async () => {
    const fautifs: string[] = [];
    for (const f of [...entrees, ...new Glob("journal*.ts").scanSync(racine)]) {
      const source = await Bun.file(join(racine, f)).text();
      const imports = [...source.matchAll(/from\s+["']((?:bun|node):[^"']+)["']/g)].map(
        (m) => m[1],
      );
      if (imports.length && f !== "journal.driver.bun.ts")
        fautifs.push(`${f} : ${imports.join(", ")}`);
    }
    expect(fautifs).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";

/**
 * Le gestionnaire d'API tourne aussi dans la WebView du bureau : `bun build
 * --target=browser` doit le construire sans résoudre aucun module de Bun ni
 * de Node (un greffon fait échouer la construction sinon), et le résultat
 * n'en importe aucun. Pendant vitest : tests/unit/api.navigateur.test.ts.
 */

const root = join(import.meta.dir, "..");

describe("api/handler.ts — bun build --target=browser", () => {
  it("se construit sans Bun ni Node", async () => {
    const interdits: string[] = [];
    const resultat = await Bun.build({
      entrypoints: [join(root, "api/handler.ts")],
      target: "browser",
      format: "esm",
      plugins: [
        {
          name: "sans-bun-ni-node",
          setup(build) {
            build.onResolve({ filter: /^(bun|node):/ }, (args) => {
              interdits.push(`${args.path} (importé par ${relative(root, args.importer)})`);
              return undefined;
            });
            build.onResolve(
              {
                filter:
                  /^(fs|path|os|child_process|crypto|stream|util|events|http|https|net|url|buffer|module|worker_threads)$/,
              },
              (args) => {
                interdits.push(`${args.path} (importé par ${relative(root, args.importer)})`);
                return undefined;
              },
            );
          },
        },
      ],
    });

    expect(resultat.success).toBe(true);
    expect(interdits).toEqual([]);
    const code = (await Promise.all(resultat.outputs.map((o) => o.text()))).join("\n");
    expect(code).toContain("creerGestionnaire");
    expect(code).not.toMatch(/from\s*["'](bun|node):/);
    expect(code).not.toMatch(/require\(\s*["'](bun|node):/);
    expect(code).not.toMatch(/process\.env/);
  });
});

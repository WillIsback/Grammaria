// @vitest-environment node
/**
 * Builds réels (Vite+) : celui du bureau produit un Worker sans évaluation de code et l'archive
 * des règles ; le build web habituel n'embarque ni l'un ni l'autre.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import { constructionsInterdites } from "../../scripts/desktop/csp-bureau.ts";
import { lireArchive } from "../../src/desktop/archive-lt.ts";

const RACINE = resolve(import.meta.dirname, "../..");
const BUILD_MS = 120_000;

const fichiers = (dossier: string): string[] =>
  readdirSync(dossier, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? fichiers(join(dossier, e.name)) : [join(dossier, e.name)],
  );

let temporaire: string;
beforeAll(() => {
  temporaire = mkdtempSync(join(tmpdir(), "grammaria-build-"));
});
afterAll(() => rmSync(temporaire, { recursive: true, force: true }));

describe("build du bureau (vp build --mode bureau)", () => {
  let dossier: string;
  beforeAll(async () => {
    dossier = join(temporaire, "lt");
    await build({
      root: RACINE,
      configFile: join(RACINE, "vite.config.ts"),
      mode: "bureau",
      logLevel: "silent",
      build: { outDir: dossier },
    });
  }, BUILD_MS);

  it("produit seulement le Worker et l'archive", () => {
    expect(readdirSync(dossier).sort()).toEqual(["fr.pack", "worker.js"]);
  });

  it("le Worker n'évalue ni ne compile de code (CSP sans unsafe-eval)", () => {
    const source = readFileSync(join(dossier, "worker.js"), "utf8");
    expect(constructionsInterdites(source)).toEqual([]);
    // Hunspell (WebAssembly) n'est pas embarqué.
    expect(source).not.toMatch(/hunspell\.wasm/);
  });

  it("le Worker est minifié", () => {
    expect(statSync(join(dossier, "worker.js")).size).toBeLessThan(1.5 * 1048576);
  });

  it("l'archive est lisible et contient les règles françaises", () => {
    const archive = lireArchive(readFileSync(join(dossier, "fr.pack")));
    expect(archive.has("org/languagetool/rules/fr/grammar.xml")).toBe(true);
    expect(archive.has("org/languagetool/resource/fr/french.dict")).toBe(true);
  });
});

describe("build web habituel (vp build)", () => {
  let dossier: string;
  beforeAll(async () => {
    dossier = join(temporaire, "web");
    await build({
      root: RACINE,
      configFile: join(RACINE, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: dossier },
    });
  }, BUILD_MS);

  it("n'embarque ni le Worker du correcteur ni l'archive des règles", () => {
    const produits = fichiers(dossier);
    expect(produits).toContain(join(dossier, "index.html"));
    expect(
      produits.map((f) => relative(dossier, f)).filter((f) => /\.pack$|^lt\//.test(f)),
    ).toEqual([]);
    for (const f of produits.filter((p) => /\.(js|html)$/.test(p))) {
      const contenu = readFileSync(f, "utf8");
      expect(contenu).not.toContain("LTPACK01");
      expect(contenu).not.toContain("org.languagetool");
    }
  });
});

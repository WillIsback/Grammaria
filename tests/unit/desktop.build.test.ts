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

  it("n'embarque ni l'amorce ni le pont du bureau (un seul paquet JavaScript)", () => {
    const scripts = fichiers(dossier).filter((f) => f.endsWith(".js"));
    expect(scripts).toHaveLength(1);
    const contenu = readFileSync(scripts[0], "utf8");
    for (const commande of ["db_read_many", "llm_chat", "settings_get"]) {
      expect(contenu).not.toContain(commande);
    }
  });
});

describe("build de l'interface du bureau (vp build --mode bureau-interface)", () => {
  let dossier: string;
  beforeAll(async () => {
    dossier = join(temporaire, "bureau-interface");
    await build({
      root: RACINE,
      configFile: join(RACINE, "vite.config.ts"),
      mode: "bureau-interface",
      logLevel: "silent",
      build: { outDir: dossier },
    });
  }, BUILD_MS);

  it("charge l'amorce (pont, journal, commandes Rust) dans un paquet à part", () => {
    const scripts = fichiers(dossier).filter((f) => f.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(1);
    const tout = scripts.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const commande of ["db_read_many", "llm_chat", "llm_cancel", "settings_get"]) {
      expect(tout).toContain(commande);
    }
    // Ni Worker ni archive : ils viennent du build `--mode bureau`.
    expect(tout).not.toContain("LTPACK01");
  });

  it("aucune construction qui évalue du code (CSP sans unsafe-eval)", () => {
    // L'import dynamique, interdit dans le Worker (un seul fichier), charge ici l'amorce et
    // les chunks de l'interface, servis par l'application (script-src 'self').
    // Seule exception : le témoin volontaire de la page d'autotest (chunk à part, jamais chargé
    // hors du mode autotest), qui vérifie que la CSP bloque bien l'évaluation de code.
    for (const f of fichiers(dossier).filter((p) => p.endsWith(".js"))) {
      const interdites = constructionsInterdites(readFileSync(f, "utf8")).filter(
        (c) => c.nom !== "import dynamique",
      );
      if (/[\\/]autotest-[\w-]+\.js$/.test(f)) {
        expect(interdites.map((c) => c.nom)).toEqual(["Function(…)"]);
        expect(interdites[0].extrait).toContain("Function(`return 1`)");
      } else {
        expect(interdites).toEqual([]);
      }
    }
  });
});

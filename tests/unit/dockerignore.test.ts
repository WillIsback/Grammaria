import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { horsContexte, RACINE } from "./helpers/docker";

/**
 * L'image Docker lance `npm run build` (tsc puis vp build) dans un contexte
 * privé des dossiers listés par `.dockerignore`. Un fichier compilé qui
 * importe un fichier ignoré fait donc échouer la construction de l'image,
 * et seulement elle : la release v0.3.0 a échoué ainsi à sa dernière étape.
 */
// Sémantique de Docker (négations, dossiers parents) : voir helpers/docker.ts.
const ignore = horsContexte;

function fichiers(dossier: string): string[] {
  const absolu = join(RACINE, dossier);
  return readdirSync(absolu).flatMap((nom) => {
    const relatif = dossier ? `${dossier}/${nom}` : nom;
    if (nom === "node_modules" || nom === "dist" || nom.startsWith(".")) return [];
    if (statSync(join(absolu, nom)).isDirectory()) return fichiers(relatif);
    return /\.(ts|tsx)$/.test(nom) ? [relatif] : [];
  });
}

describe(".dockerignore", () => {
  it("garde dans l'image tout fichier importé par le code que tsc compile", () => {
    // Ce que tsconfig.json fait compiler et qui reste dans le contexte Docker.
    const compiles = [
      ...["api", "src", "tests-bun", "scripts"].flatMap(fichiers),
      ...readdirSync(RACINE).filter((n) => n.endsWith(".ts")),
    ].filter((f) => !ignore(f));
    expect(compiles.length).toBeGreaterThan(50);

    const manquants: string[] = [];
    for (const fichier of compiles) {
      const source = readFileSync(join(RACINE, fichier), "utf-8");
      for (const [, cible] of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
        const resolu = join(fichier, "..", cible).replace(/\\/g, "/");
        if (ignore(resolu)) manquants.push(`${fichier} → ${resolu}`);
      }
    }
    expect(manquants).toEqual([]);
  });

  it("écarte toujours les tests de l'image, sauf leurs données de référence", () => {
    expect(ignore("tests/unit/dockerignore.test.ts")).toBe(true);
    expect(ignore("tests/fixtures/correcteur/reference.json")).toBe(false);
  });

  it("réinclut un fichier d'un dossier exclu, et seulement lui (négation de Docker)", () => {
    expect(ignore("src-tauri/Cargo.toml")).toBe(false);
    expect(ignore("src-tauri/Cargo.lock")).toBe(true);
    expect(ignore("src-tauri/tauri.conf.json")).toBe(true);
  });
});

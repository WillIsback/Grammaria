import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Révision du moteur grammatical (grammaria-rc) : une seule source de vérité, la dépendance
 * `grammaria_rc` de src-tauri/Cargo.toml (le bureau lie le moteur à cette révision).
 * scripts/moteur/construire.sh — utilisé par la CI, le build du bureau et l'image Docker —
 * la lit là. Aucune autre révision complète ne doit traîner dans le dépôt : un serveur ou
 * une image construits sur un autre moteur que le bureau donneraient d'autres corrections.
 */
const RACINE = join(import.meta.dirname, "../..");
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), "utf-8");

const cargo = lire("src-tauri/Cargo.toml");
const REVISION = /^grammaria_rc = .*rev = "([0-9a-f]{40})"/m.exec(cargo)?.[1];

describe("révision épinglée de grammaria-rc", () => {
  it("figure dans src-tauri/Cargo.toml, en entier (40 caractères), sans branche ni tag", () => {
    expect(REVISION).toMatch(/^[0-9a-f]{40}$/);
    const ligne = cargo.split("\n").find((l) => l.startsWith("grammaria_rc ="))!;
    expect(ligne).toContain('git = "https://github.com/WillIsback/grammaria-rc"');
    expect(ligne).not.toMatch(/\b(branch|tag) =/);
  });

  it("Cargo.lock résout exactement cette révision", () => {
    const lock = lire("src-tauri/Cargo.lock");
    const vues = [...lock.matchAll(/grammaria-rc\?rev=([0-9a-f]+)(?:#([0-9a-f]+))?/g)].flatMap(
      ([, rev, resolue]) => (resolue ? [rev, resolue] : [rev]),
    );
    expect(vues.length).toBeGreaterThanOrEqual(3);
    expect(new Set(vues)).toEqual(new Set([REVISION]));
  });

  it("construire.sh, le Dockerfile et les workflows la lisent dans Cargo.toml sans la recopier", () => {
    const script = lire("scripts/moteur/construire.sh");
    expect(script).toContain("src-tauri/Cargo.toml");
    expect(lire("Dockerfile")).toContain("COPY src-tauri/Cargo.toml");
    for (const workflow of ["ci.yml", "build-desktop.yml"]) {
      const texte = lire(`.github/workflows/${workflow}`);
      expect(texte, workflow).toContain("npm run build:moteur");
      // La clé du cache du moteur suit la révision (lue dans Cargo.toml) et le script.
      expect(texte, workflow).toMatch(/sed -n .*src-tauri\/Cargo\.toml/);
      expect(texte, workflow).toContain("hashFiles('scripts/moteur/construire.sh')");
    }
  });

  it("aucune autre révision complète du moteur dans les fichiers suivis par git", () => {
    const fichiers = execFileSync("git", ["ls-files"], { cwd: RACINE, encoding: "utf-8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx|mjs|sh|ya?ml|toml|lock|json|md|mdx)$|^Dockerfile$/.test(f))
      // Mesures brutes du rapport : relevés horodatés, pas une configuration.
      .filter((f) => !f.startsWith("benchmark/moteur-rust/mesures/"));
    const autres: string[] = [];
    for (const fichier of fichiers) {
      let texte: string;
      try {
        texte = lire(fichier);
      } catch {
        continue; // supprimé dans l'arbre de travail
      }
      for (const ligne of texte.split("\n")) {
        if (!/grammaria-rc|grammaria_rc/.test(ligne)) continue;
        for (const [sha] of ligne.matchAll(/\b[0-9a-f]{40}\b/g)) {
          if (sha !== REVISION) autres.push(`${fichier} : ${sha}`);
        }
      }
    }
    expect(autres).toEqual([]);
  });
});

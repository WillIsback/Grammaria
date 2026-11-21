import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Le install.sh joint à chaque release reçoit le nom de l'image Docker publiée. Docker refuse
 * les majuscules dans un nom d'image : de la v0.2.0 à la v0.4.0, le script publié contenait
 * « ghcr.io/WillIsback/Grammaria » et ne pouvait pas fonctionner (#26). Ce test rejoue
 * l'étape de release.yml sur le vrai install.sh.
 */
const RACINE = join(import.meta.dirname, "../..");
const workflow = readFileSync(join(RACINE, ".github/workflows/release.yml"), "utf-8");
const etape = /- name: Patch install\.sh with actual image name\n([^]*?)\n\n/.exec(workflow)![1];
const commandes = etape
  .slice(etape.indexOf("run: |") + "run: |".length)
  .split("\n")
  .map((ligne) => ligne.trim())
  .filter(Boolean);

function rejouer(depot: string, etiquette: string): string {
  const dossier = mkdtempSync(join(tmpdir(), "install-sh-"));
  writeFileSync(join(dossier, "install.sh"), readFileSync(join(RACINE, "install.sh")));
  execFileSync("bash", ["-euo", "pipefail", "-c", commandes.join("\n")], {
    cwd: dossier,
    env: { ...process.env, REPO: depot, IMAGE_TAG: etiquette },
  });
  return /^IMAGE="(.*)"$/m.exec(readFileSync(join(dossier, "install.sh"), "utf-8"))![1];
}

describe("install.sh publié par la release", () => {
  it("reçoit le nom de l'image en minuscules", () => {
    expect(rejouer("WillIsback/Grammaria", "latest")).toBe("ghcr.io/willisback/grammaria:latest");
    expect(rejouer("WillIsback/Grammaria", "0.4.1-alpha.1")).toBe(
      "ghcr.io/willisback/grammaria:0.4.1-alpha.1",
    );
  });

  it("le workflow n'insère jamais le nom du dépôt tel quel dans le script", () => {
    expect(etape).not.toContain("ghcr.io/${{ github.repository }}");
    expect(commandes.at(-1)).toMatch(/^grep -Eq /);
  });

  it("le modèle à remplacer est bien dans install.sh", () => {
    expect(readFileSync(join(RACINE, "install.sh"), "utf-8")).toContain(
      'IMAGE="ghcr.io/OWNER/grammaria:latest"',
    );
  });
});

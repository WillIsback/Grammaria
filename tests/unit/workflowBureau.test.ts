import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = join(import.meta.dirname, "../..");
const lire = (chemin: string) => readFileSync(join(root, chemin), "utf-8");

/** Corps d'une étape (du `- name:` donné jusqu'à l'étape suivante). */
function etape(workflow: string, nom: string): string {
  const debut = workflow.indexOf(`- name: ${nom}`);
  expect(debut, `étape « ${nom} » absente`).toBeGreaterThanOrEqual(0);
  const suite = workflow.indexOf("\n      - name: ", debut + 1);
  return workflow.slice(debut, suite < 0 ? undefined : suite);
}

// Issue #18 : CI de l'application de bureau sans serveur Bun ni sidecar.
describe("workflow build-desktop (bureau sans Bun)", () => {
  const build = lire(".github/workflows/build-desktop.yml");
  const conf = JSON.parse(lire("src-tauri/tauri.conf.json"));
  const autotestRs = lire("src-tauri/src/autotest.rs");

  it("ne prépare, ne signe ni ne teste plus de sidecar, et n'installe plus Bun", () => {
    expect(conf.bundle.externalBin).toBeUndefined();
    expect(conf.build.beforeBuildCommand).toBe("npm run build:bureau");
    expect(build).not.toMatch(/grammaria-server|setup-bun|\bbun /);
  });

  it("lance l'autotest sur le binaire produit, sous Linux et sous Windows", () => {
    const variable = /VARIABLE_SORTIE: &str = "([A-Z_]+)"/.exec(autotestRs)?.[1];
    expect(variable).toBe("GRAMMARIA_AUTOTEST_OUT");
    const port = /ADRESSE_MODELE: &str = "http:\/\/127\.0\.0\.1:(\d+)"/.exec(autotestRs)?.[1];
    const delai = Number(
      /DELAI_DEFAUT: Duration = Duration::from_secs\((\d+)\)/.exec(autotestRs)?.[1],
    );

    const linux = etape(build, "Autotest — application réelle (Linux");
    expect(linux).toContain("node scripts/desktop/faux-modele.mjs");
    expect(linux).toContain(`127.0.0.1:${port}`);
    expect(linux).toContain(`${variable}="$dir/autotest.json"`);
    expect(linux).toContain("xvfb-run -a dbus-run-session -- src-tauri/target/release/grammaria");
    const filetLinux = Number(/timeout --kill-after=\d+ (\d+)/.exec(linux)?.[1]);
    expect(filetLinux).toBeGreaterThan(delai);

    const windows = etape(build, "Autotest — application réelle (Windows");
    expect(windows).toContain("shell: pwsh");
    expect(windows).toContain(`127.0.0.1:${port}`);
    expect(windows).toContain(`$env:${variable} =`);
    expect(windows).toContain('"src-tauri\\target\\release\\grammaria.exe"');
    expect(windows).toContain("$app.ExitCode");
    expect(Number(/WaitForExit\((\d+)\)/.exec(windows)?.[1]) / 1000).toBeGreaterThan(delai);

    for (const e of [linux, windows]) {
      expect(e).toMatch(/timeout-minutes: \d+/);
      expect(e).toContain("steps.build.outcome == 'success'");
    }
  });

  it("juge l'autotest avec le vérificateur, publie les résultats et un résumé", () => {
    const verification = etape(build, "Autotest — vérification et résumé");
    expect(verification).toContain("node scripts/desktop/verifier-autotest.mjs");
    expect(verification).toContain("GITHUB_STEP_SUMMARY");
    expect(verification).toContain("exit 1");
    const publication = etape(build, "Autotest — publier les résultats");
    expect(publication).toContain("actions/upload-artifact");
    expect(publication).toContain("${{ runner.temp }}/autotest/");
    // Les résultats de l'autotest ne doivent pas être pris pour des paquets par release.yml.
    expect(publication).not.toContain("grammaria-desktop-");
  });

  it("garde la taille du .deb et de l'installeur NSIS (20 Mio avec les données du moteur)", () => {
    const garde = etape(build, "Garde de taille des paquets");
    expect(garde).toContain("seuil_deb=$((20 * mio))");
    expect(garde).toContain("seuil_nsis=$((20 * mio))");
    expect(garde).toContain("*.AppImage");
    expect(garde).toContain("*.msi");
    expect(garde).toContain("GITHUB_STEP_SUMMARY");
  });
});

describe("workflows ci et release", () => {
  const ci = lire(".github/workflows/ci.yml");
  const conf = JSON.parse(lire("src-tauri/tauri.conf.json"));
  const release = lire(".github/workflows/release.yml");
  const scripts = JSON.parse(lire("package.json")).scripts;

  it("le correcteur du bureau n'est plus un Worker : plus de contrôle dans Chromium", () => {
    expect(scripts["test:correcteur-bureau"]).toBeUndefined();
    expect(scripts["build:moteur"]).toBe("bash scripts/moteur/construire.sh");
    expect(ci).not.toContain("chromium");
    // Données du moteur Rust : ressources de l'application.
    expect(new Set(Object.values(conf.bundle.resources))).toEqual(
      new Set(["moteur/fr.disambig.xml", "moteur/fr.lex", "moteur/fr.rules", "moteur/fr.words"]),
    );
  });

  it("écrit le manifeste de mise à jour avec Node, sans Bun, après contrôle des sommes", () => {
    expect(release).toContain("node scripts/desktop/update-manifest.ts");
    expect(release).not.toMatch(/setup-bun|\bbun /);
    expect(release).toContain("sha256sum --check --strict SHA256SUMS-linux SHA256SUMS-windows");
  });
});

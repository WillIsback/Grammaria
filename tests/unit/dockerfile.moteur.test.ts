import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { cheminDonnees, cheminMoteur } from "../../grammar";
import { copies, etapesDockerfile, horsContexte, RACINE } from "./helpers/docker";

/**
 * Image Docker et moteur grammatical (v0.4.0). La release v0.3.0 a échoué à sa dernière
 * étape parce que l'image n'avait jamais été construite avant. Ces tests vérifient sans
 * démon Docker ce qui casserait `docker build` dans release.yml (build sans option :
 * `context: .`, aucun contexte nommé, aucun argument de build) :
 *  - chaque COPY lit un fichier présent dans le contexte, ou une étape définie plus haut ;
 *  - l'étape du moteur a tout ce que scripts/moteur/construire.sh lit ;
 *  - le binaire est construit sous Alpine (musl), comme l'image finale qui l'exécute ;
 *  - il est copié là où grammar.ts le cherche.
 */
const etapes = etapesDockerfile();
const finale = etapes.at(-1)!;
const moteur = etapes.find((e) => e.nom === "moteur");

describe("Dockerfile — étapes et contexte", () => {
  it("toute copie --from= vise une étape définie avant elle (pas de contexte nommé)", () => {
    // `COPY --from=grammaria-rc` (contexte nommé) aurait exigé
    // `--build-context grammaria-rc=…`, que release.yml ne passe pas.
    etapes.forEach((etape, i) => {
      const connues = etapes.slice(0, i).map((e) => e.nom);
      for (const copie of copies(etape)) {
        if (copie.depuis !== null) expect(connues).toContain(copie.depuis);
      }
    });
  });

  it("chaque source d'un COPY sans --from existe et reste dans le contexte", () => {
    const manquants: string[] = [];
    for (const etape of etapes) {
      for (const copie of copies(etape)) {
        if (copie.depuis !== null) continue;
        for (const source of copie.sources) {
          if (source === ".") continue;
          // `package*.json` : au moins un fichier correspondant.
          const chemins = source.includes("*")
            ? ["package.json", "package-lock.json"].filter((f) =>
                new RegExp(`^${source.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`).test(f),
              )
            : [source.replace(/\/$/, "")];
          if (chemins.length === 0) manquants.push(`${source} (aucun fichier)`);
          for (const chemin of chemins) {
            if (!existsSync(join(RACINE, chemin))) manquants.push(`${chemin} (absent)`);
            else if (horsContexte(chemin)) manquants.push(`${chemin} (exclu par .dockerignore)`);
          }
        }
      }
    }
    expect(manquants).toEqual([]);
  });

  it("aucun ARG obligatoire ni --build-context : l'image se construit sans option", () => {
    const release = readFileSync(join(RACINE, ".github/workflows/release.yml"), "utf-8");
    expect(release).not.toMatch(/build-contexts?:/);
    // Un ARG doit avoir une valeur par défaut : `docker build .` seul doit suffire.
    const args = etapes.flatMap((e) => e.instructions.filter((i) => i.commande === "ARG"));
    for (const arg of args) expect(arg.arguments).toMatch(/^[A-Z_]+=\S+$/);
    // Le seul prévu : la version publiée, que la release fournit.
    expect(args.map((a) => a.arguments)).toEqual(["VERSION=0.0.0"]);
    expect(release).toContain("VERSION=${{ env.TAG }}");
  });
});

describe("Dockerfile — moteur grammatical", () => {
  it("une étape « moteur » construit le moteur avec scripts/moteur/construire.sh", () => {
    expect(moteur).toBeDefined();
    const runs = moteur!.instructions.filter((i) => i.commande === "RUN").map((i) => i.arguments);
    expect(runs.some((r) => r.includes("scripts/moteur/construire.sh"))).toBe(true);
    // Le script lit la révision épinglée dans src-tauri/Cargo.toml : il doit être copié.
    const sources = copies(moteur!).flatMap((c) => c.sources);
    expect(sources).toContain("scripts/moteur/construire.sh");
    expect(sources).toContain("src-tauri/Cargo.toml");
    // bash (le script), git (récupération de la révision) : absents de l'image Rust Alpine.
    expect(runs.some((r) => /apk add .*\bbash\b/.test(r) && /\bgit\b/.test(r))).toBe(true);
  });

  it("src-tauri/Cargo.toml est dans le contexte, le reste de src-tauri/ non", () => {
    expect(horsContexte("src-tauri/Cargo.toml")).toBe(false);
    expect(horsContexte("src-tauri/src/lib.rs")).toBe(true);
    expect(horsContexte("src-tauri/target/release/grammaria")).toBe(true);
  });

  it("le moteur construit en local (glibc) n'entre pas dans le contexte", () => {
    expect(horsContexte("moteur/grammaria")).toBe(true);
    expect(horsContexte("moteur/data/lt/grammar.xml")).toBe(true);
    expect(horsContexte(".moteur-build/target/release/grammaria")).toBe(true);
  });

  it("binaire musl : étape du moteur et image finale toutes deux Alpine", () => {
    // Un binaire glibc ne démarre pas sous Alpine (pas de ld-linux) : vérifié à la main
    // pour la v0.4.0 (`file` : static-pie linked).
    expect(moteur!.image).toMatch(/alpine/);
    expect(finale.image).toMatch(/alpine/);
  });

  it("copié là où grammar.ts le cherche : moteur/grammaria et moteur/data à côté de grammar.ts", () => {
    const workdir = finale.instructions.find((i) => i.commande === "WORKDIR")?.arguments;
    expect(workdir).toBe("/app");
    const copieMoteur = copies(finale).find((c) => c.depuis === "moteur");
    expect(copieMoteur).toEqual({
      depuis: "moteur",
      sources: ["/app/moteur"],
      destination: "./moteur",
    });
    // Sans variable d'environnement (cas de l'image), sous Linux.
    vi.stubEnv("GRAMMARIA_MOTEUR", "");
    vi.stubEnv("GRAMMARIA_MOTEUR_DONNEES", "");
    expect(cheminMoteur()).toBe(join(RACINE, "moteur", "grammaria"));
    expect(cheminDonnees()).toBe(join(RACINE, "moteur", "data"));
    vi.unstubAllEnvs();
    // grammar.ts est copié à la racine de /app.
    expect(
      copies(finale).some((c) => c.sources.includes("grammar.ts") && c.destination === "./"),
    ).toBe(true);
    // construire.sh produit moteur/ sous son dossier de travail (/app dans l'étape moteur).
    const script = readFileSync(join(RACINE, "scripts/moteur/construire.sh"), "utf-8");
    expect(script).toContain('SORTIE="${GRAMMARIA_MOTEUR_SORTIE:-$RACINE/moteur}"');
    expect(moteur!.instructions.find((i) => i.commande === "WORKDIR")?.arguments).toBe("/app");
    expect(statSync(join(RACINE, "scripts/moteur/construire.sh")).mode & 0o111).not.toBe(0);
  });
});

describe("Dockerfile — contrôle de santé", () => {
  it("utilise `bun -e` : `bun run -e` affiche l'aide et sort en succès (conteneur toujours sain)", () => {
    const sante = finale.instructions.find((i) => i.commande === "HEALTHCHECK")?.arguments ?? "";
    expect(sante).toMatch(/CMD bun -e /);
    expect(sante).not.toMatch(/bun run -e/);
  });
});

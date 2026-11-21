import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { avecEnTetesSecurite, cheminStatique, CSP_WEB } from "../../statique";

// Fichiers de l'interface servis par server.ts : jamais rien hors du dossier.
const DIST = resolve("/srv/grammaria/dist");

/** Chemin tel que server.ts le reçoit (`new URL(req.url).pathname`). */
const pathname = (cible: string) => new URL(cible, "http://localhost").pathname;

describe("cheminStatique", () => {
  it("sert les fichiers du dossier, index.html pour la racine", () => {
    expect(cheminStatique(DIST, "/")).toBe(join(DIST, "index.html"));
    expect(cheminStatique(DIST, "/assets/index-abc.js")).toBe(join(DIST, "assets", "index-abc.js"));
    expect(cheminStatique(DIST + sep, "/favicon.svg")).toBe(join(DIST, "favicon.svg"));
  });

  it.each(["/..", "/../secret.txt", "/../../etc/passwd", "/assets/../../secret.txt"])(
    "refuse la traversée de chemin %s",
    (chemin) => {
      expect(cheminStatique(DIST, chemin)).toBeNull();
    },
  );

  it("refuse un dossier voisin dont le nom commence pareil (dist-autre)", () => {
    // `startsWith(DIST)` sans séparateur acceptait /srv/grammaria/dist-autre/….
    expect(cheminStatique(DIST, "/../dist-autre/secret.txt")).toBeNull();
    expect(cheminStatique(DIST, "/../dist")).toBeNull();
  });

  it("un chemin encodé reste dans le dossier", () => {
    // Normalisé par l'URL avant d'arriver au serveur…
    expect(pathname("/%2e%2e/dist-autre/secret.txt")).toBe("/dist-autre/secret.txt");
    expect(cheminStatique(DIST, pathname("/%2e%2e/dist-autre/secret.txt"))).toBe(
      join(DIST, "dist-autre", "secret.txt"),
    );
    // … ou laissé encodé : un nom de fichier littéral, jamais décodé en « ../ ».
    for (const chemin of ["/..%2Fdist-autre%2Fsecret.txt", "/%2e%2e%2fsecret.txt"]) {
      const fichier = cheminStatique(DIST, pathname(chemin));
      expect(fichier?.startsWith(DIST + sep)).toBe(true);
    }
  });
});

// Issue #42 : en-têtes de durcissement de l'interface web.
describe("en-têtes de sécurité", () => {
  it("la CSP est stricte et limitée à l'origine", () => {
    expect(CSP_WEB).toContain("default-src 'self'");
    expect(CSP_WEB).toContain("script-src 'self'");
    expect(CSP_WEB).toContain("connect-src 'self'");
    expect(CSP_WEB).toContain("frame-ancestors 'none'");
    expect(CSP_WEB).toContain("object-src 'none'");
    // Aucune exécution arbitraire de script : pas de unsafe-eval ni de joker.
    expect(CSP_WEB).not.toContain("unsafe-eval");
    expect(CSP_WEB).not.toContain("*");
    // Le seul assouplissement toléré porte sur les styles.
    expect(CSP_WEB).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("applique la CSP et les en-têtes de durcissement à une réponse", () => {
    const r = avecEnTetesSecurite(new Response("x"));
    expect(r.headers.get("Content-Security-Policy")).toBe(CSP_WEB);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

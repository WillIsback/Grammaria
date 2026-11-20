/**
 * Amorce du bureau (jsdom) et pilote Tauri du journal :
 *  - le pilote transmet les arguments attendus par db.rs et le message d'erreur de Rust TEL QUEL
 *    (chaîne ou objet), pour que le journal reconnaisse un conflit (`Conflit : …`) ;
 *  - l'amorce installe le pont avant le rendu, affiche une erreur lisible si le journal ne
 *    s'ouvre pas, et un bandeau si le correcteur ne se charge pas (jsdom n'a pas de Worker).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { estConflit } from "../../journal.driver";
import { amorcer } from "../../src/desktop/amorce";
import { creerPiloteTauri } from "../../src/desktop/journal.driver.tauri";
import { erreurCommande } from "../../src/desktop/tauri";
import { tauriSimule } from "./helpers/tauriSimule";

describe("pilote Tauri du journal", () => {
  it("transmet les arguments de db_read, db_read_many et db_batch", async () => {
    const invoke = vi.fn(async () => [] as never);
    const pilote = creerPiloteTauri(invoke);
    await pilote.read("SELECT 1");
    await pilote.read("SELECT ?", [2]);
    await pilote.readMany([{ sql: "SELECT 1" }, { sql: "SELECT ?", params: ["a"] }]);
    await pilote.batch([
      { sql: "INSERT INTO t VALUES (?)", params: [1] },
      { sql: "UPDATE t SET x = ?", params: [{ $rowid: 0 }], expectChanges: 1 },
      { sql: "DELETE FROM t" },
    ]);
    expect(invoke.mock.calls).toEqual([
      ["db_read", { sql: "SELECT 1", params: [] }],
      ["db_read", { sql: "SELECT ?", params: [2] }],
      [
        "db_read_many",
        {
          queries: [
            { sql: "SELECT 1", params: [] },
            { sql: "SELECT ?", params: ["a"] },
          ],
        },
      ],
      [
        "db_batch",
        {
          statements: [
            { sql: "INSERT INTO t VALUES (?)", params: [1] },
            { sql: "UPDATE t SET x = ?", params: [{ $rowid: 0 }], expectChanges: 1 },
            { sql: "DELETE FROM t", params: [] },
          ],
        },
      ],
    ]);
  });

  it("le message d'erreur de Rust arrive tel quel ; « Conflit : » est reconnu", async () => {
    const message = "Conflit : l'instruction 0 du lot a modifié 0 ligne(s) au lieu de 1";
    const enChaine = creerPiloteTauri(() => Promise.reject(message));
    const erreur = await enChaine.batch([{ sql: "UPDATE t SET x = 1", expectChanges: 1 }]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erreur).toBeInstanceOf(Error);
    expect((erreur as Error).message).toBe(message);
    expect(estConflit(erreur)).toBe(true);

    const enObjet = creerPiloteTauri(() =>
      Promise.reject({ message: "Instruction 2 : no such table" }),
    );
    const autre = await enObjet.read("SELECT * FROM x").catch((e: unknown) => e);
    expect((autre as Error).message).toBe("Instruction 2 : no such table");
    expect(estConflit(autre)).toBe(false);
  });

  it("erreurCommande garde les champs d'un objet d'erreur (statut du modèle)", () => {
    const erreur = erreurCommande({ status: 400, message: "refus", cancelled: false });
    expect(erreur).toMatchObject({ message: "refus", status: 400, cancelled: false });
    const deja = new Error("x");
    expect(erreurCommande(deja)).toBe(deja);
  });
});

describe("amorce du bureau", () => {
  const fetchOrigine = window.fetch;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
    window.fetch = fetchOrigine;
    vi.restoreAllMocks();
  });

  it("hors de l'application : message lisible, pas d'interface", async () => {
    const rendre = vi.fn();
    await amorcer(rendre);
    expect(rendre).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="erreur-demarrage"]')?.textContent).toContain(
      "application de bureau",
    );
  });

  it("journal impossible à ouvrir : message d'erreur à la place de la page blanche", async () => {
    const tauri = tauriSimule();
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: (commande: string, args?: Record<string, unknown>) =>
          commande.startsWith("db_")
            ? Promise.reject("impossible d'ouvrir la base : disque plein")
            : tauri.api.invoke(commande, args),
        Channel: tauri.api.Channel,
      },
    };
    const rendre = vi.fn();
    await amorcer(rendre);
    expect(rendre).not.toHaveBeenCalled();
    const erreur = document.querySelector('[data-testid="erreur-demarrage"]');
    expect(erreur?.textContent).toContain("Le journal de Grammaria n'a pas pu être ouvert.");
    expect(erreur?.textContent).toContain("disque plein");
    expect(erreur?.querySelector("button")?.textContent).toBe("Réessayer");
  });

  // Validation finale : après « Installez la dernière version », la consigne générique
  // « Fermez Grammaria puis relancez-la » et le bouton « Réessayer » étaient contradictoires.
  it("journal d'une version plus récente : pas de « Réessayer », lien vers le téléchargement", async () => {
    const tauri = tauriSimule();
    const appels: string[] = [];
    let ouverture: Promise<unknown> = Promise.resolve();
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: (commande: string, args?: Record<string, unknown>) => {
          appels.push(commande);
          if (commande === "db_read") return Promise.resolve([{ user_version: 999 }]);
          if (commande.startsWith("db_")) return Promise.reject("aucune écriture attendue");
          if (commande === "update_open_release_page") return ouverture;
          return tauri.api.invoke(commande, args);
        },
        Channel: tauri.api.Channel,
      },
    };
    const rendre = vi.fn();
    await amorcer(rendre);
    expect(rendre).not.toHaveBeenCalled();
    expect(appels.filter((c) => c === "db_batch")).toHaveLength(0);
    const ecran = document.querySelector('[data-testid="erreur-demarrage"]')!;
    expect(ecran.getAttribute("role")).toBe("alert");
    expect(ecran.querySelector("h1")?.textContent).toBe(
      "Ce journal a été créé par une version plus récente de Grammaria.",
    );
    expect(ecran.textContent).toContain(
      "Installez la dernière version de Grammaria pour l'ouvrir. Votre journal n'a pas été modifié.",
    );
    expect(ecran.textContent).not.toContain("Fermez Grammaria");
    expect(ecran.textContent).not.toContain("schéma");
    const boutons = [...ecran.querySelectorAll("button")].map((b) => b.textContent);
    expect(boutons).toEqual(["Ouvrir la page de téléchargement"]);

    ecran.querySelector("button")!.click();
    expect(appels).toContain("update_open_release_page");

    // Page impossible à ouvrir : l'adresse est donnée en clair (role=status).
    ouverture = Promise.reject("aucun navigateur");
    ecran.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(ecran.querySelector('[role="status"]')?.textContent).toContain(
        "github.com/WillIsback/Grammaria/releases",
      ),
    );
  });

  it("pont installé avant le rendu ; correcteur absent : bandeau, interface quand même", async () => {
    const tauri = tauriSimule();
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: tauri.api };
    const rendre = vi.fn(() => {
      // Au rendu, les fetch de l'interface passent déjà par le pont.
      expect(window.fetch).not.toBe(fetchOrigine);
    });
    await amorcer(rendre);
    expect(rendre).toHaveBeenCalledOnce();
    const reglages = await (await window.fetch("/api/settings")).json();
    expect(reglages).toMatchObject({ editable: true, hasApiKey: false });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="bandeau-bureau"]')?.textContent).toContain(
        "analyse des fautes sera partielle",
      ),
    );
    // Échec du chargement noté dans le journal technique (grammaria.log).
    expect(tauri.journalTechnique).toContainEqual({
      niveau: "erreur",
      message: expect.stringMatching(/^Correcteur impossible à charger : /),
    });
    document.querySelector<HTMLButtonElement>('[data-testid="bandeau-bureau"] button')!.click();
    expect(document.querySelector('[data-testid="bandeau-bureau"]')).toBeNull();
  });
});

describe("porte de l'autotest", () => {
  const fetchOrigine = window.fetch;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><textarea></textarea></div>';
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
    delete window.__GRAMMARIA_AUTOTEST__;
    window.fetch = fetchOrigine;
    vi.restoreAllMocks();
  });

  it("sans le drapeau posé par l'application, l'autotest n'est pas chargé", async () => {
    const tauri = tauriSimule();
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: tauri.api };
    await amorcer(() => {});
    expect(tauri.commandes()).not.toContain("autotest_config");
  });

  it("drapeau présent mais autotest refusé par l'application : rien n'est exécuté", async () => {
    const tauri = tauriSimule();
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: tauri.api };
    window.__GRAMMARIA_AUTOTEST__ = true;
    await amorcer(() => {});
    const apres = tauri.commandes();
    expect(apres).toContain("autotest_config");
    // Après le refus d'autotest_config : ni lot, ni réglages, ni modèle, ni résultats.
    // (Le journal technique, log_page, peut noter l'absence de Worker dans jsdom.)
    const suite = apres.slice(apres.indexOf("autotest_config") + 1).filter((c) => c !== "log_page");
    expect(suite).toEqual([]);
    expect(tauri.reglages.llmTarget).toBe("");
  });
});

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
    document.querySelector<HTMLButtonElement>('[data-testid="bandeau-bureau"] button')!.click();
    expect(document.querySelector('[data-testid="bandeau-bureau"]')).toBeNull();
  });
});

/**
 * Journal technique du bureau, côté page (src/desktop/journal-technique.ts) : une seule commande
 * (`log_page`), messages bornés, jamais d'exception ; erreurs non interceptées et rejets notés ;
 * ligne de fin de correction sans le texte, appelée par le gestionnaire partagé.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { creerGestionnaire } from "../../api/handler";
import { Journal } from "../../journal";
import { dependancesBureau } from "../../src/desktop/dependances";
import { creerPiloteTauri } from "../../src/desktop/journal.driver.tauri";
import {
  creerJournalTechnique,
  installerCaptureErreurs,
  ligneFinCorrection,
} from "../../src/desktop/journal-technique";
import { tauriSimule } from "./helpers/tauriSimule";

afterEach(() => vi.restoreAllMocks());

describe("journal technique de la page", () => {
  it("écrit par log_page, message borné, sans jamais lever d'erreur", async () => {
    const invoke = vi.fn(async () => null as never);
    const journal = creerJournalTechnique(invoke);
    journal.ecrire("erreur", "x".repeat(10_000));
    expect(invoke).toHaveBeenCalledWith("log_page", {
      niveau: "erreur",
      message: "x".repeat(2_000),
    });

    // Commande refusée ou absente : rien ne remonte à l'interface.
    const refuse = creerJournalTechnique(() => Promise.reject("Commande non autorisée"));
    expect(() => refuse.ecrire("info", "a")).not.toThrow();
    const casse = creerJournalTechnique(() => {
      throw new Error("pas de Tauri");
    });
    expect(() => casse.ecrire("info", "a")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("note les erreurs non interceptées et les rejets de promesse, puis se retire", () => {
    const lignes: string[] = [];
    const retirer = installerCaptureErreurs({ ecrire: (_n, m) => lignes.push(m) });
    const erreur = new Error("x is not a function");
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: erreur.message,
        error: erreur,
        filename: "tauri://localhost/assets/index.js",
        lineno: 12,
        colno: 3,
      }),
    );
    const rejet = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejet, "reason", { value: "Serveur du modèle injoignable" });
    window.dispatchEvent(rejet);
    // Échec de chargement d'une ressource : ni message ni erreur, ignoré.
    window.dispatchEvent(new ErrorEvent("error"));
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatch(
      /^Erreur JavaScript non interceptée \(tauri:\/\/localhost\/assets\/index\.js:12:3\) : x is not a function/,
    );
    expect(lignes[1]).toBe("Promesse rejetée sans traitement : Serveur du modèle injoignable");

    retirer();
    window.dispatchEvent(new ErrorEvent("error", { message: "après" }));
    expect(lignes).toHaveLength(2);
  });

  it("ligne de fin de correction : durées et raisonnement, rien d'autre", () => {
    expect(
      ligneFinCorrection({
        dureeMs: 1234,
        premierMotMs: 210,
        fragmentsRaisonnement: 0,
        raisonnementCoupe: true,
      }),
    ).toBe(
      "Correction terminée en 1234 ms (premier mot après 210 ms, fragments de raisonnement : 0, raisonnement coupé : oui)",
    );
    expect(
      ligneFinCorrection({
        dureeMs: 5,
        premierMotMs: null,
        fragmentsRaisonnement: 3,
        raisonnementCoupe: false,
      }),
    ).toContain("premier mot après — ms, fragments de raisonnement : 3, raisonnement coupé : non");
  });

  it("le gestionnaire signale la fin d'une correction sans le texte ni la réponse", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tauri = tauriSimule();
    const journal = await Journal.ouvrir(creerPiloteTauri(tauri.api.invoke));
    const technique = creerJournalTechnique(tauri.api.invoke);
    const gestionnaire = creerGestionnaire(
      dependancesBureau({
        api: tauri.api,
        journal,
        correcteur: { check: async () => [] },
        surFinCorrection: (mesure) => technique.ecrire("info", ligneFinCorrection(mesure)),
      }),
    );
    const reponse = await gestionnaire(
      new Request("tauri://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Mon texte secret." }] }),
      }),
    );
    const flux = await reponse!.text();
    expect(flux).toContain('"done":true');
    await vi.waitFor(() => expect(tauri.journalTechnique).toHaveLength(1));
    const [ligne] = tauri.journalTechnique;
    expect(ligne.niveau).toBe("info");
    expect(ligne.message).toMatch(
      /^Correction terminée en \d+ ms \(premier mot après \d+ ms, fragments de raisonnement : 2, raisonnement coupé : oui\)$/,
    );
    expect(ligne.message).not.toContain("secret");
    expect(ligne.message).not.toContain("Bonjour");
  });
});

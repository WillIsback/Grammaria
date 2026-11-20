import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CorrecteurBureau, type EtatCorrecteur } from "../../src/desktop/correcteur.ts";

const match = (id: string, offset = 0) => ({
  message: "m",
  shortMessage: "",
  offset,
  length: 1,
  replacements: [],
  rule: { id, issueType: "grammar", category: { id: "C", name: "c" } },
});

const MESURES = { donneesOctets: 34_000_000, chargementMs: 180 };

/** Promesse résolue ou rejetée à la main, pour jouer la réponse d'une commande Rust. */
function differee<T>() {
  let resolve!: (valeur: T) => void;
  let reject!: (raison: unknown) => void;
  const promesse = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promesse, resolve, reject };
}

/** Faux backend : enregistre les commandes, le test répond à sa place. */
function fauxBackend() {
  const appels: { commande: string; args?: Record<string, unknown> }[] = [];
  const reponses: ReturnType<typeof differee<unknown>>[] = [];
  const invoke = <T>(commande: string, args?: Record<string, unknown>): Promise<T> => {
    appels.push({ commande, args });
    const reponse = differee<unknown>();
    reponses.push(reponse);
    return reponse.promesse as Promise<T>;
  };
  return {
    invoke,
    appels,
    commandes: () => appels.map((a) => a.commande),
    /** Répond à la n-ième commande reçue. */
    repondre: (n: number, valeur: unknown) => reponses[n].resolve(valeur),
    refuser: (n: number, raison: unknown) => reponses[n].reject(raison),
  };
}

const vider = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CorrecteurBureau (moteur Rust de l'application)", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("ne charge rien avant la première demande", () => {
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke);
    expect(correcteur.etat).toBe("arrete");
    expect(backend.appels).toEqual([]);
  });

  it("préchauffage : états successifs, mesures du chargement, un seul chargement", async () => {
    const backend = fauxBackend();
    const etats: EtatCorrecteur[] = [];
    const correcteur = new CorrecteurBureau(backend.invoke, { onEtat: (e) => etats.push(e) });
    const premier = correcteur.prechauffer();
    const second = correcteur.prechauffer();
    expect(backend.commandes()).toEqual(["correcteur_prechauffer"]);
    backend.repondre(0, MESURES);
    await Promise.all([premier, second]);
    expect(etats).toEqual(["chargement", "pret"]);
    expect(correcteur.mesures).toEqual(MESURES);
    expect(correcteur.erreur).toBeNull();
    // Déjà prêt : pas de nouvelle commande.
    await correcteur.prechauffer();
    expect(backend.commandes()).toEqual(["correcteur_prechauffer"]);
  });

  it("check : charge d'abord, puis rend les détections telles que le backend les donne", async () => {
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke);
    const demande = correcteur.check("Les enfants était content.");
    expect(backend.commandes()).toEqual(["correcteur_prechauffer"]);
    backend.repondre(0, MESURES);
    await vider();
    expect(backend.appels[1]).toEqual({
      commande: "correcteur_controler",
      args: { texte: "Les enfants était content." },
    });
    backend.repondre(1, [match("ACCORD", 12)]);
    expect(await demande).toEqual([match("ACCORD", 12)]);
    expect(correcteur.etat).toBe("pret");
  });

  it("plusieurs demandes pendant le chargement : chacune reçoit sa réponse", async () => {
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke);
    const a = correcteur.check("a");
    const b = correcteur.check("b");
    backend.repondre(0, MESURES);
    await vider();
    expect(backend.appels.slice(1).map((x) => x.args?.texte)).toEqual(["a", "b"]);
    // Réponses dans le désordre.
    backend.repondre(2, [match("B")]);
    backend.repondre(1, [match("A")]);
    expect(await a).toEqual([match("A")]);
    expect(await b).toEqual([match("B")]);
  });

  it("données absentes : message lisible, état erreur, puis nouvel essai à la demande suivante", async () => {
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke);
    const demande = correcteur.check("Bonjour.");
    // Rust rejette `invoke` avec une chaîne.
    backend.refuser(
      0,
      "Le correcteur grammatical n'a pas pu charger ses données : fichier lt/french.dict introuvable. Réinstallez Grammaria.",
    );
    await expect(demande).rejects.toThrow(/french\.dict introuvable/);
    expect(correcteur.etat).toBe("erreur");
    expect(correcteur.erreur).toContain("n'a pas pu charger ses données");
    expect(correcteur.mesures).toBeNull();

    const suivante = correcteur.check("Bonjour.");
    expect(backend.commandes()).toEqual(["correcteur_prechauffer", "correcteur_prechauffer"]);
    backend.repondre(1, MESURES);
    await vider();
    backend.repondre(2, []);
    expect(await suivante).toEqual([]);
    expect(correcteur.etat).toBe("pret");
    expect(correcteur.erreur).toBeNull();
  });

  it("analyse en échec : la demande est rejetée avec une Error, le correcteur reste prêt", async () => {
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke);
    const pret = correcteur.prechauffer();
    backend.repondre(0, MESURES);
    await pret;
    const demande = correcteur.check("x");
    backend.refuser(1, "Le correcteur grammatical s'est arrêté pendant l'analyse.");
    const erreur = await demande.catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(Error);
    expect((erreur as Error).message).toContain("arrêté pendant l'analyse");
    expect(correcteur.etat).toBe("pret");
  });

  it("backend muet : la demande est rejetée après le délai", async () => {
    vi.useFakeTimers();
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke, { delaiControleMs: 1000 });
    const pret = correcteur.prechauffer();
    backend.repondre(0, MESURES);
    await pret;
    const demande = correcteur.check("x");
    const attendu = expect(demande).rejects.toThrow("ne répond pas");
    await vi.advanceTimersByTimeAsync(1000);
    await attendu;
  });

  it("close pendant le chargement : la demande en attente est rejetée, l'état revient à arrêté", async () => {
    const backend = fauxBackend();
    const correcteur = new CorrecteurBureau(backend.invoke);
    const demande = correcteur.check("x");
    correcteur.close();
    expect(correcteur.etat).toBe("arrete");
    backend.repondre(0, MESURES);
    await expect(demande).rejects.toThrow("a été arrêté");
    expect(backend.commandes()).toEqual(["correcteur_prechauffer"]);
    // Un nouvel appel repart d'un préchauffage (immédiat côté Rust : moteur déjà chargé).
    const suivante = correcteur.check("y");
    backend.repondre(1, MESURES);
    await vider();
    backend.repondre(2, []);
    expect(await suivante).toEqual([]);
  });
});

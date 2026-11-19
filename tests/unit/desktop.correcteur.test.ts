import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CorrecteurBureau,
  type EtatCorrecteur,
  type WorkerCorrecteur,
} from "../../src/desktop/correcteur.ts";
import type { MessageDuWorker, MessageVersWorker } from "../../src/desktop/protocole-lt.ts";

/** Faux Worker : enregistre les messages reçus, la page de test répond à sa place. */
class FauxWorker implements WorkerCorrecteur {
  recus: MessageVersWorker[] = [];
  arrete = false;
  onmessage: ((event: MessageEvent<MessageDuWorker>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: URL) {}
  postMessage(message: MessageVersWorker) {
    this.recus.push(message);
  }
  terminate() {
    this.arrete = true;
  }
  repondre(message: MessageDuWorker) {
    this.onmessage?.({ data: message } as MessageEvent<MessageDuWorker>);
  }
  pret() {
    this.repondre({
      type: "pret",
      mesures: {
        archiveOctets: 1,
        fichiers: 1,
        archiveMs: 1,
        lectureMs: 1,
        reglesMs: 1,
        totalMs: 3,
      },
    });
  }
  /** Répond à la n-ième demande de contrôle reçue. */
  resultat(n: number, matches: unknown[]) {
    const demande = this.controles()[n];
    this.repondre({ type: "resultat", id: demande.id, json: JSON.stringify(matches) });
  }
  controles() {
    return this.recus.filter((m) => m.type === "controle");
  }
  tomber(message = "") {
    this.onerror?.(Object.assign(new Event("error"), { message }));
  }
}

const match = (id: string, offset = 0) => ({
  message: "m",
  shortMessage: "",
  offset,
  length: 1,
  replacements: [],
  rule: { id, issueType: "grammar", category: { id: "C", name: "c" } },
});

let workers: FauxWorker[];
let etats: EtatCorrecteur[];
const creer = (options: ConstructorParameters<typeof CorrecteurBureau>[0] = {}) =>
  new CorrecteurBureau({
    creerWorker: (url) => {
      const w = new FauxWorker(url);
      workers.push(w);
      return w;
    },
    onEtat: (etat) => etats.push(etat),
    ...options,
  });

beforeEach(() => {
  workers = [];
  etats = [];
});
afterEach(() => vi.useRealTimers());

describe("CorrecteurBureau", () => {
  it("ne crée le Worker qu'à la première demande, à côté de la page", async () => {
    const correcteur = creer();
    expect(workers).toHaveLength(0);
    const resultat = correcteur.check("Je mange un pomme.");
    expect(workers).toHaveLength(1);
    expect(workers[0].url.pathname).toBe("/lt/worker.js");
    expect(correcteur.etat).toBe("chargement");
    // Rien n'est envoyé avant que les règles soient chargées.
    expect(workers[0].controles()).toHaveLength(0);
    workers[0].pret();
    expect(workers[0].controles()).toEqual([
      { type: "controle", id: 1, texte: "Je mange un pomme." },
    ]);
    workers[0].resultat(0, [match("UN_UNE")]);
    expect(await resultat).toEqual([match("UN_UNE")]);
    expect(etats).toEqual(["chargement", "pret"]);
    expect(correcteur.mesures?.totalMs).toBe(3);
  });

  it("rend les détections telles que le serveur les sérialise en JSON", async () => {
    const correcteur = creer();
    const resultat = correcteur.check("x");
    workers[0].pret();
    workers[0].repondre({
      type: "resultat",
      id: 1,
      json: '[{"offset":0,"length":1,"message":"m","replacements":[],"rule":{"id":"R"}}]',
    });
    const [m] = await resultat;
    expect(m).toEqual({ offset: 0, length: 1, message: "m", replacements: [], rule: { id: "R" } });
  });

  it("préchauffe : la promesse se résout quand les règles sont chargées", async () => {
    const correcteur = creer();
    let pret = false;
    const prechauffage = correcteur.prechauffer().then(() => (pret = true));
    await Promise.resolve();
    expect(pret).toBe(false);
    workers[0].pret();
    await prechauffage;
    expect(pret).toBe(true);
    await correcteur.prechauffer(); // déjà prêt : immédiat, pas de second Worker
    expect(workers).toHaveLength(1);
  });

  it("met les demandes en file : une seule à la fois dans le Worker, réponses dans l'ordre", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    const b = correcteur.check("b");
    const c = correcteur.check("c");
    workers[0].pret();
    expect(workers[0].controles().map((m) => m.texte)).toEqual(["a"]);
    workers[0].resultat(0, [match("A")]);
    expect(await a).toEqual([match("A")]);
    expect(workers[0].controles().map((m) => m.texte)).toEqual(["a", "b"]);
    workers[0].repondre({ type: "echec", id: workers[0].controles()[1].id, message: "boum" });
    await expect(b).rejects.toThrow("Le correcteur grammatical a échoué : boum");
    workers[0].resultat(2, []);
    expect(await c).toEqual([]);
  });

  it("ignore une réponse qui ne correspond pas à la demande en cours", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    workers[0].pret();
    workers[0].repondre({ type: "resultat", id: 999, json: "[1]" });
    workers[0].resultat(0, []);
    expect(await a).toEqual([]);
  });

  it("archive absente : rejette avec un message lisible, puis retente à la demande suivante", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    const b = correcteur.check("b");
    const prechauffage = correcteur.prechauffer();
    workers[0].repondre({
      type: "erreur",
      message: "archive des règles introuvable (/lt/fr.pack : HTTP 404).",
    });
    const attendu =
      "Le correcteur grammatical n'a pas pu charger ses règles : archive des règles introuvable (/lt/fr.pack : HTTP 404).";
    await expect(a).rejects.toThrow(attendu);
    await expect(b).rejects.toThrow(attendu);
    await expect(prechauffage).rejects.toThrow(attendu);
    expect(correcteur.etat).toBe("erreur");
    expect(correcteur.erreur).toBe(attendu);
    expect(workers[0].arrete).toBe(true);

    const c = correcteur.check("c");
    expect(workers).toHaveLength(2);
    workers[1].pret();
    workers[1].resultat(0, []);
    expect(await c).toEqual([]);
    expect(etats).toEqual(["chargement", "erreur", "chargement", "pret"]);
  });

  it("script du Worker introuvable : message lisible", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    workers[0].tomber();
    await expect(a).rejects.toThrow(
      "Le correcteur grammatical n'a pas pu charger ses règles : le script du Worker est introuvable ou invalide",
    );
  });

  it("Worker impossible à créer : message lisible", async () => {
    const correcteur = new CorrecteurBureau({
      creerWorker: () => {
        throw new Error("Worker non pris en charge");
      },
    });
    await expect(correcteur.check("a")).rejects.toThrow(
      "n'a pas pu charger ses règles : Worker non pris en charge",
    );
    expect(await correcteur.diagnostic()).toEqual([]);
  });

  it("Worker tombé pendant une analyse : recréé, l'analyse est relancée une fois", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    const b = correcteur.check("b");
    workers[0].pret();
    workers[0].tomber("Out of memory");
    expect(workers[0].arrete).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1].pret();
    // La demande interrompue repasse en tête de file.
    expect(workers[1].controles().map((m) => m.texte)).toEqual(["a"]);
    workers[1].tomber("Out of memory");
    await expect(a).rejects.toThrow("Le correcteur grammatical s'est arrêté : Out of memory.");
    // Les autres demandes continuent avec un nouveau Worker.
    workers[2].pret();
    workers[2].resultat(0, [match("B")]);
    expect(await b).toEqual([match("B")]);
  });

  it("Worker bloqué : délai dépassé, Worker arrêté et recréé pour les demandes suivantes", async () => {
    vi.useFakeTimers();
    const correcteur = creer({ delaiControleMs: 1000 });
    const a = correcteur.check("a");
    const b = correcteur.check("b");
    workers[0].pret();
    const rejet = expect(a).rejects.toThrow("Le correcteur grammatical ne répond pas.");
    vi.advanceTimersByTime(1000);
    await rejet;
    expect(workers[0].arrete).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1].pret();
    workers[1].resultat(0, []);
    expect(await b).toEqual([]);
  });

  it("chargement trop long : rejet lisible", async () => {
    vi.useFakeTimers();
    const correcteur = creer({ delaiChargementMs: 5000 });
    const a = correcteur.check("a");
    const rejet = expect(a).rejects.toThrow(
      "n'a pas pu charger ses règles : le chargement des règles a dépassé le délai",
    );
    vi.advanceTimersByTime(5000);
    await rejet;
    expect(workers[0].arrete).toBe(true);
    expect(correcteur.etat).toBe("erreur");
  });

  it("le délai d'une analyse ne court qu'une fois les règles chargées", async () => {
    vi.useFakeTimers();
    const correcteur = creer({ delaiChargementMs: 60_000, delaiControleMs: 1000 });
    const a = correcteur.check("a");
    vi.advanceTimersByTime(30_000);
    workers[0].pret();
    vi.advanceTimersByTime(999);
    workers[0].resultat(0, []);
    expect(await a).toEqual([]);
  });

  it("close() arrête le Worker et rejette les demandes en attente", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    correcteur.close();
    await expect(a).rejects.toThrow("Le correcteur grammatical a été arrêté.");
    expect(workers[0].arrete).toBe(true);
    expect(correcteur.etat).toBe("arrete");
  });

  it("une réponse d'un ancien Worker est ignorée", async () => {
    const correcteur = creer();
    const a = correcteur.check("a");
    workers[0].pret();
    const ancien = workers[0];
    ancien.tomber("x");
    ancien.repondre({ type: "resultat", id: 1, json: "[]" });
    workers[1].pret();
    workers[1].resultat(0, [match("A")]);
    expect(await a).toEqual([match("A")]);
  });

  it("diagnostic : ressources absentes de l'archive", async () => {
    const correcteur = creer();
    const d = correcteur.diagnostic();
    expect(workers[0].recus).toEqual([{ type: "diagnostic" }]);
    workers[0].repondre({ type: "diagnostic", absentes: ["fr/french.info"] });
    expect(await d).toEqual(["fr/french.info"]);
  });
});

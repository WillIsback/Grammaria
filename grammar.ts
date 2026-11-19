import type { LTMatch } from "./src/types.ts";

/**
 * Correcteur grammatical intégré : les règles françaises de LanguageTool,
 * portées en JavaScript (@valueerror/ltjs-core), tournent dans un Worker du
 * serveur. Aucun service externe à lancer.
 */

/** Délai maximal d'une analyse, chargement initial des règles compris. */
const CHECK_TIMEOUT_MS = 30_000;

type Pending = {
  resolve: (matches: LTMatch[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerReply = { id: number; matches?: LTMatch[]; error?: string };

export class GrammarChecker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** Charge les règles en arrière-plan pour que la première correction soit rapide. */
  warmUp(): void {
    this.check("Bonjour.").catch(() => {
      /* l'erreur réapparaîtra à la première vraie demande */
    });
  }

  check(text: string): Promise<LTMatch[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Le correcteur grammatical ne répond pas."));
      }, CHECK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, text });
    });
  }

  /** Arrête le worker et rejette les analyses en attente. */
  close(): void {
    this.failAll(new Error("Le correcteur grammatical a été arrêté."));
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./grammar.worker.ts", import.meta.url).href);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const { id, matches, error } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (error !== undefined) entry.reject(new Error(error));
      else entry.resolve(matches ?? []);
    };
    // Un worker tombé est recréé à la demande suivante.
    worker.onerror = (event) => {
      this.failAll(new Error(event.message || "Le correcteur grammatical s'est arrêté."));
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

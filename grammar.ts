import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LTMatch } from "./src/types.ts";

/**
 * Correcteur grammatical intégré (depuis la 0.4.0) : le moteur Rust grammaria-rc
 * (règles françaises de LanguageTool réimplémentées en natif) tourne dans un processus à
 * part, lancé une fois et gardé ouvert (`grammaria serve`). Aucun service externe à lancer.
 *
 * Protocole (une demande à la fois, traitées dans l'ordre) :
 *   → `<id> <octets>\n` puis le texte en UTF-8
 *   ← une ligne JSON `{"id":…,"matches":[…]}`, positions en unités UTF-16 comme en JavaScript
 * Le moteur écrit `{"ready":true}` une fois ses données chargées.
 *
 * Le binaire et ses données sont produits par `scripts/moteur/construire.sh` dans `moteur/`.
 */

/**
 * Délai maximal d'une analyse, chargement initial des données compris (moins d'une seconde
 * mesurée). Plus court que le délai de la page (30 s, src/services/languagetool.ts) : le
 * serveur répond une erreur avant que la page abandonne.
 */
const CHECK_TIMEOUT_MS = 15_000;

/** Délai laissé au moteur pour s'arrêter après SIGTERM, avant SIGKILL. */
const KILL_GRACE_MS = 2_000;

export type OptionsCorrecteur = {
  /** Délai maximal d'une analyse (défaut : 15 s). */
  delaiMs?: number;
  /** Délai entre SIGTERM et SIGKILL (défaut : 2 s). */
  graceMs?: number;
};

const RACINE = dirname(fileURLToPath(import.meta.url));

/**
 * Binaire du moteur (GRAMMARIA_MOTEUR, défaut : `moteur/grammaria` à côté de ce fichier,
 * `grammaria.exe` sous Windows, comme le produit scripts/moteur/construire.sh).
 */
export function cheminMoteur(): string {
  const binaire = process.platform === "win32" ? "grammaria.exe" : "grammaria";
  return resolve(process.env.GRAMMARIA_MOTEUR || join(RACINE, "moteur", binaire));
}

/** Données du moteur (GRAMMARIA_MOTEUR_DONNEES, défaut : `moteur/data`). */
export function cheminDonnees(): string {
  return resolve(process.env.GRAMMARIA_MOTEUR_DONNEES || join(RACINE, "moteur", "data"));
}

type Pending = {
  resolve: (matches: LTMatch[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Reply = { ready?: boolean; id?: number; matches?: LTMatch[]; error?: string };

export class GrammarChecker {
  private moteur: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Moteurs lancés et pas encore terminés, y compris ceux qu'on est en train d'arrêter. */
  private readonly vivants = new Set<ChildProcessWithoutNullStreams>();
  private readonly delaiMs: number;
  private readonly graceMs: number;
  /**
   * À la sortie du serveur (normale, process.exit, exception non rattrapée), aucun moteur
   * ne doit survivre : un moteur bloqué ne lirait jamais la fin de son entrée standard.
   * `kill` est synchrone : il part avant la fin du processus.
   */
  private readonly tuerALaSortie = () => {
    for (const moteur of this.vivants) moteur.kill("SIGKILL");
  };

  constructor(options: OptionsCorrecteur = {}) {
    this.delaiMs = options.delaiMs ?? CHECK_TIMEOUT_MS;
    this.graceMs = options.graceMs ?? KILL_GRACE_MS;
  }

  /** Charge les données en arrière-plan pour que la première correction soit rapide. */
  warmUp(): void {
    this.check("Bonjour.").catch(() => {
      /* l'erreur réapparaîtra à la première vraie demande */
    });
  }

  check(text: string): Promise<LTMatch[]> {
    return new Promise((resolve, reject) => {
      let moteur: ChildProcessWithoutNullStreams;
      try {
        moteur = this.ensureMoteur();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        // Les réponses arrivent dans l'ordre : un moteur bloqué bloque aussi les demandes
        // suivantes. On l'arrête ; le prochain appel en relance un.
        this.arreter(new Error("Le correcteur grammatical ne répond pas."));
      }, this.delaiMs);
      this.pending.set(id, { resolve, reject, timer });
      // Un seul write : l'en-tête et le texte ne peuvent pas être séparés par une autre demande.
      const corps = Buffer.from(text, "utf8");
      moteur.stdin.write(Buffer.concat([Buffer.from(`${id} ${corps.length}\n`), corps]));
    });
  }

  /** Arrête le moteur et rejette les analyses en attente. */
  close(): void {
    this.arreter(new Error("Le correcteur grammatical a été arrêté."));
  }

  /** Nombre de processus du moteur encore en vie (diagnostic, tests). */
  get processusVivants(): number {
    return this.vivants.size;
  }

  private ensureMoteur(): ChildProcessWithoutNullStreams {
    if (this.moteur) return this.moteur;
    const moteur = spawn(cheminMoteur(), ["serve", "--data", cheminDonnees()], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.moteur = moteur;
    if (this.vivants.size === 0) process.on("exit", this.tuerALaSortie);
    this.vivants.add(moteur);

    let tampon = "";
    moteur.stdout.setEncoding("utf8");
    moteur.stdout.on("data", (bloc: string) => {
      tampon += bloc;
      let fin = tampon.indexOf("\n");
      while (fin >= 0) {
        this.recevoir(tampon.slice(0, fin));
        tampon = tampon.slice(fin + 1);
        fin = tampon.indexOf("\n");
      }
    });
    // Dernières lignes d'erreur du moteur, jointes au message s'il s'arrête.
    let erreurs = "";
    moteur.stderr.setEncoding("utf8");
    moteur.stderr.on("data", (bloc: string) => {
      erreurs = (erreurs + bloc).slice(-500);
    });
    // Un moteur tombé (ou introuvable) est relancé à la demande suivante.
    const tombe = (cause: string) => {
      if (this.moteur !== moteur) return;
      this.moteur = null;
      const detail = erreurs.trim();
      this.failAll(new Error(`Le correcteur grammatical s'est arrêté : ${detail || cause}.`));
    };
    const termine = () => {
      this.vivants.delete(moteur);
      if (this.vivants.size === 0) process.off("exit", this.tuerALaSortie);
    };
    moteur.on("error", (error) => {
      // Binaire introuvable : le processus n'a jamais existé, « close » peut ne pas suivre.
      if (moteur.pid === undefined) termine();
      tombe(error.message);
    });
    moteur.on("exit", termine);
    // « close » plutôt que « exit » : les dernières lignes d'erreur ont alors été lues.
    moteur.on("close", (code, signal) => tombe(signal ? `signal ${signal}` : `code ${code}`));
    // Écriture dans un moteur déjà arrêté : l'événement « close » rejette les demandes.
    moteur.stdin.on("error", () => {});
    return moteur;
  }

  private recevoir(ligne: string): void {
    let reponse: Reply;
    try {
      reponse = JSON.parse(ligne) as Reply;
    } catch {
      return;
    }
    if (reponse.id === undefined) return;
    const entry = this.pending.get(reponse.id);
    if (!entry) return;
    this.pending.delete(reponse.id);
    clearTimeout(entry.timer);
    if (reponse.error !== undefined) entry.reject(new Error(reponse.error));
    else entry.resolve(reponse.matches ?? []);
  }

  private arreter(error: Error): void {
    const moteur = this.moteur;
    this.moteur = null;
    this.failAll(error);
    if (!moteur || !this.vivants.has(moteur)) return;
    moteur.kill("SIGTERM");
    // Un moteur bloqué qui ignore SIGTERM resterait orphelin : SIGKILL après le délai.
    const forcer = setTimeout(() => {
      if (this.vivants.has(moteur)) moteur.kill("SIGKILL");
    }, this.graceMs);
    forcer.unref?.();
    moteur.once("exit", () => clearTimeout(forcer));
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

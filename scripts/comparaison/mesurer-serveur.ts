/**
 * Mesure le vrai serveur (`bun run server.ts`) d'un arbre de sources de Grammaria, de bout en
 * bout par HTTP (POST /api/check) : la dernière version publiée et la version expérimentale
 * se mesurent de la même façon.
 *
 * - démarrage : du lancement du processus à la première réponse de /api/check (le serveur
 *   préchauffe le correcteur) ;
 * - latence à chaud par taille de texte (médiane, p95) ;
 * - débit : requêtes simultanées sur le texte de 160 mots ;
 * - mémoire résidente du serveur et de ses processus enfants, au repos puis après la charge.
 *
 * Usage (Bun) :
 *   bun scripts/comparaison/mesurer-serveur.ts --racine <arbre> --nom <étiquette> --sortie <fichier.json>
 *       [--repetitions 30] [--simultanees 16] [--lancements 3]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORPUS } from "../../tests/fixtures/correcteur/corpus.ts";

export interface TempsServeur {
  mediane: number;
  p95: number;
  min: number;
  max: number;
}

export interface MesureServeur {
  nom: string;
  racine: string;
  /** Lancement du processus → première réponse 200 de POST /api/check, par lancement. */
  demarrageMs: number[];
  /** Mémoire résidente (serveur et enfants), en Mo. */
  memoireMo: { apresDemarrage: number; apresCharge: number };
  /** Latence à chaud de POST /api/check, par texte. */
  latence: { nom: string; mots: number; ms: TempsServeur }[];
  debit: { simultanees: number; requetes: number; dureeMs: number; parSeconde: number };
}

const args = process.argv.slice(2);
const option = (nom: string): string | undefined => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};

function memoireMo(pid: number): number {
  let ko = 0;
  try {
    ko = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    const enfants = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    for (const enfant of enfants.split(/\s+/).filter(Boolean))
      ko += memoireMo(Number(enfant)) * 1024;
  } catch {
    /* processus terminé entre-temps */
  }
  return Math.round((ko / 1024) * 10) / 10;
}

function stat(durees: number[]): TempsServeur {
  const t = [...durees].sort((a, b) => a - b);
  const arrondi = (n: number) => Math.round(n * 100) / 100;
  const rang = (q: number) => t[Math.min(t.length - 1, Math.floor(q * t.length))];
  return {
    mediane: arrondi(rang(0.5)),
    p95: arrondi(rang(0.95)),
    min: arrondi(t[0]),
    max: arrondi(t[t.length - 1]),
  };
}

interface Serveur {
  base: string;
  pid: number;
  demarrageMs: number;
  arreter(): Promise<void>;
}

async function controler(base: string, text: string): Promise<Response> {
  return fetch(`${base}/api/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function lancer(racine: string): Promise<Serveur> {
  const port = 26_000 + Math.floor(Math.random() * 4000);
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "grammaria-mesure-"));
  const debut = performance.now();
  const processus = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: racine,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      GRAMMARIA_DESKTOP: "1",
      JOURNAL_PATH: join(dir, "journal.db"),
      GRAMMARIA_SETTINGS_PATH: join(dir, "settings.json"),
      GRAMMARIA_VALID_WORDS_PATH: join(dir, "valid-words.json"),
      GRAMMARIA_DIST_DIR: dir,
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const arreter = async () => {
    processus.kill();
    await processus.exited;
    rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; i < 6000; i++) {
    try {
      const reponse = await controler(base, "Bonjour.");
      if (reponse.ok) {
        await reponse.json();
        return {
          base,
          pid: processus.pid,
          demarrageMs: Math.round(performance.now() - debut),
          arreter,
        };
      }
    } catch {
      /* pas encore à l'écoute */
    }
    await Bun.sleep(10);
  }
  await arreter();
  throw new Error("Le serveur n'a pas démarré");
}

async function main() {
  const racine = resolve(option("--racine") ?? ".");
  const nom = option("--nom") ?? racine;
  const sortie = option("--sortie");
  const repetitions = Number(option("--repetitions") ?? 30);
  const simultanees = Number(option("--simultanees") ?? 16);
  const lancements = Number(option("--lancements") ?? 3);
  if (!sortie) throw new Error("--sortie <fichier.json> est requis");

  // Démarrages à froid répétés ; le dernier serveur sert aux autres mesures.
  const demarrageMs: number[] = [];
  let serveur = await lancer(racine);
  demarrageMs.push(serveur.demarrageMs);
  for (let i = 1; i < lancements; i++) {
    await serveur.arreter();
    serveur = await lancer(racine);
    demarrageMs.push(serveur.demarrageMs);
  }
  console.error(`[${nom}] démarrages : ${demarrageMs.join(", ")} ms`);

  try {
    await Bun.sleep(500);
    const apresDemarrage = memoireMo(serveur.pid);

    const textes = ["court", "marche-160-mots", "long", "tres-long"].map((n) => {
      const texte = CORPUS.find((t) => t.nom === n);
      if (!texte) throw new Error(`Texte « ${n} » absent du corpus`);
      return texte;
    });
    const latence: MesureServeur["latence"] = [];
    for (const { nom: nomTexte, texte } of textes) {
      await (await controler(serveur.base, texte)).json();
      const durees: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const t = performance.now();
        await (await controler(serveur.base, texte)).json();
        durees.push(performance.now() - t);
      }
      const ms = stat(durees);
      latence.push({ nom: nomTexte, mots: texte.split(/\s+/).filter(Boolean).length, ms });
      console.error(`[${nom}] ${nomTexte} : médiane ${ms.mediane} ms, p95 ${ms.p95} ms`);
    }

    // Débit : `simultanees` clients envoient chacun 10 fois le texte de 160 mots.
    const marche = textes[1].texte;
    const parClient = 10;
    const t = performance.now();
    await Promise.all(
      Array.from({ length: simultanees }, async () => {
        for (let i = 0; i < parClient; i++) await (await controler(serveur.base, marche)).json();
      }),
    );
    const dureeMs = performance.now() - t;
    const requetes = simultanees * parClient;
    const debit = {
      simultanees,
      requetes,
      dureeMs: Math.round(dureeMs),
      parSeconde: Math.round((requetes / dureeMs) * 1000 * 10) / 10,
    };
    console.error(`[${nom}] débit : ${debit.parSeconde} requêtes/s (${simultanees} clients)`);

    const mesure: MesureServeur = {
      nom,
      racine,
      demarrageMs,
      memoireMo: { apresDemarrage, apresCharge: memoireMo(serveur.pid) },
      latence,
      debit,
    };
    writeFileSync(sortie, `${JSON.stringify(mesure, null, 1)}\n`);
    console.error(`[${nom}] → ${sortie}`);
  } finally {
    await serveur.arreter();
  }
}

if (import.meta.main) await main();

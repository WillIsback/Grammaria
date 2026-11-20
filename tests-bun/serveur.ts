import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lance le vrai serveur (`server.ts`) dans un processus à part, avec un
 * dossier temporaire pour le journal, les réglages, les mots valides et les
 * fichiers de l'interface. Le mode bureau est activé par défaut.
 */
export interface ServeurDeTest {
  base: string;
  port: number;
  dir: string;
  /** Processus du serveur (pour vérifier ses enfants, lui envoyer un signal). */
  pid: number;
  /** Fin du processus du serveur : son code de sortie. */
  fin: Promise<number>;
  arreter(): void;
}

export interface OptionsServeur {
  /** Variables d'environnement ajoutées ou remplacées. */
  env?: Record<string, string>;
  /** Appelé avant le démarrage, par exemple pour remplir le journal. */
  preparer?: (dir: string) => void;
}

export async function lancerServeur(options: OptionsServeur = {}): Promise<ServeurDeTest> {
  const port = 26_000 + Math.floor(Math.random() * 4000);
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "grammaria-serveur-"));
  options.preparer?.(dir);

  const processus = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
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
      ...options.env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const arreter = () => {
    processus.kill();
    rmSync(dir, { recursive: true, force: true });
  };

  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`${base}/api/journal`);
      return { base, port, dir, pid: processus.pid, fin: processus.exited, arreter };
    } catch {
      await Bun.sleep(100);
    }
  }
  arreter();
  throw new Error("Le serveur n'a pas démarré");
}

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammarChecker } from "../grammar.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { lancerServeur } from "./serveur.ts";

// Moteur réel : le moteur Rust grammaria-rc, lancé une fois par
// grammar.ts (`moteur/grammaria serve`). À construire avant : `npm run build:moteur`.
const checker = new GrammarChecker();
afterAll(() => checker.close());

// Le premier appel lance le moteur et charge ses données.
const LOAD_TIMEOUT_MS = 60_000;

/** Message de l'erreur qui rejette `promesse` ; null si elle aboutit. */
const messageEchec = (promesse: Promise<unknown>): Promise<string | null> =>
  promesse.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("GrammarChecker", () => {
  it(
    "détecte les fautes au format LanguageTool",
    async () => {
      const text = "Je mange un pomme. Il a manger une pomme.";
      const matches = await checker.check(text);

      const accord = matches.find((m) => m.rule.id === "D_N_E_OU_E");
      expect(accord && text.slice(accord.offset, accord.offset + accord.length)).toBe("un pomme");
      // Comme LanguageTool : « un pommé » puis « une pomme ».
      expect(accord?.replacements.map((r) => r.value)).toContain("une pomme");
      expect(accord?.rule.category?.id).toBeTruthy();
      expect(accord?.message).toContain("pomme");
      const participe = matches.find((m) => m.rule.id === "R_VAVOIR_VINF");
      expect(participe && text.slice(participe.offset, participe.offset + participe.length)).toBe(
        "manger",
      );
    },
    LOAD_TIMEOUT_MS,
  );

  // Anciennes pertes de la première version du moteur Rust, retrouvées depuis qu'il porte la
  // chaîne de LanguageTool elle-même (benchmark/moteur-rust/rapport.md).
  it("reconnaît une faute d'orthographe (FR_SPELLING_RULE)", async () => {
    const text = "Je mange une pomee.";
    const faute = (await checker.check(text)).find((m) => m.rule.id === "FR_SPELLING_RULE");
    expect(faute && text.slice(faute.offset, faute.offset + faute.length)).toBe("pomee");
    expect(faute?.replacements.map((r) => r.value)).toContain("pomme");
  });

  it("détecte l'accord sujet-verbe (ACCORD_SUJET_VERBE)", async () => {
    const matches = await checker.check("Les enfants était contents.");
    expect(matches.some((m) => m.rule.id === "ACCORD_SUJET_VERBE")).toBe(true);
  });

  it("ne signale pas en orthographe un mot inconnu qui a l'allure d'un nom propre", async () => {
    // Profil de Grammaria (assets/fr/grammaria/profile.txt du moteur).
    const matches = await checker.check("Hier, j'ai vu Pencroff à la gare.");
    expect(matches.filter((m) => m.rule.id === "FR_SPELLING_RULE")).toEqual([]);
  });

  it("ne signale rien sur un texte correct", async () => {
    expect(await checker.check("Les enfants étaient contents.")).toEqual([]);
  });

  it("positions en unités UTF-16, comme les chaînes JavaScript (emojis, accents)", async () => {
    const text = "Génial 😀 👨‍👩‍👧 ! Je mange un pomme.";
    const matches = await checker.check(text);
    const accord = matches.find((m) => m.rule.id === "D_N_E_OU_E");
    expect(accord && text.slice(accord.offset, accord.offset + accord.length)).toBe("un pomme");
  });

  it("demandes simultanées : chacune reçoit sa propre réponse", async () => {
    const textes = Array.from({ length: 12 }, (_, i) =>
      i % 2 ? `Texte ${i} : je mange un pomme.` : `Texte ${i} : je mange une pomme.`,
    );
    const resultats = await Promise.all(textes.map((t) => checker.check(t)));
    expect(resultats.map((m) => m.filter((x) => x.rule.id === "D_N_E_OU_E").length)).toEqual(
      textes.map((_, i) => i % 2),
    );
  });

  it("alimente l'analyse : la faute corrigée est classée et comptée", async () => {
    const original = "Je mange un pomme.";
    const corrected = "Je mange une pomme.";
    const analysis = analyze(original, corrected, await checker.check(original));
    expect(analysis.corrections[0].faults[0]).toMatchObject({
      source: "lt",
      ruleKey: "D_N_E_OU_E",
      counted: true,
    });
  });
});

describe("GrammarChecker — processus du moteur", () => {
  it("moteur tué : les demandes en cours sont rejetées, la suivante le relance", async () => {
    const local = new GrammarChecker();
    try {
      expect(await local.check("Bonjour.")).toEqual([]);
      const moteur = (local as unknown as { moteur: { kill(): void } }).moteur;
      const enCours = local.check("Je mange un pomme.");
      moteur.kill();
      expect(await messageEchec(enCours)).toContain("s'est arrêté");
      const suivante = await local.check("Je mange un pomme.");
      expect(suivante.some((m) => m.rule.id === "D_N_E_OU_E")).toBe(true);
    } finally {
      local.close();
    }
  });

  it("binaire introuvable : erreur lisible, sans bloquer", async () => {
    const avant = process.env.GRAMMARIA_MOTEUR;
    process.env.GRAMMARIA_MOTEUR = "/introuvable/grammaria";
    const local = new GrammarChecker();
    try {
      expect(await messageEchec(local.check("Bonjour."))).toContain(
        "Le correcteur grammatical s'est arrêté",
      );
    } finally {
      local.close();
      if (avant === undefined) delete process.env.GRAMMARIA_MOTEUR;
      else process.env.GRAMMARIA_MOTEUR = avant;
    }
  });

  it("données introuvables : le message du moteur est transmis", async () => {
    const avant = process.env.GRAMMARIA_MOTEUR_DONNEES;
    process.env.GRAMMARIA_MOTEUR_DONNEES = "/introuvable/data";
    const local = new GrammarChecker();
    try {
      expect(await messageEchec(local.check("Bonjour."))).toMatch(/cannot load the language data/);
    } finally {
      local.close();
      if (avant === undefined) delete process.env.GRAMMARIA_MOTEUR_DONNEES;
      else process.env.GRAMMARIA_MOTEUR_DONNEES = avant;
    }
  });

  it("close : les demandes en attente sont rejetées", async () => {
    const local = new GrammarChecker();
    const demande = local.check("Bonjour.");
    local.close();
    expect(await messageEchec(demande)).toContain("a été arrêté");
  });
});

/** Faux moteur bloqué : se dit prêt, ignore SIGTERM et ne répond jamais. */
function fauxMoteurBloque(): { chemin: string; nettoyer(): void } {
  const dir = mkdtempSync(join(tmpdir(), "grammaria-faux-moteur-"));
  const chemin = join(dir, "grammaria");
  // `exec` : l'état « SIGTERM ignoré » passe au processus qui le remplace.
  writeFileSync(chemin, `#!/bin/sh\ntrap '' TERM\necho '{"ready":true}'\nexec sleep 600\n`);
  chmodSync(chemin, 0o755);
  return { chemin, nettoyer: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Vrai si le processus `pid` existe encore. */
function vivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pids des processus enfants de `pid` (Linux : /proc). */
function enfants(pid: number): number[] {
  const sortie = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString();
  return sortie.split("\n").filter(Boolean).map(Number);
}

async function attendre(condition: () => boolean, delaiMs: number): Promise<boolean> {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    if (condition()) return true;
    await Bun.sleep(25);
  }
  return condition();
}

describe("GrammarChecker — moteur bloqué", () => {
  it("erreur lisible après le délai, processus tué même s'il ignore SIGTERM, relance ensuite", async () => {
    const faux = fauxMoteurBloque();
    const avant = process.env.GRAMMARIA_MOTEUR;
    process.env.GRAMMARIA_MOTEUR = faux.chemin;
    // Délai assez long pour que le vrai moteur, relancé ensuite, charge ses données.
    const local = new GrammarChecker({ delaiMs: 3_000, graceMs: 200 });
    try {
      const debut = Date.now();
      const demande = local.check("Bonjour.");
      const pid = (local as unknown as { moteur: { pid: number } }).moteur.pid;
      expect(await messageEchec(demande)).toBe("Le correcteur grammatical ne répond pas.");
      expect(Date.now() - debut).toBeLessThan(6_000);
      // SIGTERM ignoré : SIGKILL après le délai de grâce, aucun orphelin.
      expect(await attendre(() => !vivant(pid), 3_000)).toBe(true);
      expect(local.processusVivants).toBe(0);

      // La demande suivante relance un moteur (ici le vrai).
      if (avant === undefined) delete process.env.GRAMMARIA_MOTEUR;
      else process.env.GRAMMARIA_MOTEUR = avant;
      const suivante = await local.check("Je mange un pomme.");
      expect(suivante.some((m) => m.rule.id === "D_N_E_OU_E")).toBe(true);
    } finally {
      local.close();
      if (avant === undefined) delete process.env.GRAMMARIA_MOTEUR;
      else process.env.GRAMMARIA_MOTEUR = avant;
      faux.nettoyer();
    }
  }, 20_000);
});

describe("Serveur — cycle de vie du moteur", () => {
  it("SIGTERM : le serveur s'arrête et ne laisse aucun moteur, même bloqué", async () => {
    const faux = fauxMoteurBloque();
    const serveur = await lancerServeur({ env: { GRAMMARIA_MOTEUR: faux.chemin } });
    try {
      // Le préchauffage a lancé le (faux) moteur.
      expect(await attendre(() => enfants(serveur.pid).length > 0, 3_000)).toBe(true);
      const moteurs = enfants(serveur.pid);
      process.kill(serveur.pid, "SIGTERM");
      expect(await serveur.fin).toBe(0);
      expect(await attendre(() => moteurs.every((pid) => !vivant(pid)), 3_000)).toBe(true);
    } finally {
      serveur.arreter();
      faux.nettoyer();
    }
  }, 20_000);

  it("moteur tué pendant que le serveur tourne : la correction suivante le relance", async () => {
    const serveur = await lancerServeur();
    try {
      const verifier = () =>
        fetch(`${serveur.base}/api/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Je mange un pomme." }),
        });
      expect((await verifier()).status).toBe(200);
      const [moteur] = enfants(serveur.pid);
      process.kill(moteur, "SIGKILL");
      expect(await attendre(() => !vivant(moteur), 3_000)).toBe(true);
      const reponse = await verifier();
      expect(reponse.status).toBe(200);
      const { matches } = (await reponse.json()) as { matches: { rule: { id: string } }[] };
      expect(matches.some((m) => m.rule.id === "D_N_E_OU_E")).toBe(true);
    } finally {
      serveur.arreter();
    }
  }, 20_000);

  it("binaire du moteur absent : réponse 503 immédiate, le serveur reste disponible", async () => {
    const serveur = await lancerServeur({ env: { GRAMMARIA_MOTEUR: "/introuvable/grammaria" } });
    try {
      const debut = Date.now();
      const reponse = await fetch(`${serveur.base}/api/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Bonjour." }),
      });
      expect(reponse.status).toBe(503);
      expect(Date.now() - debut).toBeLessThan(6_000);
      expect((await fetch(`${serveur.base}/api/journal`)).status).toBe(200);
    } finally {
      serveur.arreter();
    }
  }, 20_000);

  it("port déjà pris : le serveur s'arrête en erreur sans laisser de moteur", async () => {
    const occupant = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const dir = mkdtempSync(join(tmpdir(), "grammaria-port-"));
    try {
      const processus = Bun.spawn(["bun", "run", "server.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PORT: String(occupant.port),
          HOST: "127.0.0.1",
          JOURNAL_PATH: join(dir, "journal.db"),
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      // Enfants vus pendant la vie du serveur (le moteur est lancé avant l'écoute).
      const vus = new Set<number>();
      const surveillance = setInterval(() => {
        for (const pid of enfants(processus.pid)) vus.add(pid);
      }, 10);
      const code = await processus.exited;
      clearInterval(surveillance);
      expect(code).not.toBe(0);
      expect(await attendre(() => [...vus].every((pid) => !vivant(pid)), 3_000)).toBe(true);
    } finally {
      void occupant.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../journal.ts";
import type { Progression } from "../src/analysis/progression/calcul.ts";
import { analyze } from "../src/analysis/analyze.ts";
import type { LTMatch } from "../src/types.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Faute de frappe signalée par le correcteur grammatical sur « apareil ». */
function fauteDeFrappe() {
  const original = "Mon apareil est en panne depuis ce matin.";
  const match = {
    offset: 4,
    length: 7,
    message: "Faute de frappe possible",
    shortMessage: "",
    replacements: [{ value: "appareil" }],
    rule: {
      id: "FR_SPELLING_RULE",
      issueType: "misspelling",
      category: { id: "TYPOS", name: "Faute de frappe possible" },
    },
  } as unknown as LTMatch;
  return analyze(original, "Mon appareil est en panne depuis ce matin.", [match]);
}

const FAUTE_ON = () =>
  analyze("Hier, ils on mangé tous les gâteaux.", "Hier, ils ont mangé tous les gâteaux.", []);

describe("Journal.progress", () => {
  it("lit textes, fautes et règles du journal pour l'écran Progression", () => {
    const now = new Date(2026, 10, 19, 15).getTime();
    const journal = new Journal(":memory:");
    expect(journal.progress(now).empty).toBe(true);

    journal.record(FAUTE_ON(), now - 2 * DAY);
    journal.record(FAUTE_ON(), now - DAY);
    journal.record(FAUTE_ON(), now - 1000);
    journal.record(fauteDeFrappe(), now - 500);
    journal.record(fauteDeFrappe(), now - 200 * DAY); // hors des 12 semaines

    const p = journal.progress(now);
    expect(p.empty).toBe(false);
    expect(p.totals.texts).toBe(5);
    expect(p.period.texts).toBe(4);
    expect(p.rules.counts.signalee).toBe(1);
    expect(p.rules.active[0]).toMatchObject({ ruleKey: "PAIRE:on/ont", label: "on / ont" });
    expect(p.frequentRules[0]).toMatchObject({ ruleKey: "PAIRE:on/ont", count: 3 });
    expect(p.trapWords).toEqual([{ word: "apareil", replacement: "appareil", count: 1 }]);
    journal.close();
  });
});

describe("GET /api/progress (serveur)", () => {
  const port = 26000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  let dir: string;
  let server: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "grammaria-progress-"));
    const journal = new Journal(join(dir, "journal.db"));
    journal.record(FAUTE_ON(), Date.now() - DAY);
    journal.record(fauteDeFrappe(), Date.now() - 1000);
    journal.close();

    server = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "server.ts")], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        GRAMMARIA_DESKTOP: "1",
        JOURNAL_PATH: join(dir, "journal.db"),
        GRAMMARIA_SETTINGS_PATH: join(dir, "settings.json"),
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${base}/api/progress`);
        return;
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error("le serveur n'a pas démarré");
  }, 20_000);

  afterAll(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renvoie tout l'écran en une seule requête", async () => {
    const response = await fetch(`${base}/api/progress`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const p = (await response.json()) as Progression;
    expect(p.empty).toBe(false);
    expect(p.totals.texts).toBe(2);
    expect(p.series).toHaveLength(12);
    expect(p.mastery.score).toBeNull(); // moins de 5 textes récents
    expect(p.trapWords[0]).toMatchObject({ word: "apareil", replacement: "appareil" });
  });

  it("refuse un en-tête Host étranger en mode bureau, comme les autres routes du journal", async () => {
    const response = await fetch(`${base}/api/progress`, { headers: { Host: "evil.example" } });
    expect(response.status).toBe(403);
  });

  it("n'accepte que GET (et OPTIONS)", async () => {
    const post = await fetch(`${base}/api/progress`, { method: "POST" });
    expect(post.status).toBe(405);
    const options = await fetch(`${base}/api/progress`, { method: "OPTIONS" });
    expect(options.status).toBe(200);
    expect(options.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("reflète l'effacement du journal", async () => {
    const purge = await fetch(`${base}/api/journal`, { method: "DELETE" });
    expect(purge.status).toBe(200);
    const p = (await (await fetch(`${base}/api/progress`)).json()) as Progression;
    expect(p.empty).toBe(true);
    expect(p.totals.texts).toBe(0);
  });
});

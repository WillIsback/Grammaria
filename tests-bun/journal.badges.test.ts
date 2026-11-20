import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type Journal, SCHEMA_VERSION } from "../journal.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { BADGES } from "../src/analysis/badges/catalogue.ts";
import {
  avecBase,
  corriger as journaliser,
  FAUTE_ON,
  jour,
  ouvrirJournal,
  SANS_FAUTE,
} from "./helpers.ts";

/** Texte de plus de 30 mots, sans faute. */
const LONG = Array(2).fill(
  "Nous vous remercions pour votre message et nous vous confirmons la réunion de jeudi prochain à dix heures dans la grande salle du deuxième étage avec toute l'équipe du projet.",
);

/** Journalise un texte, puis renvoie les badges qu'il fait obtenir. */
async function corriger(journal: Journal, texte: string[], now: number) {
  await journaliser(journal, texte, now);
  return journal.badges.award(now);
}

const ids = (badges: { id: string }[]) => badges.map((b) => b.id);
const obtenus = async (journal: Journal, now: number) =>
  (await journal.badges.catalogue(now)).badges
    .filter((b) => b.obtenu)
    .map((b) => [b.id, b.obtenuLe]);

describe("Journal — badges", () => {
  it("annonce le premier badge à la première correction, une seule fois", async () => {
    const journal = await ouvrirJournal(":memory:");
    expect(ids(await corriger(journal, SANS_FAUTE, jour(0)))).toEqual(["premier-texte"]);
    expect(await corriger(journal, SANS_FAUTE, jour(0) + 1000)).toEqual([]);
    expect(await obtenus(journal, jour(1))).toEqual([["premier-texte", jour(0)]]);
  });

  it("regroupe les badges obtenus avec le même texte", async () => {
    const journal = await ouvrirJournal(":memory:");
    expect(ids(await corriger(journal, LONG, jour(0)))).toEqual([
      "premier-texte",
      "premier-sans-faute",
    ]);
  });

  it("attribue « Première règle acquise » à la date d'acquisition", async () => {
    const journal = await ouvrirJournal(":memory:");
    for (const n of [0, 1, 2]) await corriger(journal, FAUTE_ON, jour(n));
    for (const n of [3, 4, 5, 6])
      expect(ids(await corriger(journal, SANS_FAUTE, jour(n)))).not.toContain("premiere-regle");
    // 14 jours après la dernière faute, sur 5 textes et plus de 3 jours d'utilisation.
    expect(ids(await corriger(journal, SANS_FAUTE, jour(16)))).toContain("premiere-regle");
    expect((await journal.rules())[0].state).toBe("acquise");
    expect((await journal.badges.obtained()).get("premiere-regle")).toBe(jour(16));
  });

  it("ne retire jamais un badge obtenu, même si le critère n'est plus rempli", async () => {
    const journal = await ouvrirJournal(":memory:");
    for (let n = 0; n < 10; n++) await corriger(journal, LONG, jour(n));
    expect((await journal.badges.obtained()).get("note-18")).toBe(jour(9));
    // La moyenne des 30 derniers jours tombe sous 18 : le badge reste.
    for (let n = 10; n < 20; n++) await corriger(journal, FAUTE_ON, jour(n));
    const note = (await journal.badges.catalogue(jour(20))).badges.find((b) => b.id === "note-18");
    expect(note?.progression.valeur).toBeLessThan(18);
    expect(note).toMatchObject({ obtenu: true, obtenuLe: jour(9) });
  });

  it("expose le catalogue complet avec la progression de chaque badge", async () => {
    const journal = await ouvrirJournal(":memory:");
    for (let n = 0; n < 3; n++) await corriger(journal, SANS_FAUTE, jour(n));
    const catalogue = await journal.badges.catalogue(jour(3));
    expect(catalogue.total).toBe(BADGES.length);
    expect(catalogue.obtenus).toBe(1);
    expect(catalogue.badges.find((b) => b.id === "textes-10")).toMatchObject({
      obtenu: false,
      obtenuLe: null,
      progression: { valeur: 3, seuil: 10 },
    });
    expect(catalogue.badges.find((b) => b.id === "jours-5")?.progression).toEqual({
      valeur: 3,
      seuil: 5,
    });
  });

  it("efface les badges avec le journal", async () => {
    const journal = await ouvrirJournal(":memory:");
    await corriger(journal, LONG, jour(0));
    await journal.purge();
    expect((await journal.badges.obtained()).size).toBe(0);
    // Après l'effacement, le premier badge peut de nouveau être obtenu.
    expect(ids(await corriger(journal, SANS_FAUTE, jour(1)))).toEqual(["premier-texte"]);
  });
});

describe("Journal — migration du schéma v1 vers v2 (badges)", () => {
  /** Base v1 : journal et cycle des règles, sans table des badges. */
  async function baseV1(path: string): Promise<void> {
    const journal = await ouvrirJournal(path);
    for (let n = 0; n < 12; n++) {
      await journal.record(analyze(LONG[0], LONG[1], []), jour(n * 7), { original: LONG[0] });
    }
    await journal.close();
    const db = new Database(path);
    db.exec("DROP TABLE badges; PRAGMA user_version = 1;");
    db.close();
  }

  const contenu = (path: string) => {
    const db = new Database(path, { readonly: true });
    const lignes = {
      texts: db.query("SELECT * FROM texts ORDER BY id").all(),
      faults: db.query("SELECT * FROM faults ORDER BY id").all(),
      rules: db.query("SELECT * FROM rule_states ORDER BY rule_key").all(),
      events: db.query("SELECT * FROM rule_events ORDER BY id").all(),
      version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    };
    db.close();
    return lignes;
  };

  it("attribue rétroactivement les badges mérités, à leur date, sans notification", async () => {
    await avecBase(async (path) => {
      await baseV1(path);
      const avant = contenu(path);
      expect(avant.version).toBe(1);

      const journal = await ouvrirJournal(path);
      const attribues = await journal.badges.obtained();
      expect(Object.fromEntries(attribues)).toEqual({
        "premier-texte": jour(0),
        "textes-10": jour(63),
        "jours-5": jour(28),
        "semaines-4": jour(21),
        "semaines-12": jour(77),
        "premier-sans-faute": jour(0),
        "sans-faute-10": jour(63),
      });
      // Rien à annoncer à la correction suivante pour ces badges.
      expect(await journal.badges.award(jour(80))).toEqual([]);
      await journal.close();

      const apres = contenu(path);
      expect(apres.texts).toEqual(avant.texts);
      expect(apres.faults).toEqual(avant.faults);
      expect(apres.rules).toEqual(avant.rules);
      expect(apres.events).toEqual(avant.events);
      expect(apres.version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(2);
    });
  });

  it("est idempotente : rouvrir la base ne modifie pas les badges", async () => {
    await avecBase(async (path) => {
      await baseV1(path);
      const premier = await ouvrirJournal(path);
      const badges = await premier.badges.obtained();
      await premier.close();
      const second = await ouvrirJournal(path);
      expect(await second.badges.obtained()).toEqual(badges);
      await second.close();
      expect(contenu(path).version).toBe(2);
    });
  });
});

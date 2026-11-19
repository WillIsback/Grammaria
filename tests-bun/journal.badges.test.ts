import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Journal, SCHEMA_VERSION } from "../journal.ts";
import { awardBadgesSafely } from "../journal.badges.ts";
import { analyze } from "../src/analysis/analyze.ts";
import { BADGES } from "../src/analysis/badges/catalogue.ts";
import { avecBase, corriger as journaliser, FAUTE_ON, jour, SANS_FAUTE } from "./helpers.ts";

/** Texte de plus de 30 mots, sans faute. */
const LONG = Array(2).fill(
  "Nous vous remercions pour votre message et nous vous confirmons la réunion de jeudi prochain à dix heures dans la grande salle du deuxième étage avec toute l'équipe du projet.",
);

/** Journalise un texte, puis renvoie les badges qu'il fait obtenir. */
function corriger(journal: Journal, texte: string[], now: number) {
  journaliser(journal, texte, now);
  return journal.badges.award(now);
}

const ids = (badges: { id: string }[]) => badges.map((b) => b.id);
const obtenus = (journal: Journal, now: number) =>
  journal.badges
    .catalogue(now)
    .badges.filter((b) => b.obtenu)
    .map((b) => [b.id, b.obtenuLe]);

describe("Journal — badges", () => {
  it("annonce le premier badge à la première correction, une seule fois", () => {
    const journal = new Journal(":memory:");
    expect(ids(corriger(journal, SANS_FAUTE, jour(0)))).toEqual(["premier-texte"]);
    expect(corriger(journal, SANS_FAUTE, jour(0) + 1000)).toEqual([]);
    expect(obtenus(journal, jour(1))).toEqual([["premier-texte", jour(0)]]);
  });

  it("regroupe les badges obtenus avec le même texte", () => {
    const journal = new Journal(":memory:");
    expect(ids(corriger(journal, LONG, jour(0)))).toEqual(["premier-texte", "premier-sans-faute"]);
  });

  it("attribue « Première règle acquise » à la date d'acquisition", () => {
    const journal = new Journal(":memory:");
    for (const n of [0, 1, 2]) corriger(journal, FAUTE_ON, jour(n));
    for (const n of [3, 4, 5, 6])
      expect(ids(corriger(journal, SANS_FAUTE, jour(n)))).not.toContain("premiere-regle");
    // 14 jours après la dernière faute, sur 5 textes et plus de 3 jours d'utilisation.
    expect(ids(corriger(journal, SANS_FAUTE, jour(16)))).toContain("premiere-regle");
    expect(journal.rules()[0].state).toBe("acquise");
    expect(journal.badges.obtained().get("premiere-regle")).toBe(jour(16));
  });

  it("ne retire jamais un badge obtenu, même si le critère n'est plus rempli", () => {
    const journal = new Journal(":memory:");
    for (let n = 0; n < 10; n++) corriger(journal, LONG, jour(n));
    expect(journal.badges.obtained().get("note-18")).toBe(jour(9));
    // La moyenne des 30 derniers jours tombe sous 18 : le badge reste.
    for (let n = 10; n < 20; n++) corriger(journal, FAUTE_ON, jour(n));
    const note = journal.badges.catalogue(jour(20)).badges.find((b) => b.id === "note-18");
    expect(note?.progression.valeur).toBeLessThan(18);
    expect(note).toMatchObject({ obtenu: true, obtenuLe: jour(9) });
  });

  it("expose le catalogue complet avec la progression de chaque badge", () => {
    const journal = new Journal(":memory:");
    for (let n = 0; n < 3; n++) corriger(journal, SANS_FAUTE, jour(n));
    const catalogue = journal.badges.catalogue(jour(3));
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

  it("efface les badges avec le journal", () => {
    const journal = new Journal(":memory:");
    corriger(journal, LONG, jour(0));
    journal.purge();
    expect(journal.badges.obtained().size).toBe(0);
    // Après l'effacement, le premier badge peut de nouveau être obtenu.
    expect(ids(corriger(journal, SANS_FAUTE, jour(1)))).toEqual(["premier-texte"]);
  });

  it("n'interrompt jamais l'analyse si le calcul des badges échoue", () => {
    const enPanne = {
      award: () => {
        throw new Error("base verrouillée");
      },
    };
    const erreur = console.error;
    console.error = () => {};
    try {
      expect(awardBadgesSafely(enPanne)).toEqual([]);
    } finally {
      console.error = erreur;
    }
  });
});

describe("Journal — migration du schéma v1 vers v2 (badges)", () => {
  /** Base v1 : journal et cycle des règles, sans table des badges. */
  function baseV1(path: string): void {
    const journal = new Journal(path);
    for (let n = 0; n < 12; n++) {
      journal.record(analyze(LONG[0], LONG[1], []), jour(n * 7), { original: LONG[0] });
    }
    journal.close();
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

  it("attribue rétroactivement les badges mérités, à leur date, sans notification", () => {
    avecBase((path) => {
      baseV1(path);
      const avant = contenu(path);
      expect(avant.version).toBe(1);

      const journal = new Journal(path);
      const attribues = journal.badges.obtained();
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
      expect(journal.badges.award(jour(80))).toEqual([]);
      journal.close();

      const apres = contenu(path);
      expect(apres.texts).toEqual(avant.texts);
      expect(apres.faults).toEqual(avant.faults);
      expect(apres.rules).toEqual(avant.rules);
      expect(apres.events).toEqual(avant.events);
      expect(apres.version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(2);
    });
  });

  it("est idempotente : rouvrir la base ne modifie pas les badges", () => {
    avecBase((path) => {
      baseV1(path);
      const premier = new Journal(path);
      const badges = premier.badges.obtained();
      premier.close();
      const second = new Journal(path);
      expect(second.badges.obtained()).toEqual(badges);
      second.close();
      expect(contenu(path).version).toBe(2);
    });
  });
});

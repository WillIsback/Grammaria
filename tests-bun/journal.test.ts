import { describe, expect, it } from "bun:test";
import { analyze } from "../src/analysis/analyze.ts";
import { DAY, ouvrirJournal } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 18);

function sample() {
  // 10 mots, 2 fautes : « on » (fiche) et « manger » (fiche).
  return analyze(
    "Ils on manger tous les gâteaux de la fête hier.",
    "Ils ont mangé tous les gâteaux de la fête hier.",
    [],
  );
}

describe("Journal", () => {
  it("enregistre un texte et ses fautes, puis les agrège sur la période", async () => {
    const journal = await ouvrirJournal(":memory:");
    await journal.record(sample(), NOW - DAY);
    await journal.record(sample(), NOW - 2 * DAY);

    const period = await journal.period(7, NOW);
    expect(period).toEqual({ texts: 2, words: 20, faults: 4, score: 0 });

    const summary = await journal.summary(7, NOW);
    expect(summary.rules.map((r) => [r.ruleKey, r.count])).toEqual([
      ["PAIRE:on/ont", 2],
      ["TERMINAISON:er/é", 2],
    ]);
    expect(summary.words).toContainEqual({ word: "on", replacement: "ont", count: 2 });
  });

  it("exclut les textes plus anciens que la période", async () => {
    const journal = await ouvrirJournal(":memory:");
    await journal.record(sample(), NOW - 8 * DAY);
    expect(await journal.period(7, NOW)).toEqual({ texts: 0, words: 0, faults: 0, score: null });
    expect((await journal.period(30, NOW)).texts).toBe(1);
  });

  it("purge tout le journal", async () => {
    const journal = await ouvrirJournal(":memory:");
    await journal.record(sample(), NOW);
    await journal.purge();
    expect((await journal.period(7, NOW)).texts).toBe(0);
    expect((await journal.summary(7, NOW)).rules).toEqual([]);
  });
});

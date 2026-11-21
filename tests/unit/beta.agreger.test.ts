// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { agreger, lireDossier, versCsv, versMarkdown } from "../../scripts/beta/agreger";
import { LIMITES_EXPORT, validerTexteExport } from "../../src/analysis/progression/export";

const FIXTURES = join(import.meta.dirname, "../fixtures/beta");
/** Ce que contiennent les fichiers altérés : rien de cela ne doit ressortir. */
const CONTENUS_REFUSES = [
  "médecin",
  "Bonjour",
  "C:\\Users",
  "alice",
  "a / à",
  "2026-01-05",
  "pas du JSON",
];

describe("scripts/beta/agreger.ts — collecte des exports (#34)", () => {
  const agregat = agreger(lireDossier(FIXTURES));

  it("les exports d'exemple sont valides, les fichiers altérés non", () => {
    for (const nom of readdirSync(FIXTURES)) {
      const { texte } = lireDossier(FIXTURES).find((f) => f.nom === nom)!;
      expect(validerTexteExport(texte!).ok).toBe(nom.startsWith("grammaria-beta-"));
    }
  });

  it("refuse en les nommant les fichiers hors format, sans afficher leur contenu", () => {
    expect(agregat.refuses.map((r) => r.fichier)).toEqual([
      "altere-champ-libre.json",
      "altere-chemin.json",
      "altere-date.json",
      "altere-libelle.json",
      "pas-un-export.json",
    ]);
    const sortie = [
      versMarkdown(agregat),
      versCsv(agregat),
      ...agregat.refuses.map((r) => r.raison),
    ].join("\n");
    for (const contenu of CONTENUS_REFUSES) expect(sortie).not.toContain(contenu);
  });

  it("garde l'export le plus récent de chaque participant (le plus de semaines)", () => {
    expect(agregat.participants.map((p) => p.participant)).toEqual([
      "3f9a0c2e",
      "a17c4e9b",
      "c0ffee12",
    ]);
    expect(agregat.ecartes).toEqual(["grammaria-beta-3f9a0c2e-semaine3.json"]);
    expect(agregat.participants[0]).toMatchObject({
      fichier: "grammaria-beta-3f9a0c2e.json",
      semaines: 6,
    });
  });

  it("global : somme des fautes sur somme des mots, participants en baisse, médiane", () => {
    const { global } = agregat;
    expect(global.suivies.participants).toBe(3);
    expect(global.mesures).toBe(3);
    const evolutions = agregat.participants.map((p) => p.suivies.evolution!).sort((a, b) => a - b);
    expect(global.medianeEvolution).toBe(evolutions[1]);
    expect(global.enBaisse).toBe(evolutions.filter((e) => e < 0).length);
    expect(agregat.seuilsDifferents).toBe(false);
  });

  it("synthèse en français clair, avec les mises en garde ; CSV pour un tableur", () => {
    const md = versMarkdown(agregat);
    expect(md).toContain("# Bêta de Grammaria : synthèse des résultats");
    expect(md).toContain("pour 1 000 mots avant la première astuce");
    expect(md).toContain("Pour comparer, les fautes de frappe");
    expect(md).toContain("Ce n'est pas une preuve");
    expect(md).toContain("personne n'a été tiré au sort");
    expect(md).toContain("Aucun texte n'a été collecté");
    const csv = versCsv(agregat).trim().split("\n");
    expect(csv[0].split(";")[0]).toBe("participant");
    expect(csv).toHaveLength(1 + 3 + 1);
    expect(csv.at(-1)!.startsWith("ensemble;")).toBe(true);
  });

  it("dossier vide ou fichier trop gros : rien à mesurer, refus nommé", () => {
    const dossier = mkdtempSync(join(tmpdir(), "grammaria-beta-"));
    try {
      writeFileSync(join(dossier, "enorme.json"), " ".repeat(LIMITES_EXPORT.octets + 10));
      writeFileSync(join(dossier, "notes.txt"), "ignoré : pas un .json");
      const a = agreger(lireDossier(dossier));
      expect(a.refuses).toEqual([{ fichier: "enorme.json", raison: "fichier trop gros" }]);
      expect(a.participants).toEqual([]);
      expect(versMarkdown(a)).toContain(
        "Pas encore assez de textes pour mesurer quoi que ce soit.",
      );
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

// @vitest-environment node
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { autreLangue, listerRessourcesLt } from "../../scripts/desktop/pack-lt.ts";
import {
  ArchiveInvalide,
  crc32,
  ecrireArchive,
  lireArchive,
} from "../../src/desktop/archive-lt.ts";

const texte = (s: string) => new TextEncoder().encode(s);

describe("archive des ressources LanguageTool", () => {
  const fichiers = [
    { nom: "org/languagetool/rules/fr/grammar.xml", octets: texte("<rules/>") },
    { nom: "vide.txt", octets: new Uint8Array(0) },
    { nom: ".dup/1/logback.xml", octets: texte("é") },
  ];

  it("relit à l'identique ce qu'elle a écrit, sans copie", () => {
    const archive = ecrireArchive(fichiers);
    const lus = lireArchive(archive);
    expect([...lus.keys()]).toEqual(fichiers.map((f) => f.nom));
    for (const f of fichiers) expect(lus.get(f.nom)).toEqual(f.octets);
    expect(lus.get(fichiers[0].nom)!.buffer).toBe(archive.buffer);
  });

  it("calcule le CRC-32 standard", () => {
    expect(crc32(texte("123456789"))).toBe(0xcbf43926);
  });

  it.each([
    ["trop court", new Uint8Array(4), /trop court/],
    ["autre format", texte("<!doctype html><html>introuvable</html>"), /signature absente/],
  ])("refuse un fichier %s avec un message lisible", (_cas, octets, message) => {
    expect(() => lireArchive(octets)).toThrow(ArchiveInvalide);
    expect(() => lireArchive(octets)).toThrow(message);
  });

  it("refuse une archive tronquée", () => {
    const archive = ecrireArchive(fichiers);
    expect(() => lireArchive(archive.subarray(0, archive.length - 1))).toThrow(/tronqué/);
    expect(() => lireArchive(archive.subarray(0, 20))).toThrow(/en-tête tronqué/);
  });

  it("refuse une archive abîmée", () => {
    const archive = ecrireArchive(fichiers);
    archive[archive.length - 1] ^= 0xff;
    expect(() => lireArchive(archive)).toThrow(/somme de contrôle/);
  });

  it("refuse un en-tête illisible, d'une autre version ou un index incohérent", () => {
    const fabriquer = (entete: string, donnees = new Uint8Array(0)) => {
      const json = texte(entete);
      const a = new Uint8Array(12 + json.length + donnees.length);
      a.set(texte("LTPACK01"));
      new DataView(a.buffer).setUint32(8, json.length, true);
      a.set(json, 12);
      a.set(donnees, 12 + json.length);
      return a;
    };
    expect(() => lireArchive(fabriquer("{"))).toThrow(/en-tête illisible/);
    expect(() => lireArchive(fabriquer('{"version":2}'))).toThrow(/version 2/);
    const crc = crc32(new Uint8Array(2));
    expect(() =>
      lireArchive(
        fabriquer(
          JSON.stringify({ version: 1, taille: 2, crc32: crc, fichiers: [["a", 1, 5]] }),
          new Uint8Array(2),
        ),
      ),
    ).toThrow(/entrée d'index incorrecte/);
  });
});

describe("contenu de fr.pack", () => {
  const require = createRequire(import.meta.url);
  const racine = (paquet: string) =>
    join(dirname(require.resolve(`${paquet}/package.json`)), "resources");
  const parcourir = (dossier: string, base = ""): string[] =>
    readdirSync(dossier, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? parcourir(join(dossier, e.name), `${base}${e.name}/`)
        : [`${base}${e.name}`],
    );
  const { gardees, exclues } = listerRessourcesLt();
  const noms = new Set(gardees.map((r) => r.nom));

  it("contient tout le paquet français", () => {
    for (const nom of parcourir(racine("@valueerror/ltjs-lang-fr"))) expect(noms).toContain(nom);
  });

  it("contient tout le cœur sauf les autres langues, et rien d'autre", () => {
    const coeur = parcourir(racine("@valueerror/ltjs-core"));
    for (const nom of coeur.filter((n) => !autreLangue(n))) expect(noms).toContain(nom);
    expect(gardees.length + exclues.length).toBe(
      coeur.length + parcourir(racine("@valueerror/ltjs-lang-fr")).length,
    );
    expect([...noms].some((n) => n.endsWith(".wasm"))).toBe(false);
  });

  it("range les copies d'un même nom dans l'ordre de ltjs (copie 0, puis .dup/1…)", () => {
    const chemin = (nom: string) => gardees.find((r) => r.nom === nom)!.chemin;
    expect(chemin("logback.xml")).toBe(join(racine("@valueerror/ltjs-core"), "logback.xml"));
    expect(chemin(".dup/1/logback.xml")).toBe(
      join(racine("@valueerror/ltjs-core"), ".dup", "1", "logback.xml"),
    );
  });

  it("garde les messages et les ressources générales, écarte celles des autres langues", () => {
    for (const nom of [
      "org/languagetool/MessagesBundle.properties",
      "org/languagetool/MessagesBundle_en.properties",
      "org/languagetool/MessagesBundle_fr.properties",
      "org/languagetool/resource/fr/common_words.txt",
      "org/languagetool/resource/segment.srx",
      "org/languagetool/resource/org/languagetool/tokenizers/segment-simple.srx",
      "org/languagetool/rules/false-friends.xml",
      "logback.xml",
      ".dup/1/logback.xml",
    ]) {
      expect(noms).toContain(nom);
    }
    for (const nom of [
      "org/languagetool/MessagesBundle_de.properties",
      "org/languagetool/MessagesBundle_pt_BR.properties",
      "org/languagetool/resource/de/common_words.txt",
      "org/languagetool/resource/eo/eo.profile",
      "org/languagetool/resource/zh/common_words.txt",
    ]) {
      expect(autreLangue(nom)).toBe(true);
      expect(noms).not.toContain(nom);
    }
  });
});

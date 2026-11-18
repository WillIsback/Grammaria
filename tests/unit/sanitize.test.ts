import { describe, expect, it } from "vite-plus/test";
import { MAX_CONTENT_LENGTH, prepareInput, sanitizeInput } from "../../src/utils/sanitize";

describe("sanitizeInput", () => {
  it("texte vide → throw", () => {
    expect(() => sanitizeInput("   ")).toThrow("Le texte ne peut pas être vide");
  });

  it("retire les caractères de contrôle", () => {
    expect(sanitizeInput("bonjour\x00monde")).toBe("bonjourmonde");
    expect(sanitizeInput("a\x07b\x1Bc\x7Fd\x85e\x9Ff")).toBe("abcdef");
  });

  it("conserve les newlines et tabs", () => {
    expect(sanitizeInput("ligne1\nligne2\ttab\r\nfin")).toBe("ligne1\nligne2\ttab\r\nfin");
  });

  it("tronque à 10000 caractères", () => {
    const long = "a".repeat(15000);
    expect(sanitizeInput(long).length).toBe(10000);
  });

  it("trim le whitespace superflu", () => {
    expect(sanitizeInput("  bonjour  ")).toBe("bonjour");
  });

  // Régression QA : l'ancien filtre /[^\x09\x0A\x0D\x20-\xFF]/ supprimait tout
  // caractère au-delà de U+00FF. « 10 € » devenait « 10 », « cœur » « cur »,
  // et un nom propre amputé était ensuite compté comme faute de frappe.
  it.each([
    ["apostrophe typographique", "l’équipe c’est"],
    ["ligatures", "le cœur de l’Œuvre"],
    ["euro", "Cela a coûté 10 €."],
    ["points de suspension et tirets", "Bref… c’est tout — ou presque – voilà."],
    ["guillemets et espaces insécables", "« Bonjour » ; il dit : « oui » !"],
    ["lettres hors Latin-1", "Grzegorz Brzęczyszczykiewicz, Łódź, Ÿ"],
    ["emojis", "Merci 😊👍"],
  ])("conserve : %s", (_label, text) => {
    expect(sanitizeInput(text)).toBe(text);
  });
});

describe("prepareInput", () => {
  it("signale un texte non tronqué", () => {
    expect(prepareInput("  Bonjour à tous.  ")).toEqual({
      text: "Bonjour à tous.",
      truncated: false,
      originalLength: 15,
    });
  });

  it("exactement à la limite : pas de coupe", () => {
    const text = "a".repeat(MAX_CONTENT_LENGTH);
    expect(prepareInput(text).truncated).toBe(false);
  });

  it("coupe sur une frontière de mot et le signale", () => {
    const text = "mot ".repeat(3000); // 12 000 caractères
    const res = prepareInput(text);
    expect(res.truncated).toBe(true);
    expect(res.originalLength).toBe(text.trim().length);
    expect(res.text.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    expect(res.text.endsWith("mot")).toBe(true);
    expect(res.text.split(" ").every((w) => w === "mot")).toBe(true);
  });

  it("ne coupe pas au milieu d'un mot qui chevauche la limite", () => {
    const text = `${"x".repeat(MAX_CONTENT_LENGTH - 3)} soleil levant`;
    const res = prepareInput(text);
    expect(res.text).toBe("x".repeat(MAX_CONTENT_LENGTH - 3));
  });

  it("texte sans espace : coupe au caractère près", () => {
    const res = prepareInput("b".repeat(MAX_CONTENT_LENGTH + 50));
    expect(res.text.length).toBe(MAX_CONTENT_LENGTH);
    expect(res.truncated).toBe(true);
  });
});

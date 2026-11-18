import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Régression QA (2026-11-18), même convention que server.topK.test.ts :
// server.ts tourne sous Bun et ne s'importe pas sous vitest, on vérifie donc
// au niveau du source que les relais et la correction passent par les
// helpers testés dans tests/unit/upstream.test.ts.
//  - Les relais /v1/* et /api/lt/* transmettaient l'en-tête Host du client.
//  - Sans LLM_MODEL_NAME, le modèle « auto » de l'interface partait tel quel.

const serverSource = readFileSync(join(import.meta.dirname, "../../server.ts"), "utf-8");

describe("server.ts — relais amont", () => {
  it("aucun fetch amont ne réutilise les en-têtes bruts de la requête", () => {
    expect(serverSource).not.toMatch(/headers:\s*req\.headers/);
    expect(serverSource).not.toMatch(/new Headers\(req\.headers\)/);
  });

  it("le relais LanguageTool passe par upstreamHeaders", () => {
    const block = serverSource.slice(serverSource.indexOf("const ltResponse = await fetch("));
    expect(block.slice(0, 200)).toMatch(/headers:\s*upstreamHeaders\(req\.headers\)/);
  });

  it("les réponses relayées passent par downstreamHeaders (corps déjà décompressé)", () => {
    expect(serverSource).not.toMatch(/new Headers\((lt|llm)Response\.headers\)/);
    expect(serverSource.match(/downstreamHeaders\((lt|llm)Response\.headers\)/g)).toHaveLength(2);
  });

  it("le relais LLM passe par upstreamHeaders avec la clé configurée", () => {
    expect(serverSource).toMatch(/upstreamHeaders\(req\.headers,\s*config\.llmApiKey\)/);
  });
});

describe("server.ts — choix du modèle", () => {
  it("résout le modèle via resolveModel (config, interface, détection)", () => {
    expect(serverSource).toMatch(
      /const resolvedModel = await resolveModel\(config\.llmModelName,\s*llmBody\.model,\s*detectModel\)/,
    );
    expect(serverSource).not.toMatch(/llmBody\.model \|\| "unknown"/);
  });

  it("le détecteur interroge le serveur LLM configuré", () => {
    expect(serverSource).toMatch(/createModelDetector\(config\.llmTarget,\s*config\.llmApiKey\)/);
  });
});

describe("server.ts — bilan du journal", () => {
  // Régression QA : days=0 donnait 7 jours au lieu de 1.
  it("lit la période via parsePeriodDays", () => {
    expect(serverSource).toMatch(/parsePeriodDays\(url\.searchParams\.get\("days"\)\)/);
  });
});

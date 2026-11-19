import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Régression QA (2026-11-18), même convention que server.topK.test.ts :
// server.ts tourne sous Bun et ne s'importe pas sous vitest, on vérifie donc
// au niveau du source que les relais et la correction passent par les
// helpers testés dans tests/unit/upstream.test.ts.
//  - Les relais /v1/* transmettaient l'en-tête Host du client.
//  - Sans LLM_MODEL_NAME, le modèle « auto » de l'interface partait tel quel.

const serverSource = readFileSync(join(import.meta.dirname, "../../server.ts"), "utf-8");

describe("server.ts — relais amont", () => {
  it("aucun fetch amont ne réutilise les en-têtes bruts de la requête", () => {
    expect(serverSource).not.toMatch(/headers:\s*req\.headers/);
    expect(serverSource).not.toMatch(/new Headers\(req\.headers\)/);
  });

  it("les réponses relayées passent par downstreamHeaders (corps déjà décompressé)", () => {
    expect(serverSource).not.toMatch(/new Headers\(llmResponse\.headers\)/);
    expect(serverSource).toMatch(/downstreamHeaders\(llmResponse\.headers\)/);
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

// Le correcteur grammatical est intégré : plus de relais vers un serveur
// LanguageTool externe.
describe("server.ts — correcteur grammatical intégré", () => {
  it("n'a plus de relais /api/lt ni de cible LT_TARGET", () => {
    expect(serverSource).not.toMatch(/\/api\/lt/);
    expect(serverSource).not.toMatch(/ltTarget/);
  });

  it("/api/check analyse le texte dans le processus via GrammarChecker", () => {
    expect(serverSource).toMatch(/path === "\/api\/check"/);
    expect(serverSource).toMatch(/await grammar\.check\(text\)/);
    expect(serverSource).toMatch(/text\.length > MAX_ANALYZE_LENGTH/);
  });
});

// Application de bureau : serveur local, réglages modifiables depuis l'interface.
describe("server.ts — mode bureau", () => {
  it("écoute sur l'interface configurée (127.0.0.1 pour le bureau)", () => {
    expect(serverSource).toMatch(/hostname:\s*config\.host/);
  });

  it("filtre chaque requête (Host et origine) avant tout traitement", () => {
    const fetchStart = serverSource.indexOf("async fetch(req");
    const guard = serverSource.indexOf("rejectForeignRequest(req, url)", fetchStart);
    const firstRoute = serverSource.indexOf('if (path === "/api/', fetchStart);
    expect(guard).toBeGreaterThan(fetchStart);
    expect(guard).toBeLessThan(firstRoute);
  });

  it("ne modifie les réglages que s'ils sont éditables, puis reconnecte le LLM", () => {
    const block = serverSource.slice(serverSource.indexOf('if (path === "/api/settings")'));
    expect(block.slice(0, 1200)).toMatch(/if \(!settings\.editable\)/);
    expect(block.slice(0, 1200)).toMatch(
      /settings\.update\(await req\.json\(\)\);\s*connectLlm\(\);/,
    );
  });

  it("les réglages ne sont éditables qu'en mode bureau", () => {
    expect(serverSource).toMatch(
      /new SettingsStore\(\s*config\.desktop && config\.settingsPath \? config\.settingsPath : null,?\s*\)/,
    );
  });
});

// Issue #10 : correction ~7 fois plus lente qu'ai_corrector (raisonnement du modèle).
describe("server.ts — raisonnement du modèle", () => {
  it("coupe le raisonnement par défaut, sauf si l'API a refusé le paramètre", () => {
    expect(serverSource).toMatch(
      /let disableThinking = config\.llmDisableThinking && !thinkingParamRejected;/,
    );
  });

  it("relance sans chat_template_kwargs quand l'API le refuse", () => {
    expect(serverSource).toMatch(/!disableThinking \|\| !isThinkingParamRejection\(err\)/);
    expect(serverSource).toMatch(/thinkingParamRejected = true;\s*disableThinking = false;/);
  });

  it("journalise le délai avant le premier mot et les fragments de raisonnement", () => {
    expect(serverSource).toMatch(/premier mot après/);
    expect(serverSource).toMatch(/reasoning_content/);
  });
});

describe("src-tauri — raisonnement coupé par défaut sur le bureau", () => {
  const libSource = readFileSync(join(import.meta.dirname, "../../src-tauri/src/lib.rs"), "utf-8");
  it("ne force plus LLM_DISABLE_THINKING=false", () => {
    expect(libSource).not.toMatch(/"LLM_DISABLE_THINKING"/);
  });
});

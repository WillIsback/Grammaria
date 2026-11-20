import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { allServerSources, handlerSource, serverSource } from "./serverSource.ts";

// Régression QA (2026-11-18), même convention que server.topK.test.ts :
// server.ts tourne sous Bun et ne s'importe pas sous vitest, on vérifie donc
// au niveau du source que les relais et la correction passent par les
// helpers testés dans tests/unit/upstream.test.ts.
// v0.3.0 : les routes sont dans api/handler.ts (dépendances injectées) ; le
// client OpenAI, le relais HTTP et les réglages restent dans server.ts.
//  - Les relais /v1/* transmettaient l'en-tête Host du client.
//  - Sans LLM_MODEL_NAME, le modèle « auto » de l'interface partait tel quel.

describe("server.ts — relais amont", () => {
  it("aucun fetch amont ne réutilise les en-têtes bruts de la requête", () => {
    expect(allServerSources).not.toMatch(/headers:\s*req\.headers/);
    expect(allServerSources).not.toMatch(/new Headers\(req\.headers\)/);
  });

  it("les réponses relayées passent par downstreamHeaders (corps déjà décompressé)", () => {
    expect(allServerSources).not.toMatch(/new Headers\(llmResponse\.headers\)/);
    // Le relais du serveur, puis le gestionnaire qui y ajoute l'en-tête CORS.
    expect(serverSource).toMatch(/downstreamHeaders\(llmResponse\.headers\)/);
    expect(handlerSource).toMatch(/downstreamHeaders\(llmResponse\.headers\)/);
    expect(handlerSource).toMatch(/llmResponse = await modele\.relayer\(req\)/);
  });

  it("le relais LLM passe par upstreamHeaders avec la clé configurée", () => {
    expect(serverSource).toMatch(/upstreamHeaders\(req\.headers,\s*config\.llmApiKey\)/);
  });
});

describe("server.ts — choix du modèle", () => {
  // Le modèle configuré vient des réglages (vue publique), relus à chaque requête.
  it("résout le modèle via resolveModel (config, interface, détection)", () => {
    expect(handlerSource).toMatch(/const vue = await reglages\.vuePublique\(\);/);
    expect(handlerSource).toMatch(
      /const resolvedModel = await resolveModel\(vue\.llmModelName,\s*llmBody\.model,\s*detectModel\)/,
    );
    expect(allServerSources).not.toMatch(/llmBody\.model \|\| "unknown"/);
  });

  it("le détecteur interroge le serveur LLM configuré", () => {
    expect(handlerSource).toMatch(
      /const detectModel = creerDetecteurModele\(\(\) => modele\.listerModeles\(\)\)/,
    );
    expect(serverSource).toMatch(
      /listerModeles: \(\) => listerModelesAmont\(config\.llmTarget,\s*config\.llmApiKey\)/,
    );
  });
});

describe("server.ts — bilan du journal", () => {
  // Régression QA : days=0 donnait 7 jours au lieu de 1.
  it("lit la période via parsePeriodDays", () => {
    expect(handlerSource).toMatch(/parsePeriodDays\(url\.searchParams\.get\("days"\)\)/);
  });
});

// Le correcteur grammatical est intégré : plus de relais vers un serveur
// LanguageTool externe.
describe("server.ts — correcteur grammatical intégré", () => {
  it("n'a plus de relais /api/lt ni de cible LT_TARGET", () => {
    expect(allServerSources).not.toMatch(/\/api\/lt/);
    expect(allServerSources).not.toMatch(/ltTarget/);
  });

  it("/api/check analyse le texte dans le processus via GrammarChecker", () => {
    expect(handlerSource).toMatch(/path === "\/api\/check"/);
    expect(handlerSource).toMatch(/await correcteur\.check\(text\)/);
    expect(handlerSource).toMatch(/text\.length > MAX_ANALYZE_LENGTH/);
    // Sur le serveur, le correcteur injecté est le GrammarChecker du processus.
    expect(serverSource).toMatch(/const grammar = new GrammarChecker\(\);/);
    expect(serverSource).toMatch(/correcteur: grammar,/);
  });
});

// Mode bureau du serveur (serveur local d'un seul utilisateur) : réglages modifiables depuis l'interface.
describe("server.ts — mode bureau", () => {
  it("écoute sur l'interface configurée (127.0.0.1 en mode bureau)", () => {
    expect(serverSource).toMatch(/hostname:\s*config\.host/);
  });

  // Les routes sont dans api/handler.ts : le filtre précède l'appel du
  // gestionnaire (et les fichiers statiques), et le gestionnaire ne filtre rien.
  it("filtre chaque requête (Host et origine) avant tout traitement", () => {
    const fetchStart = serverSource.indexOf("async fetch(req");
    const guard = serverSource.indexOf("rejectForeignRequest(req, url)", fetchStart);
    const firstRoute = serverSource.indexOf("await gestionnaireApi(req)", fetchStart);
    const statics = serverSource.indexOf("// === Static Files", fetchStart);
    expect(guard).toBeGreaterThan(fetchStart);
    expect(firstRoute).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstRoute);
    expect(guard).toBeLessThan(statics);
    expect(serverSource).not.toMatch(/if \(path === "\/api\//);
  });

  it("ne modifie les réglages que s'ils sont éditables, puis reconnecte le LLM", () => {
    const block = handlerSource.slice(handlerSource.indexOf('if (path === "/api/settings")'));
    expect(block.slice(0, 1200)).toMatch(
      /const vue = await reglages\.vuePublique\(\);\s*if \(!vue\.editable\)/,
    );
    expect(block.slice(0, 1200)).toMatch(
      /await reglages\.mettreAJour\(parseUpdate\(await req\.json\(\)\)\);\s*oublierModele\(\);/,
    );
    // Le serveur enregistre puis reconnecte le client OpenAI.
    expect(serverSource).toMatch(/settings\.update\(update\);\s*connectLlm\(\);/);
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
    expect(handlerSource).toMatch(
      /let disableThinking = vue\.llmDisableThinking && !thinkingParamRejected;/,
    );
  });

  it("relance sans chat_template_kwargs quand l'API le refuse", () => {
    expect(handlerSource).toMatch(/!disableThinking \|\| !isThinkingParamRejection\(err\)/);
    expect(handlerSource).toMatch(/thinkingParamRejected = true;\s*disableThinking = false;/);
  });

  it("journalise le délai avant le premier mot et les fragments de raisonnement", () => {
    expect(handlerSource).toMatch(/premier mot après/);
    expect(handlerSource).toMatch(/if \(fragment\.reasoning\) reasoningChunks\+\+;/);
    // Le SDK du serveur signale le raisonnement dans reasoning_content ou reasoning.
    expect(serverSource).toMatch(
      /reasoning: choiceDelta\?\.reasoning_content \|\| choiceDelta\?\.reasoning/,
    );
  });
});

describe("src-tauri — raisonnement coupé par défaut sur le bureau", () => {
  const libSource = readFileSync(join(import.meta.dirname, "../../src-tauri/src/lib.rs"), "utf-8");
  it("ne force plus LLM_DISABLE_THINKING=false", () => {
    expect(libSource).not.toMatch(/"LLM_DISABLE_THINKING"/);
  });
});

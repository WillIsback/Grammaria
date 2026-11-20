import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vite-plus/test";

// server.ts tourne sous Bun (Bun.serve) et ne s'importe pas sous vitest : les
// tests server.*.test.ts vérifient donc son texte source.
//
// Depuis la v0.3.0, les routes /api/* et /v1/* sont dans api/handler.ts
// (partagé avec l'application de bureau, dépendances injectées) ; server.ts
// garde Bun.serve, les contrôles du mode bureau et les dépendances réelles
// (client OpenAI, relais HTTP, réglages). Chaque test lit le fichier où vit le
// code qu'il vérifie.

const root = join(import.meta.dirname, "../..");

/** Texte de server.ts (Bun.serve, mode bureau, client OpenAI, relais amont). */
export const serverSource = readFileSync(join(root, "server.ts"), "utf-8");

/** Texte de api/handler.ts (routes, CORS, validations, logique du relais de conversation). */
export const handlerSource = readFileSync(join(root, "api/handler.ts"), "utf-8");

/** Les deux, pour les interdits qui valent partout. */
export const allServerSources = `${serverSource}\n${handlerSource}`;

/** Section du gestionnaire de /v1/chat/completions, jusqu'au relais LLM générique. */
export function chatHandlerSource(): string {
  const start = handlerSource.indexOf('path === "/v1/chat/completions"');
  expect(start, "handler for /v1/chat/completions must exist in api/handler.ts").toBeGreaterThan(
    -1,
  );
  const end = handlerSource.indexOf("// === API: LLM Proxy", start);
  expect(end, "end of /v1/chat/completions handler section must be found").toBeGreaterThan(start);
  return handlerSource.slice(start, end);
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vite-plus/test";

// server.ts tourne sous Bun (Bun.serve) et ne s'importe pas sous vitest : les
// tests server.*.test.ts vérifient donc son texte source.

export const serverSource = readFileSync(join(import.meta.dirname, "../../server.ts"), "utf-8");

/** Section du gestionnaire de /v1/chat/completions, jusqu'au relais LLM générique. */
export function chatHandlerSource(): string {
  const start = serverSource.indexOf('path === "/v1/chat/completions"');
  expect(start, "handler for /v1/chat/completions must exist in server.ts").toBeGreaterThan(-1);
  const end = serverSource.indexOf("// === API: LLM Proxy", start);
  expect(end, "end of /v1/chat/completions handler section must be found").toBeGreaterThan(start);
  return serverSource.slice(start, end);
}

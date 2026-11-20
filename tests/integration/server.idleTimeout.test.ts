import { describe, expect, it } from "vite-plus/test";
import { chatHandlerSource as chatSection, serverSource } from "./serverSource.ts";

// Regression test for issue #17 (Bug 1):
// Bun.serve's default 10s idleTimeout aborted any /v1/chat/completions request
// whose time-to-first-token exceeded 10s (large inputs), and the unguarded SSE
// keepalive enqueue then threw "Controller is already closed", crashing the
// whole Bun process. server.ts runs under Bun and cannot be imported in the
// vitest environment, so we guard the source level.

describe("Bun.serve idle timeout for streaming corrections (issue #17)", () => {
  it("accesses the Bun server so the SSE route can disable its idle timeout", () => {
    expect(serverSource).toMatch(/fetch\s*\(\s*req\s*:\s*Request\s*,\s*server\s*:/);
  });

  // v0.3.0 : le gestionnaire d'API (api/handler.ts) n'a pas accès au serveur
  // Bun ; server.ts coupe le délai d'inactivité de cette route avant de l'appeler.
  it("disables the per-request idle timeout on the streaming route", () => {
    expect(serverSource).toMatch(
      /if \(path === "\/v1\/chat\/completions" && req\.method === "POST"\) server\.timeout\(\s*req\s*,\s*0\s*\);/,
    );
    const timeout = serverSource.indexOf("server.timeout(req, 0)");
    expect(timeout).toBeLessThan(serverSource.indexOf("await gestionnaireApi(req)"));
    // Le flux de conversation est bien celui du gestionnaire appelé ensuite.
    expect(chatSection()).toMatch(/new ReadableStream/);
  });

  it("routes every controller.enqueue through a guarded helper", () => {
    const section = chatSection();
    expect(section).toMatch(/function\s+safeEnqueue/);
    // The helper wraps enqueue in try/catch so a closed controller is handled.
    expect(section).toMatch(/try\s*\{[\s\S]*?controller\.enqueue[\s\S]*?\}\s*catch/);
    // Only one raw enqueue call remains (inside the helper) — the keepalive,
    // text_done, done and error paths must all go through it.
    const rawEnqueues = section.match(/controller\.enqueue/g) ?? [];
    expect(rawEnqueues.length).toBe(1);
  });

  it("keeps the SSE stream alive via the guarded keepalive", () => {
    const section = chatSection();
    expect(section).toMatch(/setInterval\([\s\S]*?safeEnqueue/);
  });

  it("keeps the keepalive interval below Bun's 10s default idle timeout", () => {
    const match = chatSection().match(/keepaliveIntervalMs\s*=\s*([\d_]+)/);
    expect(match, "keepaliveIntervalMs must be defined").not.toBeNull();
    const ms = Number((match as RegExpMatchArray)[1].replace(/_/g, ""));
    expect(ms).toBeLessThan(10_000);
  });
});

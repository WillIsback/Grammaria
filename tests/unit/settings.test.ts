import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { config } from "../../config";
import { normalizeTarget, SettingsStore } from "../../settings";

const initial = { ...config };

describe("SettingsStore — réglages du LLM en mode bureau", () => {
  beforeEach(() => {
    Object.assign(config, initial);
  });

  function store() {
    const dir = mkdtempSync(join(tmpdir(), "grammaria-settings-"));
    const path = join(dir, "settings.json");
    return { path, store: new SettingsStore(path) };
  }

  it("sur un serveur (sans fichier), les réglages ne sont pas modifiables", () => {
    const s = new SettingsStore(null);
    expect(s.editable).toBe(false);
    expect(() => s.update({ llmTarget: "http://evil.example" })).toThrow();
  });

  it("enregistre, applique et ne renvoie jamais la clé API", () => {
    const { path, store: s } = store();
    expect(s.publicView().configured).toBe(false);

    const view = s.update({
      llmTarget: "https://api.example.com/v1/",
      llmApiKey: "sk-secret",
      llmModelName: "mon-modele",
    });

    expect(view).toMatchObject({
      editable: true,
      configured: true,
      llmTarget: "https://api.example.com",
      llmModelName: "mon-modele",
      hasApiKey: true,
    });
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    expect(config.llmTarget).toBe("https://api.example.com");
    expect(config.llmApiKey).toBe("sk-secret");
    expect(JSON.parse(readFileSync(path, "utf-8")).llmApiKey).toBe("sk-secret");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("recharge les réglages enregistrés au démarrage", () => {
    const { path, store: s } = store();
    s.update({ llmTarget: "http://localhost:11434", llmModelName: "llama3" });
    Object.assign(config, initial);

    new SettingsStore(path);
    expect(config.llmTarget).toBe("http://localhost:11434");
    expect(config.llmModelName).toBe("llama3");
  });

  it("une modification partielle garde la clé existante", () => {
    const { store: s } = store();
    s.update({ llmTarget: "http://localhost:11434", llmApiKey: "k" });
    s.update({ llmModelName: "autre" });
    expect(config.llmApiKey).toBe("k");
  });

  it.each([
    [{ llmTarget: "localhost:11434" }],
    [{ llmTarget: "file:///etc/passwd" }],
    [{ llmTarget: 42 }],
    [{ llmDisableThinking: "oui" }],
    [null],
  ])("refuse des réglages invalides : %j", (input) => {
    const { store: s } = store();
    expect(() => s.update(input)).toThrow();
  });
});

describe("normalizeTarget", () => {
  it.each([
    ["http://localhost:11434", "http://localhost:11434"],
    ["http://localhost:11434/", "http://localhost:11434"],
    ["https://api.openai.com/v1", "https://api.openai.com"],
    ["  https://api.mistral.ai/v1/ ".trim(), "https://api.mistral.ai"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeTarget(input)).toBe(expected);
  });
});

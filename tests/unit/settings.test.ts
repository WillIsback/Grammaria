import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { config } from "../../config";
import {
  type LlmSettings,
  parseSettingsFile,
  parseUpdate,
  publicSettingsView,
  settingsFileContent,
} from "../../api/reglages";
import { normalizeTarget, SettingsStore } from "../../settings";

const initial = { ...config };

/** Chemin d'un fichier de réglages dans un dossier temporaire neuf. */
const tempSettingsPath = () =>
  join(mkdtempSync(join(tmpdir(), "grammaria-settings-")), "settings.json");

describe("SettingsStore — réglages du LLM en mode bureau", () => {
  beforeEach(() => {
    Object.assign(config, initial);
  });

  function store() {
    const path = tempSettingsPath();
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

// Issue #10 : l'application de bureau démarrait avec le raisonnement actif et
// recopiait cette valeur dans settings.json sans choix de l'utilisateur.
describe("SettingsStore — migration du raisonnement (v1 → v2)", () => {
  beforeEach(() => {
    Object.assign(config, initial, { llmDisableThinking: true });
  });

  function fileWith(content: object) {
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("ignore llmDisableThinking d'un fichier de version 1", () => {
    const path = fileWith({
      llmTarget: "http://gpu.tailnet:8000",
      llmApiKey: "",
      llmModelName: "",
      llmDisableThinking: false,
    });
    new SettingsStore(path);
    expect(config.llmTarget).toBe("http://gpu.tailnet:8000");
    expect(config.llmDisableThinking).toBe(true);
  });

  it("garde le choix explicite d'un fichier de version 2", () => {
    const path = fileWith({
      settingsVersion: 2,
      llmTarget: "http://gpu:8000",
      llmDisableThinking: false,
    });
    new SettingsStore(path);
    expect(config.llmDisableThinking).toBe(false);
  });

  it("écrit la version 2 à l'enregistrement", () => {
    const path = fileWith({ llmTarget: "http://gpu:8000" });
    new SettingsStore(path).update({ llmDisableThinking: false });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
      settingsVersion: 2,
      llmDisableThinking: false,
    });
  });
});

// v0.3.0 : la validation est pure (api/reglages.ts), sans fichier ni Node,
// pour servir aussi au gestionnaire d'API dans la WebView du bureau.
describe("api/reglages — validation pure", () => {
  const reglages: LlmSettings = {
    llmTarget: "http://gpu:8000",
    llmApiKey: "sk-secret",
    llmModelName: "m",
    llmDisableThinking: true,
  };

  it("parseUpdate normalise et ne garde que les champs connus", () => {
    expect(
      parseUpdate({ llmTarget: " https://api.example.com/v1/ ", llmModelName: " m ", autre: 1 }),
    ).toEqual({ llmTarget: "https://api.example.com", llmModelName: "m" });
    expect(parseUpdate({})).toEqual({});
  });

  it.each([[null], ["texte"], [{ llmApiKey: 1 }], [{ llmModelName: "x".repeat(2_001) }]])(
    "parseUpdate refuse %j",
    (input) => {
      expect(() => parseUpdate(input)).toThrow();
    },
  );

  it("parseSettingsFile : migration v1 → v2 sans modifier l'objet lu", () => {
    const v1 = { llmTarget: "http://gpu:8000", llmDisableThinking: false };
    expect(parseSettingsFile(v1)).toEqual({ llmTarget: "http://gpu:8000" });
    expect(v1).toEqual({ llmTarget: "http://gpu:8000", llmDisableThinking: false });
    expect(parseSettingsFile({ settingsVersion: 2, llmDisableThinking: false })).toEqual({
      llmDisableThinking: false,
    });
    expect(() => parseSettingsFile(null)).toThrow();
  });

  it("settingsFileContent ajoute la version", () => {
    expect(settingsFileContent(reglages)).toEqual({ settingsVersion: 2, ...reglages });
  });

  it("publicSettingsView ne renvoie jamais la clé", () => {
    const vue = publicSettingsView(reglages, { editable: true, configured: true });
    expect(vue).toEqual({
      editable: true,
      configured: true,
      llmTarget: "http://gpu:8000",
      llmModelName: "m",
      llmDisableThinking: true,
      hasApiKey: true,
    });
    expect(JSON.stringify(vue)).not.toContain("sk-secret");
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { LlmSettings } from "../../src/components/LlmSettings";
import type { ServerSettings } from "../../src/services/settings";

const base: ServerSettings = {
  editable: true,
  configured: false,
  llmTarget: "",
  llmModelName: "",
  llmDisableThinking: false,
  hasApiKey: false,
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
}

describe("LlmSettings — serveur du modèle (application de bureau)", () => {
  it("invite à configurer le modèle au premier lancement", () => {
    render(<LlmSettings settings={base} onSaved={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("pour commencer");
  });

  it("enregistre l'adresse et la clé, puis vide le champ de la clé", async () => {
    const saved = {
      ...base,
      configured: true,
      llmTarget: "http://localhost:11434",
      hasApiKey: true,
    };
    const fetchMock = vi.fn(() => jsonResponse(saved));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onSaved = vi.fn();
    render(<LlmSettings settings={base} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Adresse"), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.change(screen.getByLabelText(/Clé API/), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      llmTarget: "http://localhost:11434/v1",
      llmApiKey: "sk-test",
    });
    expect((screen.getByLabelText(/Clé API/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Adresse") as HTMLInputElement).value).toBe(
      "http://localhost:11434",
    );
  });

  it("une clé laissée vide n'efface pas la clé enregistrée", async () => {
    const settings = {
      ...base,
      configured: true,
      llmTarget: "https://api.example.com",
      hasApiKey: true,
    };
    const fetchMock = vi.fn(() => jsonResponse(settings));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<LlmSettings settings={settings} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ llmTarget: "https://api.example.com" });
  });

  it("affiche l'erreur renvoyée par le serveur", async () => {
    globalThis.fetch = vi.fn(() =>
      jsonResponse({ error: "L'adresse du modèle doit commencer par http:// ou https://." }, false),
    ) as unknown as typeof fetch;
    render(<LlmSettings settings={{ ...base, llmTarget: "ftp://x" }} onSaved={vi.fn()} />);
    fireEvent.submit(screen.getByRole("form", { name: "Serveur du modèle" }));
    await waitFor(() => expect(screen.getByText(/doit commencer par http/)).toBeTruthy());
  });
});

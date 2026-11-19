import { type FormEvent, useState } from "react";
import { saveServerSettings, type ServerSettings } from "../services/settings";

interface Props {
  settings: ServerSettings;
  onSaved: (settings: ServerSettings) => void;
}

const sectionTitle =
  "text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3";
const input =
  "w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-gray-800/80 border border-gray-200/80 dark:border-gray-700/80 " +
  "text-gray-900 dark:text-white placeholder-gray-300 dark:placeholder-gray-600 " +
  "focus:outline-none focus:ring-4 focus:ring-brand-500/10 focus:border-brand-400";

/**
 * Adresse du serveur LLM et clé API, dans l'application de bureau : sans
 * terminal, c'est ici que l'utilisateur choisit son modèle (Ollama en local,
 * ou une API compatible OpenAI).
 */
export function LlmSettings({ settings, onSaved }: Props) {
  const [target, setTarget] = useState(settings.llmTarget);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveServerSettings({
        llmTarget: target,
        ...(apiKey ? { llmApiKey: apiKey } : {}),
      });
      setApiKey("");
      setTarget(saved.llmTarget);
      setStatus({ ok: true, text: "Réglages enregistrés." });
      onSaved(saved);
    } catch (error) {
      setStatus({
        ok: false,
        text: error instanceof Error ? error.message : "Enregistrement impossible.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveKey = async () => {
    try {
      const saved = await saveServerSettings({ llmApiKey: "" });
      setStatus({ ok: true, text: "Clé API supprimée." });
      onSaved(saved);
    } catch (error) {
      setStatus({
        ok: false,
        text: error instanceof Error ? error.message : "Suppression impossible.",
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-6" aria-label="Serveur du modèle">
      <h2 className={sectionTitle}>Serveur du modèle</h2>

      {!settings.configured && (
        <p
          className="mb-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
          role="status"
        >
          Indiquez l&rsquo;adresse de votre modèle de langage pour commencer à corriger.
        </p>
      )}

      <label htmlFor="llm-target" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
        Adresse
      </label>
      <input
        id="llm-target"
        type="url"
        required
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="http://localhost:11434"
        className={input}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="mt-1 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
        Ollama : http://localhost:11434 · API compatible OpenAI : son adresse, par exemple
        https://api.mistral.ai
      </p>

      <label
        htmlFor="llm-api-key"
        className="block text-xs text-gray-500 dark:text-gray-400 mt-3 mb-1"
      >
        Clé API {settings.hasApiKey ? "(enregistrée)" : "(facultative)"}
      </label>
      <input
        id="llm-api-key"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={settings.hasApiKey ? "Laisser vide pour la conserver" : "Aucune pour Ollama"}
        className={input}
        autoComplete="off"
      />
      {settings.hasApiKey && (
        <button
          type="button"
          onClick={handleRemoveKey}
          className="mt-1 text-[11px] text-gray-400 hover:text-red-500 transition-colors"
        >
          Supprimer la clé enregistrée
        </button>
      )}

      <button
        type="submit"
        disabled={saving}
        className="mt-3 w-full px-3 py-2 rounded-xl text-sm font-semibold bg-brand-600 hover:bg-brand-700
          text-white disabled:opacity-60 transition-colors"
      >
        {saving ? "Enregistrement…" : "Enregistrer"}
      </button>
      {status && (
        <p
          className={`mt-2 text-xs ${status.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
          role="status"
        >
          {status.text}
        </p>
      )}
    </form>
  );
}

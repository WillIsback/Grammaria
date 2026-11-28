import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzedCorrection } from "../analysis/analyze";
import type { QuestionRevision } from "../analysis/regles/revision";
import { type AnalysisResponse, analyzeCorrection, fetchRevision } from "../services/journal";
import { runLanguageTool } from "../services/languagetool";
import type { CorrectionEntry, CorrectionSettings, CorrectionStats, LTMatch } from "../types";
import { ErreurCorrection, MESSAGE_ECHEC_CORRECTION } from "../utils/erreursModele";
import { correctText } from "../utils/llm";
import { MAX_CONTENT_LENGTH, prepareInput } from "../utils/sanitize";

const SETTINGS_KEY = "grammaria:settings";

const DEFAULT_SETTINGS: CorrectionSettings = {
  mode: "formel",
  fixGrammar: true,
  fixSpelling: true,
  fixSyntax: true,
  fixStyle: true,
  revisionQuestion: true,
};

/**
 * Ne reprend des réglages enregistrés que les clés connues et bien typées :
 * une ancienne sauvegarde (par exemple l'ex-réglage « engine ») est ignorée.
 */
function restoreSettings(saved: unknown): Partial<CorrectionSettings> {
  if (!saved || typeof saved !== "object") return {};
  const restored: Partial<CorrectionSettings> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS) as [
    keyof CorrectionSettings,
    CorrectionSettings[keyof CorrectionSettings],
  ][]) {
    const value = (saved as Record<string, unknown>)[key];
    if (typeof value === typeof fallback) Object.assign(restored, { [key]: value });
  }
  return restored;
}

/** Libellé de règle affiché pour une modification analysée. */
function describeCorrection(c: AnalyzedCorrection): CorrectionEntry {
  const fault = c.faults[0];
  let regle = "Non classé";
  if (c.fiche) regle = c.fiche.titre;
  else if (fault) regle = fault.message || fault.categoryName || fault.ruleKey;
  return { avant: c.avant, apres: c.apres, regle, astuce: c.fiche?.astuce };
}

export function useCorrector() {
  const [textContent, setTextContent] = useState("");
  const [outputText, setOutputText] = useState("");
  const [corrections, setCorrections] = useState<CorrectionEntry[]>([]);
  const [isLoadingText, setIsLoadingText] = useState(false);
  const [isLoadingCorrections, setIsLoadingCorrections] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);
  /** Question de révision posée pendant l'attente de la correction en cours. */
  const [revision, setRevision] = useState<QuestionRevision | null>(null);
  const revisionPoseeRef = useRef(false);
  const [settings, setSettings] = useState<CorrectionSettings>(DEFAULT_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  /** Détail technique de l'erreur, affiché replié sous « Détails ». */
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [stats, setStats] = useState<CorrectionStats>({
    processingTime: 0,
    modificationCount: 0,
  });

  const isRunningRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Charger les settings sauvegardés
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem(SETTINGS_KEY);
      if (savedSettings) {
        const restored = restoreSettings(JSON.parse(savedSettings));
        setSettings((prev) => ({ ...prev, ...restored }));
      }
    } catch {
      /* use defaults */
    }
  }, []);

  const localStorageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup à l'unmount (la sauvegarde différée est annulée par son propre effet)
  useEffect(() => () => abortControllerRef.current?.abort(), []);

  // Debounce de la sauvegarde des settings (500ms)
  useEffect(() => {
    if (localStorageTimeoutRef.current) clearTimeout(localStorageTimeoutRef.current);
    localStorageTimeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* ignore */
      }
    }, 500);
    return () => {
      if (localStorageTimeoutRef.current) clearTimeout(localStorageTimeoutRef.current);
    };
  }, [settings]);

  /** Efface le résultat de la correction précédente. */
  const clearResult = useCallback(() => {
    setOutputText("");
    setCorrections([]);
    setAnalysis(null);
    setAnalysisNotice(null);
    setRevision(null);
    revisionPoseeRef.current = false;
    setStats({ processingTime: 0, modificationCount: 0 });
    setError(null);
    setErrorDetails(null);
  }, []);

  const handleCorrect = useCallback(async () => {
    if (isRunningRef.current) return;
    if (!textContent.trim()) {
      setError("Veuillez entrer du texte");
      setErrorDetails(null);
      return;
    }

    isRunningRef.current = true;
    setIsLoadingText(true);
    setIsLoadingCorrections(false);
    clearResult();

    abortControllerRef.current = new AbortController();

    // Question de révision (issue #62) : demandée en parallèle, jamais attendue.
    // Si elle arrive, elle tient lieu de sollicitation pour ce texte.
    if (settings.revisionQuestion !== false) {
      const controleur = abortControllerRef.current;
      void fetchRevision(controleur.signal).then((question) => {
        if (!question || abortControllerRef.current !== controleur) return;
        revisionPoseeRef.current = true;
        setRevision(question);
      });
    }

    try {
      // Le LLM ne renvoie que le texte corrigé. Le correcteur grammatical
      // intégré tourne en parallèle sur le texte d'origine pour classer les
      // fautes. Les trois étapes (détection, correction, analyse) reçoivent le
      // même texte préparé : sinon une coupe ou un caractère retiré
      // apparaîtrait comme une correction, voire comme une faute.
      const signal = abortControllerRef.current.signal;
      const input = prepareInput(textContent);
      // Avertissements cumulés, affichés ensemble.
      const notices: string[] = [];
      const notify = (notice: string) => {
        notices.push(notice);
        setAnalysisNotice(notices.join(" "));
      };
      if (input.truncated) {
        notify(
          `Le texte dépasse ${MAX_CONTENT_LENGTH.toLocaleString("fr-FR")} caractères : ` +
            `seuls les ${input.text.length.toLocaleString("fr-FR")} premiers ont été corrigés ` +
            `(sur ${input.originalLength.toLocaleString("fr-FR")}).`,
        );
      }
      const ltPromise: Promise<LTMatch[] | null> = runLanguageTool(input.text, signal).catch(
        () => null,
      );

      const { text: finalText, duration } = await correctText(input.text, settings, {
        onText: (text) => {
          if (!text) return;
          setOutputText(text);
          setIsLoadingText(false);
        },
      });

      if (!finalText || finalText.trim().length === 0) {
        throw new ErreurCorrection(
          "Le modèle a renvoyé une réponse vide. Réessayez dans un instant.",
          "Réponse vide du modèle.",
        );
      }

      setOutputText(finalText);
      setIsLoadingText(false);
      setIsLoadingCorrections(true);
      setStats((prev) => ({ ...prev, processingTime: duration }));

      // Le texte corrigé est déjà affiché : un échec de l'analyse ne doit
      // jamais bloquer la copie.
      try {
        const matches = await ltPromise;
        if (matches === null) {
          notify(
            "Le correcteur grammatical est indisponible : l'analyse des fautes est partielle.",
          );
        }
        const result = await analyzeCorrection(
          input.text,
          finalText,
          matches ?? [],
          signal,
          revisionPoseeRef.current,
        );
        // L'astuce d'une règle n'est affichée qu'à sa première occurrence.
        const seenTips = new Set<string>();
        const entries = result.corrections.map((c) => {
          const entry = describeCorrection(c);
          if (entry.astuce && seenTips.has(entry.astuce)) entry.astuce = undefined;
          else if (entry.astuce) seenTips.add(entry.astuce);
          return entry;
        });
        setAnalysis(result);
        setCorrections(entries);
        setStats((prev) => ({ ...prev, modificationCount: entries.length }));
      } catch (analysisError) {
        if (analysisError instanceof Error && analysisError.name === "AbortError") return;
        notify("L'analyse des fautes est indisponible pour ce texte.");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      // Message simple ; le détail technique est replié sous « Détails ».
      if (err instanceof ErreurCorrection) {
        setError(err.message);
        setErrorDetails(err.details || null);
      } else {
        setError(err instanceof Error ? err.message : MESSAGE_ECHEC_CORRECTION);
      }
    } finally {
      isRunningRef.current = false;
      setIsLoadingText(false);
      setIsLoadingCorrections(false);
      abortControllerRef.current = null;
    }
  }, [textContent, settings, clearResult]);

  const handleReset = useCallback(() => {
    setTextContent("");
    clearResult();
  }, [clearResult]);

  return {
    textContent,
    setTextContent,
    outputText,
    corrections,
    analysis,
    analysisNotice,
    revision,
    settings,
    setSettings,
    isLoading: isLoadingText,
    isLoadingCorrections,
    error,
    errorDetails,
    stats,
    handleCorrect,
    handleReset,
  };
}

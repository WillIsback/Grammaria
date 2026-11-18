import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzedCorrection } from "../analysis/analyze";
import { type AnalysisResponse, analyzeCorrection } from "../services/journal";
import { applyLTCorrections, runLanguageTool } from "../services/languagetool";
import type { CorrectionEntry, CorrectionSettings, CorrectionStats, LTMatch } from "../types";
import { correctText } from "../utils/llm";
import { MAX_CONTENT_LENGTH, prepareInput } from "../utils/sanitize";

const SETTINGS_KEY = "grammaria:settings";

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
  const [settings, setSettings] = useState<CorrectionSettings>({
    engine: "llm",
    mode: "formel",
    fixGrammar: true,
    fixSpelling: true,
    fixSyntax: true,
    fixStyle: true,
  });
  const [error, setError] = useState<string | null>(null);
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
        const parsed = JSON.parse(savedSettings);
        setSettings((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      /* use defaults */
    }
  }, []);

  const localStorageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup à l'unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (localStorageTimeoutRef.current) clearTimeout(localStorageTimeoutRef.current);
    };
  }, []);

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

  const handleCorrect = useCallback(async () => {
    if (isRunningRef.current) return;
    if (!textContent.trim()) {
      setError("Veuillez entrer du texte");
      return;
    }

    isRunningRef.current = true;
    setIsLoadingText(true);
    setIsLoadingCorrections(false);
    setError(null);
    setOutputText("");
    setCorrections([]);
    setAnalysis(null);
    setAnalysisNotice(null);
    setStats({ processingTime: 0, modificationCount: 0 });

    abortControllerRef.current = new AbortController();

    try {
      if (settings.engine === "lt") {
        // Moteur LanguageTool
        const startTime = Date.now();
        const matches = await runLanguageTool(textContent, abortControllerRef.current.signal);
        const { correctedText, corrections: ltCorrections } = applyLTCorrections(
          textContent,
          matches,
        );
        setOutputText(correctedText);
        setCorrections(ltCorrections);
        setStats({
          processingTime: Date.now() - startTime,
          modificationCount: ltCorrections.length,
        });
        setIsLoadingText(false);
      } else {
        // Moteur LLM : le correcteur ne renvoie que le texte. LanguageTool
        // tourne en parallèle sur le texte d'origine pour classer les fautes.
        // Les trois étapes (LanguageTool, correcteur, analyse) reçoivent le
        // même texte préparé : sinon une coupe ou un caractère retiré
        // apparaîtrait comme une correction, voire comme une faute.
        const signal = abortControllerRef.current.signal;
        const input = prepareInput(textContent);
        const notices: string[] = [];
        if (input.truncated) {
          notices.push(
            `Le texte dépasse ${MAX_CONTENT_LENGTH.toLocaleString("fr-FR")} caractères : ` +
              `seuls les ${input.text.length.toLocaleString("fr-FR")} premiers ont été corrigés ` +
              `(sur ${input.originalLength.toLocaleString("fr-FR")}).`,
          );
          setAnalysisNotice(notices.join(" "));
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
          throw new Error("LLM returned empty response");
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
            notices.push("LanguageTool est indisponible : l'analyse des fautes est partielle.");
            setAnalysisNotice(notices.join(" "));
          }
          const result = await analyzeCorrection(input.text, finalText, matches ?? [], signal);
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
          notices.push("L'analyse des fautes est indisponible pour ce texte.");
          setAnalysisNotice(notices.join(" "));
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Une erreur inconnue est survenue");
    } finally {
      isRunningRef.current = false;
      setIsLoadingText(false);
      setIsLoadingCorrections(false);
      abortControllerRef.current = null;
    }
  }, [textContent, settings]);

  const handleReset = useCallback(() => {
    setTextContent("");
    setOutputText("");
    setCorrections([]);
    setAnalysis(null);
    setAnalysisNotice(null);
    setStats({ processingTime: 0, modificationCount: 0 });
    setError(null);
  }, []);

  return {
    textContent,
    setTextContent,
    outputText,
    corrections,
    analysis,
    analysisNotice,
    settings,
    setSettings,
    isLoading: isLoadingText,
    isLoadingCorrections,
    error,
    stats,
    handleCorrect,
    handleReset,
  };
}

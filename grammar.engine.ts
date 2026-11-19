/**
 * Moteur du correcteur du serveur : règles françaises de LanguageTool (portage JavaScript),
 * chargé par grammar.worker.ts.
 */
// Enregistre les règles françaises, avant tout appel à `check`.
import "@valueerror/ltjs-lang-fr";

export { check } from "@valueerror/ltjs-core";

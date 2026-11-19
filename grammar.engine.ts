/**
 * Moteur du correcteur : règles françaises de LanguageTool (portage JavaScript).
 *
 * Imports statiques uniquement : dans l'exécutable compilé de l'application de
 * bureau, un import dynamique d'un paquet peut être résolu depuis un
 * node_modules du dossier courant au lieu du code embarqué.
 */
// Ordre important : les dossiers de règles (application de bureau) avant les règles.
import "./grammar.resources.ts";
// Enregistre les règles françaises ; import explicite pour que l'exécutable compilé les embarque.
import "@valueerror/ltjs-lang-fr";
// Embarque hunspell.wasm dans l'exécutable compilé, à la racine de son système
// de fichiers virtuel, là où le module WebAssembly le cherche (build avec
// --asset-naming="[name].[ext]"). Sans effet hors exécutable compilé.
import "@valueerror/ltjs-core/src/lib/hunspell/wasm/hunspell.wasm" with { type: "file" };

export { check } from "@valueerror/ltjs-core";

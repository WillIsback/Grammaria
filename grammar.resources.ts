/**
 * Dossiers de règles du correcteur, pour l'application de bureau.
 *
 * Le serveur y est un exécutable compilé, où les modules n'ont plus de chemin
 * réel : les fichiers de règles sont livrés à côté, et GRAMMARIA_LT_RESOURCES
 * désigne leur dossier (voir scripts/desktop/prepare-sidecar.ts).
 *
 * Module importé en premier par grammar.worker.ts : les imports statiques sont
 * évalués dans l'ordre, les dossiers sont donc connus avant le chargement des
 * règles. Imports statiques uniquement : dans un exécutable compilé, un import
 * dynamique peut être résolu depuis un node_modules du dossier courant.
 */
import { join } from "node:path";
import { addResourceRoot } from "@valueerror/ltjs-core/src/core/resources/ResourceDataBroker.js";

const root = process.env.GRAMMARIA_LT_RESOURCES;
if (root) {
  for (const dir of ["core", "unicode", "fr"]) addResourceRoot(join(root, dir));
}

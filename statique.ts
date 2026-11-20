import { resolve, sep } from "node:path";

/**
 * Fichier de l'interface à servir pour le chemin d'une requête (`url.pathname`,
 * tel quel), ou null s'il sort du dossier `distDir` (traversée de chemin).
 *
 * Le test exige le séparateur après le dossier : un simple `startsWith`
 * laisserait passer un dossier voisin dont le nom commence pareil
 * (`dist-autre` à côté de `dist`).
 */
export function cheminStatique(distDir: string, pathname: string): string | null {
  const racine = resolve(distDir);
  const chemin = resolve(racine, `.${pathname === "/" ? "/index.html" : pathname}`);
  const prefixe = racine.endsWith(sep) ? racine : racine + sep;
  return chemin.startsWith(prefixe) ? chemin : null;
}

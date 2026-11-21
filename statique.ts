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

/**
 * En-têtes de durcissement des réponses de l'interface web (issue #42). La CSP
 * reprend celle de l'application de bureau (interface React qui ne contacte que
 * sa propre origine), avec `connect-src 'self'` : l'interface web appelle le
 * serveur Grammaria (routes /api et /v1, flux SSE) sur la même origine.
 * `style-src 'unsafe-inline'` est le seul assouplissement (styles injectés) ;
 * `script-src` reste strict.
 */
export const CSP_WEB = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
].join("; ");

export const EN_TETES_SECURITE: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CSP_WEB,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

/** Ajoute les en-têtes de durcissement à une réponse de l'interface, puis la renvoie. */
export function avecEnTetesSecurite(reponse: Response): Response {
  for (const [nom, valeur] of Object.entries(EN_TETES_SECURITE)) {
    reponse.headers.set(nom, valeur);
  }
  return reponse;
}

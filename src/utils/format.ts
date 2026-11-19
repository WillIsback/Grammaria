/** Mise en forme française des nombres et des dates affichés. */

/** Nombre au format français, avec au plus `chiffres` décimales : « 3 827 », « 14,8 ». */
export function nombre(n: number, chiffres = 1): string {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: chiffres });
}

/** « 12 mars 2026 », ou « 12 mars » sans l'année. */
export function dateLongue(at: number, avecAnnee = true): string {
  return new Date(at).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: avecAnnee ? "numeric" : undefined,
  });
}

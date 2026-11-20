/**
 * Correcteur grammatical de l'application de bureau, côté page.
 *
 * Le moteur est dans le backend Rust de l'application (grammaria-rc, lié à src-tauri :
 * src-tauri/src/correcteur.rs). Cette façade appelle ses deux commandes et garde le contrat de
 * `GrammarChecker` du serveur (grammar.ts), pour que le gestionnaire de POST /api/check partagé
 * l'utilise tel quel : `check(text)` rend les détections au format de la réponse du serveur.
 *
 * - Les données ne sont chargées qu'à la première demande (ou par `prechauffer()`), côté Rust,
 *   hors du fil principal ; les demandes faites pendant le chargement l'attendent.
 * - Délai maximal par analyse : la promesse est rejetée si le backend ne répond pas.
 * - Données absentes ou abîmées : les demandes sont rejetées avec un message lisible ; la
 *   demande suivante retente le chargement.
 *
 * Plus de Worker ni d'archive de règles dans la page : rien à télécharger, rien à évaluer.
 */
import type { LTMatch } from "../types.ts";
import { type Invoke, invokeSur } from "./tauri.ts";

/** Mesures du chargement des données du moteur (`MesuresChargement` de correcteur.rs). */
export interface MesuresChargement {
  /** Taille des données du moteur sur le disque. */
  donneesOctets: number;
  /** Durée du chargement (lexique, listes de mots, règles). */
  chargementMs: number;
}

/** `arrete` : pas encore chargé, ou arrêté par `close()`. */
export type EtatCorrecteur = "arrete" | "chargement" | "pret" | "erreur";

export interface OptionsCorrecteur {
  /** Délai maximal d'une analyse, chargement compris (défaut : 30 s, comme le serveur). */
  delaiControleMs?: number;
  /** Appelé à chaque changement d'état. */
  onEtat?: (etat: EtatCorrecteur, correcteur: CorrecteurBureau) => void;
}

const DELAI_CONTROLE_MS = 30_000;

export class CorrecteurBureau {
  etat: EtatCorrecteur = "arrete";
  /** Mesures du dernier chargement réussi. */
  mesures: MesuresChargement | null = null;
  /** Message de la dernière erreur de chargement. */
  erreur: string | null = null;

  private readonly appeler: Invoke;
  private readonly options: OptionsCorrecteur;
  private chargement: Promise<void> | null = null;
  private ferme = false;

  constructor(invoke: Invoke, options: OptionsCorrecteur = {}) {
    this.appeler = invokeSur(invoke);
    this.options = options;
  }

  /** Charge les données en arrière-plan ; la promesse se résout quand le correcteur est prêt. */
  prechauffer(): Promise<void> {
    if (this.etat === "pret") return Promise.resolve();
    if (this.chargement) return this.chargement;
    this.ferme = false;
    this.changerEtat("chargement");
    const chargement = this.appeler<MesuresChargement>("correcteur_prechauffer").then(
      (mesures) => {
        if (this.chargement !== chargement) return;
        this.chargement = null;
        this.mesures = mesures;
        this.erreur = null;
        this.changerEtat("pret");
      },
      (error: unknown) => {
        if (this.chargement !== chargement) throw error;
        this.chargement = null;
        this.erreur = error instanceof Error ? error.message : String(error);
        this.changerEtat("erreur");
        throw error;
      },
    );
    this.chargement = chargement;
    return chargement;
  }

  /** Détections du moteur sur `text`, au format de POST /api/check. */
  async check(text: string): Promise<LTMatch[]> {
    // Le backend charge les données à la première commande, quelle qu'elle soit : passer par
    // `prechauffer` tient l'état (et les mesures) à jour. Après une erreur, on retente.
    if (this.etat !== "pret") await this.prechauffer();
    if (this.ferme) throw new Error("Le correcteur grammatical a été arrêté.");
    return this.avecDelai(this.appeler<LTMatch[]>("correcteur_controler", { texte: text }));
  }

  /**
   * Oublie l'état côté page. Le moteur, lui, reste chargé dans l'application : un nouvel appel
   * le retrouve aussitôt.
   */
  close(): void {
    this.ferme = true;
    this.chargement = null;
    this.changerEtat("arrete");
  }

  private avecDelai<T>(promesse: Promise<T>): Promise<T> {
    const delai = this.options.delaiControleMs ?? DELAI_CONTROLE_MS;
    return new Promise((resolve, reject) => {
      const minuteur = setTimeout(
        () => reject(new Error("Le correcteur grammatical ne répond pas.")),
        delai,
      );
      promesse.then(
        (valeur) => {
          clearTimeout(minuteur);
          resolve(valeur);
        },
        (error: unknown) => {
          clearTimeout(minuteur);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private changerEtat(etat: EtatCorrecteur): void {
    if (this.etat === etat) return;
    this.etat = etat;
    this.options.onEtat?.(etat, this);
  }
}

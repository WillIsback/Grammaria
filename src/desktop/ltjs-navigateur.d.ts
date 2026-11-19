/**
 * Déclarations minimales du build navigateur de @valueerror/ltjs-core (paquet sans types),
 * utilisé par le Worker du correcteur du bureau (lt.worker.ts). Complète src/ltjs-core.d.ts.
 */
declare module "@valueerror/ltjs-core/browser" {
  export { check } from "@valueerror/ltjs-core";

  export interface OptionsPrechargement {
    /** Ressources à charger : URL passée à `fetchImpl` et nom de ressource (chemin de classe). */
    entries: { url: string; name: string }[];
    /** Octets de hunspell.wasm, `true` pour le chercher à côté du paquet, `false` pour s'en passer. */
    hunspellWasm?: boolean | Uint8Array;
    fetchImpl?: (url: string) => Promise<Uint8Array | Response>;
    /** Listes de dossiers lues par le moteur (aucune pour le français). */
    directories?: Record<string, string[]>;
    concurrency?: number;
  }

  /** Remplit le magasin de ressources en mémoire ; à appeler avant le premier `check`. */
  export function preloadResources(options: OptionsPrechargement): Promise<void>;
}

declare module "@valueerror/ltjs-core/src/core/resources/ResourceDataBroker.js" {
  /** Magasin de ressources en mémoire (navigateur), rempli par `preloadResources`. */
  export class MemoryResourceBackend {
    read(name: string): Uint8Array | null;
    getUrl(name: string): unknown;
  }
}

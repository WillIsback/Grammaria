import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader() }),
  // Surcharge des chaînes d'interface de Starlight (voir src/content/i18n/).
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};

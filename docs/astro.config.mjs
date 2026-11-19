import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Le site est servi à la racine de grammaria.fr : la page d'accueil est sur /,
// la documentation sous /docs (contenu dans src/content/docs/docs).
export default defineConfig({
  site: "https://grammaria.fr",
  integrations: [
    starlight({
      title: "Grammaria",
      defaultLocale: "root",
      locales: { root: { label: "Français", lang: "fr" } },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/WillIsback/Grammaria" },
      ],
      sidebar: [
        {
          label: "Découvrir",
          items: [
            { label: "Pour qui, pourquoi, comment", link: "/docs/" },
            { label: "Fonctionnement", link: "/docs/decouvrir/fonctionnement/" },
            { label: "Feuille de route", link: "/docs/decouvrir/feuille-de-route/" },
          ],
        },
        {
          label: "Démarrer",
          items: [
            { label: "Application de bureau", link: "/docs/demarrer/application-bureau/" },
            { label: "Installation", link: "/docs/demarrer/installation/" },
            { label: "Configuration", link: "/docs/demarrer/configuration/" },
          ],
        },
        {
          label: "Utiliser",
          items: [
            { label: "Corriger un texte", link: "/docs/utiliser/corriger/" },
            { label: "Corrections et fiches de règles", link: "/docs/utiliser/corrections/" },
            { label: "Note et journal des fautes", link: "/docs/utiliser/note-et-journal/" },
          ],
        },
        {
          label: "Exploiter",
          items: [
            { label: "Déploiement Docker", link: "/docs/exploiter/docker/" },
            { label: "Télémétrie", link: "/docs/exploiter/telemetrie/" },
          ],
        },
        {
          label: "Référence",
          items: [
            { label: "API", link: "/docs/reference/api/" },
            { label: "Architecture", link: "/docs/reference/architecture/" },
            { label: "Développement", link: "/docs/reference/developpement/" },
            { label: "Application de bureau (build)", link: "/docs/reference/bureau/" },
            { label: "FAQ", link: "/docs/reference/faq/" },
          ],
        },
      ],
    }),
  ],
});

import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Le site est servi à la racine de grammaria.fr : la page d'accueil est sur /,
// la documentation sous /docs (contenu dans src/content/docs/docs).
export default defineConfig({
  site: "https://grammaria.fr",
  // Pages déplacées : les anciennes adresses restent valides.
  redirects: {
    "/docs/decouvrir/feuille-de-route/": "/docs/decouvrir/versions/",
    "/docs/demarrer/configuration/": "/docs/exploiter/configuration/",
  },
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
            {
              label: "Bêta : démarche et méthode de test",
              link: "/docs/decouvrir/beta/",
              badge: { text: "Nouveau", variant: "caution" },
            },
            { label: "Comment ça marche", link: "/docs/decouvrir/fonctionnement/" },
            { label: "Démarche pédagogique", link: "/docs/decouvrir/pedagogie/" },
            { label: "Le moteur de grammaire", link: "/docs/decouvrir/moteur/" },
            { label: "Versions", link: "/docs/decouvrir/versions/" },
            { label: "Sécurité", link: "/docs/decouvrir/securite/" },
            { label: "Remerciements", link: "/docs/decouvrir/remerciements/" },
          ],
        },
        {
          label: "Démarrer",
          items: [
            { label: "Application de bureau", link: "/docs/demarrer/application-bureau/" },
            { label: "Installer un serveur", link: "/docs/demarrer/installation/" },
          ],
        },
        {
          label: "Utiliser",
          items: [
            { label: "Corriger un texte", link: "/docs/utiliser/corriger/" },
            { label: "Corrections et fiches de règles", link: "/docs/utiliser/corrections/" },
            { label: "Note et journal des fautes", link: "/docs/utiliser/note-et-journal/" },
            { label: "Progression", link: "/docs/utiliser/progression/" },
            { label: "Badges", link: "/docs/utiliser/badges/" },
          ],
        },
        {
          label: "Exploiter",
          items: [
            { label: "Déploiement Docker", link: "/docs/exploiter/docker/" },
            { label: "Configuration du serveur", link: "/docs/exploiter/configuration/" },
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
            { label: "FAQ et dépannage", link: "/docs/reference/faq/" },
          ],
        },
      ],
    }),
  ],
});

# Grammaria

**Le correcteur de français qui corrige tout de suite, et vous aide à ne plus refaire les mêmes fautes.**

Documentation : [grammaria.fr/docs](https://grammaria.fr/docs/)

## Pour qui

Pour les **adultes qui écrivent en français tous les jours** (messages, courriels, comptes rendus) et qui traînent des lacunes à l'écrit sans avoir le temps de les combler.

Grammaria n'est pas un outil scolaire : pas de cours à suivre, pas de série d'exercices. Quand on est pressé, on veut un texte propre, pas une leçon.

## Pourquoi

Un correcteur automatique a un effet pervers : on colle son texte, on copie le résultat, et on n'apprend jamais rien. Les mêmes fautes reviennent pendant des mois. Les méthodes d'apprentissage classiques échouent pour la raison inverse : elles demandent du temps au moment précis où l'on n'en a pas.

Grammaria garde la vitesse du correcteur et y ajoute une couche d'observation :

- la correction reste **instantanée**, sans étape imposée ;
- l'application **repère les fautes qui reviennent**, sur vos vrais textes ;
- elle explique en une phrase, au format « remplacez par X, car Y ».

## Comment

1. Vous collez un texte et cliquez sur **Corriger**. Le texte corrigé s'affiche au fil de la génération et se copie aussitôt.
2. Le modèle de langage ne fait que corriger. Les modifications sont **calculées** par comparaison entre votre texte et le texte corrigé, sans appel supplémentaire au modèle.
3. [LanguageTool](https://languagetool.org) analyse votre texte en parallèle. Une de ses détections n'est retenue que si le modèle a réellement corrigé le passage, ce qui écarte les faux positifs.
4. Douze confusions courantes (a/à, on/ont, ces/ses, -er/-é…) sont reconnues directement et accompagnées d'une **fiche**.
5. Chaque faute est consignée dans un **journal local**. Seule la phrase concernée est conservée, jamais le texte entier.
6. Une **note sur 20**, calculée sur la densité de fautes, suit votre progression texte par texte et sur sept jours.

Les interventions sur les fautes récurrentes (astuce puis choix entre deux formes sur le bouton « Copier ») sont la prochaine étape. Elles sont décrites dans la [feuille de route](https://grammaria.fr/docs/decouvrir/feuille-de-route/) et ne sont pas encore disponibles.

## Vos textes restent chez vous

Grammaria s'héberge soi-même. Vos textes ne sont envoyés qu'au modèle et à l'instance LanguageTool que vous avez configurés. Le journal est un fichier SQLite sur votre serveur.

## Démarrage rapide

Il vous faut un modèle de langage exposé par une API compatible OpenAI (vLLM, SGLang, Ollama…), Docker pour LanguageTool, [Bun](https://bun.sh) et Node.js `^22.18`, `^24.11` ou `>=26`.

```bash
git clone https://github.com/WillIsback/Grammaria.git
```

```bash
cd Grammaria
```

```bash
cp .env.example .env
```

Renseignez `LLM_TARGET` dans `.env`, puis :

```bash
npm install
```

```bash
docker compose up -d
```

```bash
npm run build
```

```bash
bun run server.ts
```

L'application est sur http://localhost:25000. Le détail est dans le guide d'[installation](https://grammaria.fr/docs/demarrer/installation/) et de [configuration](https://grammaria.fr/docs/demarrer/configuration/).

## Développement

Le projet utilise [Vite+](https://viteplus.dev) : toute la configuration de l'outillage est dans `vite.config.ts`.

| Commande               | Rôle                               |
| ---------------------- | ---------------------------------- |
| `npm run dev`          | Serveur de développement           |
| `npm run build`        | Vérification des types, puis build |
| `npm run check`        | Format, lint et types              |
| `npm run test:run`     | Tests                              |
| `npm run test:journal` | Tests du journal, exécutés par Bun |

Voir la page [Développement](https://grammaria.fr/docs/reference/developpement/) et l'[architecture](https://grammaria.fr/docs/reference/architecture/).

## Origine et licence

Grammaria est issu d'[ai_corrector](https://github.com/WillIsback/ai_corrector). Licence MIT.

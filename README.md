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
2. Le modèle de langage ne fait que corriger. Les modifications sont **calculées** par comparaison entre votre texte et le texte corrigé, sans appel supplémentaire au modèle. La ponctuation est corrigée en silence : appliquée dans le texte, elle n'est ni listée ni comptée.
3. Les règles françaises de [LanguageTool](https://languagetool.org), exécutées par le moteur Rust [grammaria-rc](https://github.com/WillIsback/grammaria-rc) intégré à Grammaria (aucun service à lancer), analysent votre texte en parallèle. Une de ses détections n'est retenue que si le modèle a réellement corrigé le passage, ce qui écarte les faux positifs.
4. Treize confusions courantes (a/à, on/ont, ces/ses, -er/-é, travail/travaille…) sont reconnues directement et accompagnées d'une **fiche**.
5. Chaque faute est consignée dans un **journal local**. Seule la phrase concernée est conservée, jamais le texte entier.
6. Une **note sur 20**, calculée sur la densité de fautes, suit votre progression texte par texte et sur sept jours.

7. Quand une faute **revient**, Grammaria intervient là où vous regardez, près du bouton « Copier » : d'abord une astuce d'une ligne, puis, si la faute persiste, le bouton propose les deux formes sur votre propre phrase. Un seul clic dans tous les cas : la copie n'est jamais retardée.
8. L'écran **Progression** montre votre évolution : score de maîtrise, note semaine après semaine, règles acquises ou à travailler, mots pièges. Des **badges** sobres constatent les étapes franchies, sans série à ne pas casser.

Le détail est dans [Corriger un texte](https://grammaria.fr/docs/utiliser/corriger/), [Progression](https://grammaria.fr/docs/utiliser/progression/), [Badges](https://grammaria.fr/docs/utiliser/badges/) et la [feuille de route](https://grammaria.fr/docs/decouvrir/feuille-de-route/).

## Vos textes restent chez vous

Grammaria s'héberge soi-même. Vos textes ne sont envoyés qu'au modèle que vous avez configuré : l'analyse grammaticale tourne dans le serveur Grammaria. Le journal est un fichier SQLite sur votre serveur.

## Application de bureau

Pour Windows et Linux, sans serveur à installer (paquet `.deb` de 8 Mo) : téléchargez le paquet de votre système dans les [Releases](https://github.com/WillIsback/Grammaria/releases), lancez Grammaria et indiquez l'adresse de votre modèle (Ollama ou API compatible OpenAI) dans les réglages. L'application cherche une nouvelle version à chaque démarrage et vous la propose : rien n'est installé sans votre accord (installeur Windows et AppImage ; le paquet `.deb` et le MSI signalent seulement la nouvelle version). La rubrique **Paramètres → Mises à jour** affiche la version installée et indique si les mises à jour automatiques sont actives dans votre version. Voir le guide de l'[application de bureau](https://grammaria.fr/docs/demarrer/application-bureau/).

## Démarrage rapide (serveur)

Il vous faut un modèle de langage exposé par une API compatible OpenAI (vLLM, SGLang, Ollama…), [Bun](https://bun.sh), Node.js `^22.18`, `^24.11` ou `>=26`, et [Rust](https://rustup.rs) pour compiler le moteur grammatical. Clonez [grammaria-rc](https://github.com/WillIsback/grammaria-rc) à côté de Grammaria (ou indiquez son chemin dans `GRAMMARIA_RC_SRC`).

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
npm run build
```

Construisez le moteur grammatical (binaire et données dans `moteur/`) :

```bash
npm run build:moteur
```

```bash
bun run server.ts
```

L'application est sur http://localhost:25000. Le détail est dans le guide d'[installation](https://grammaria.fr/docs/demarrer/installation/) et de [configuration](https://grammaria.fr/docs/demarrer/configuration/).

## Développement

Le projet utilise [Vite+](https://viteplus.dev) : toute la configuration de l'outillage est dans `vite.config.ts`.

| Commande               | Rôle                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `npm run dev`          | Serveur de développement                                        |
| `npm run build`        | Vérification des types, puis build                              |
| `npm run check`        | Format, lint et types                                           |
| `npm run test:run`     | Tests                                                           |
| `npm run build:moteur` | Compile le moteur grammatical Rust et ses données (`moteur/`)   |
| `npm run test:journal` | Tests du journal et du correcteur grammatical, exécutés par Bun |

Voir la page [Développement](https://grammaria.fr/docs/reference/developpement/) et l'[architecture](https://grammaria.fr/docs/reference/architecture/).

## Origine et licence

Grammaria est distribué sous licence [GPL-3.0-or-later](LICENSE).

Le correcteur grammatical intégré est [grammaria-rc](https://github.com/WillIsback/grammaria-rc), moteur Rust publié sous MPL-2.0, qui exécute les règles et le dictionnaire français de [LanguageTool](https://languagetool.org) (LGPL-2.1). Cette branche est expérimentale : elle remplace le portage JavaScript de LanguageTool (`@valueerror/ltjs-core`) de la version 0.3.0. Les gains et les pertes mesurés sont dans [benchmark/moteur-rust/rapport.md](benchmark/moteur-rust/rapport.md).

La police [Inter](https://github.com/rsms/inter), embarquée dans l'application (`src/assets/fonts/`), est distribuée sous licence SIL Open Font License 1.1 ([OFL.txt](src/assets/fonts/OFL.txt)).

Grammaria est issu d'[ai_corrector](https://github.com/WillIsback/ai_corrector), publié sous licence MIT. Sa notice d'origine est conservée dans [LICENSE-MIT](LICENSE-MIT).

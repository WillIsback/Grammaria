# Grammaria

**Le correcteur de français qui corrige tout de suite, et vous aide à ne plus refaire les mêmes fautes.**

Documentation : [grammaria.fr/docs](https://grammaria.fr/docs/)

## Pour qui

Pour **ceux qui écrivent en français tous les jours** (messages, courriels, comptes rendus) et qui traînent des lacunes à l'écrit sans avoir le temps de les combler.

Grammaria n'est pas un outil scolaire : pas de cours à suivre, pas de série d'exercices. Quand on est pressé, on veut un texte propre, pas une leçon.

## Ce que fait Grammaria

Un correcteur automatique a un effet pervers : on colle son texte, on copie le résultat, et on n'apprend jamais rien. Grammaria garde la vitesse du correcteur et y ajoute une couche d'observation :

- **La correction reste instantanée.** Vous collez un texte, cliquez sur **Corriger** : le texte corrigé s'affiche à mesure que le modèle de langage l'écrit, et se copie aussitôt.
- **Chaque faute est nommée.** Grammaria compare votre texte au texte corrigé ; son moteur de grammaire nomme chaque faute. Treize confusions courantes (a/à, on/ont, ces/ses, -er/-é…) ont une fiche « remplacez par X, car Y ».
- **Les fautes qui reviennent sont repérées.** Un journal local garde la phrase fautive, jamais le texte entier. Quand une faute revient, une astuce puis un choix entre deux formes s'affichent près du bouton **Copier**, sans retarder la copie.
- **La progression se voit.** Une note sur 20, un écran **Progression** et des badges sobres montrent le chemin parcouru.

Vos textes ne sont envoyés qu'au modèle de langage que vous avez choisi (Ollama, vLLM, ou toute API compatible OpenAI). L'analyse des fautes et le journal restent chez vous.

Le détail : [Comment ça marche](https://grammaria.fr/docs/decouvrir/fonctionnement/) et [Corriger un texte](https://grammaria.fr/docs/utiliser/corriger/).

## Installer

### Application de bureau (Windows, Linux)

Téléchargez le paquet de votre système dans les [Releases](https://github.com/WillIsback/Grammaria/releases) (environ 9 Mo pour le `.deb`, 7 Mo pour l'installeur Windows), lancez Grammaria et indiquez l'adresse de votre modèle dans **Paramètres → IA**. Rien d'autre à installer. Guide : [Application de bureau](https://grammaria.fr/docs/demarrer/application-bureau/).

### Serveur Docker

```bash
docker run -d --name grammaria -p 25000:25000 \
  -v "$(pwd)/data:/app/data" \
  -e LLM_TARGET=http://votre-serveur-llm:11434 \
  -e TZ=Europe/Paris \
  ghcr.io/willisback/grammaria:latest
```

L'application est sur http://localhost:25000. Guides : [Installer un serveur](https://grammaria.fr/docs/demarrer/installation/) (dont l'installation depuis les sources), [Déploiement Docker](https://grammaria.fr/docs/exploiter/docker/) et [Configuration](https://grammaria.fr/docs/exploiter/configuration/).

## Le moteur de grammaire

Grammaria utilise son propre moteur, [grammaria-rc](https://github.com/WillIsback/grammaria-rc) : un moteur maison écrit en Rust, sans dépendance, léger et rapide. Il porte en Rust la chaîne d'analyse de LanguageTool, dont il lit tels quels les règles et dictionnaires français, et y ajoute 1 320 règles propres. Face à LanguageTool 6.9 dans son portage JavaScript, l'ancien correcteur de Grammaria, sur la même machine :

- démarrage du moteur : 4,3–4,6 s → **0,5 s** ;
- mémoire du moteur : 924–937 Mio → **220–250 Mio** ;
- fautes trouvées sur l'ensemble des bancs d'essai : 76,4 % → **86,4 %**.

Mesures complètes : [Le moteur de grammaire](https://grammaria.fr/docs/decouvrir/moteur/).

## Développement

Le projet utilise [Vite+](https://viteplus.dev) : toute la configuration de l'outillage est dans `vite.config.ts`. Il faut [Bun](https://bun.sh), Node.js `^22.18`, `^24.11` ou `>=26`, [Rust](https://rustup.rs) 1.75 ou plus récent et `git`.

| Commande               | Rôle                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `npm run dev`          | Serveur de développement                                        |
| `npm run build`        | Vérification des types, puis build                              |
| `npm run check`        | Format, lint et types                                           |
| `npm run test:run`     | Tests                                                           |
| `npm run build:moteur` | Compile le moteur grammatical Rust et ses données (`moteur/`)   |
| `npm run test:journal` | Tests du journal et du correcteur grammatical, exécutés par Bun |

Voir la page [Développement](https://grammaria.fr/docs/reference/developpement/) et l'[architecture](https://grammaria.fr/docs/reference/architecture/).

## Remerciements

Grammaria et son moteur doivent beaucoup à des projets libres :

- **[LanguageTool](https://languagetool.org)** (Daniel Naber et contributeurs) : le moteur lit tels quels ses fichiers de règles et dictionnaires français (5 343 règles de grammaire, 1 674 de style), et sa chaîne d'analyse (découpage, étiquetage, désambiguïsation, filtres) a été portée de Java vers Rust.
- **[Grammalecte](https://grammalecte.net) et Dicollecte** (Olivier R.) : le dictionnaire français dérive des données Dicollecte/Grammalecte ; les phrases de test de Grammalecte ont servi de banc d'essai pour écrire les 1 320 règles propres au moteur, écrites d'après le comportement attendu et non copiées du code de Grammalecte.
- **[Morfologik](https://github.com/morfologik/morfologik-stemming)** (Dawid Weiss et Marcin Miłkowski) : lecteur de dictionnaire et correcteur orthographique portés en Rust.
- **Numbertext** : programmes d'écriture des nombres en lettres, fournis avec les données de LanguageTool.
- **`@valueerror/ltjs`** : le portage JavaScript de LanguageTool qui équipait Grammaria jusqu'à la v0.3.0 ; il a servi de référence de comparaison, aucun code n'en provient.
- **[ai_corrector](https://github.com/WillIsback/ai_corrector)**, dont Grammaria est issu, et la police **[Inter](https://github.com/rsms/inter)**.

La liste complète : [Remerciements](https://grammaria.fr/docs/decouvrir/remerciements/).

## Licence

Grammaria est un logiciel libre, distribué sous licence [GPL-3.0-or-later](LICENSE). Son moteur, [grammaria-rc](https://github.com/WillIsback/grammaria-rc), est sous LGPL-2.1-or-later.

Les mentions des projets tiers sont dans les [remerciements](https://grammaria.fr/docs/decouvrir/remerciements/), dans [`THIRD_PARTY_LICENSES.md`](https://github.com/WillIsback/grammaria-rc/blob/main/THIRD_PARTY_LICENSES.md) pour le moteur, dans [OFL.txt](src/assets/fonts/OFL.txt) pour la police Inter et dans [LICENSE-MIT](LICENSE-MIT) pour ai_corrector.

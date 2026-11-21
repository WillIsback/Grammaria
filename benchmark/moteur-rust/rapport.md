# Moteur Rust `grammaria-rc` à la place de ltjs : gains et pertes

Comparaison de la version expérimentale de Grammaria (branche `claude/sleepy-tesla-re29jm`,
moteur Rust `grammaria-rc` révision `77488bd`) avec la dernière version publiée, **v0.3.0**
(portage JavaScript de LanguageTool, `@valueerror/ltjs-core` 0.3.0).

La v0.4.0 épingle la révision `db00af6` de `grammaria-rc` (fusion dans son `main`) : même
code et mêmes règles que `77488bd`, seule la déclaration des licences change. Les chiffres
clés ont été revérifiés sur cette révision lors de l'intégration du lot v0.4.0 (section
« Revérification »).

Ce rapport remplace celui de la première comparaison (moteur à la révision `f55cf16`), qui
concluait que le moteur Rust ne pouvait pas remplacer ltjs : il voyait moitié moins de fautes
et répondait plus lentement. Le moteur a depuis été refait.

## En bref

Le moteur Rust fait maintenant **aussi bien ou mieux que ltjs sur tous les points mesurés, sauf
la taille du paquet** (+0,7 Mio) et une faute marquée sur 1 000 dans les exemples de
LanguageTool.

| | v0.3.0 (ltjs) | Expérimental (Rust) | |
| --- | ---: | ---: | --- |
| Fautes du corpus vues par le moteur | 75 sur 92 (82 %) | 83 sur 92 (90 %) | gain |
| Modifications classées dans l'application | 84 (91 %) | 89 (97 %) | gain |
| Fautes vues seulement par l'un des deux | 0 | 8 | gain |
| Fautes marquées des exemples de LanguageTool détectées | 893 sur 1 000 | 892 sur 1 000 | égal à une près |
| Phrases correctes de ces exemples laissées sans détection | 67 % | 70 % | gain |
| Détections sur les textes sans faute du corpus | 0 | 0 | égal |
| Orthographe (`FR_SPELLING_RULE`, « mots pièges ») | oui | oui | égal |
| Contrôle à chaud, 160 mots (serveur, médiane) | 241 ms | 45 ms | gain (×5,3) |
| Débit du serveur, 16 clients | 4,8 req/s | 18,7 req/s | gain (×3,9) |
| Démarrage du serveur jusqu'au premier contrôle | 4,8 s | 0,7 s | gain (×6,9) |
| Mémoire du serveur après la charge | 1 087 Mo | 292 Mo | gain (×3,7) |
| Paquet `.deb` du bureau | 8,05 Mio | 8,76 Mio | perte (+0,7 Mio) |
| Chargement du correcteur dans le bureau | 3,6 s | 0,66 s | gain (×5,4) |

Sur le banc d'essai du moteur lui-même (29 047 textes, dépôt `grammaria-rc`) : 86,4 % des
fautes trouvées contre 76,4 % pour ltjs, et 8,8 alertes pour 1 000 mots de prose soignée contre
21,6.

## Ce qui a changé dans le moteur

Le premier moteur réinterprétait les règles de LanguageTool de façon approchée. Le nouveau
**porte en Rust la chaîne de LanguageTool elle-même**, étage par étage, chacun vérifié contre
ltjs : découpage en phrases et en mots, étiquetage sur le dictionnaire Morfologik d'origine,
désambiguïsation, règles XML avec leurs 14 filtres Java, 13 règles écrites en Java,
orthographe. Résultat, avec les seules règles de LanguageTool : sur 29 047 textes, 29 038
donnent exactement les mêmes détections que ltjs (22 159 détections retrouvées sur 22 168, 2 en
trop).

S'y ajoutent, propres à Grammaria :

- **1 320 règles** écrites pour les fautes que LanguageTool ne voit pas (accord du participe
  avec le sujet, infinitif ou participe, modes, homophones, groupe nominal, typographie),
  chacune avec ses exemples testés ; quand LanguageTool voit la même faute, c'est sa règle qui
  est gardée, les identifiants de règles déjà suivis par l'application ne changent donc pas ;
- **un profil** : sept règles de LanguageTool qui dérangent surtout (virgule réclamée après
  « De même », synonymes proposés pour un mot répété…) sont coupées, et un mot inconnu qui a
  l'allure d'un nom propre ou d'un sigle n'est plus signalé comme faute d'orthographe.

Les données ne sont plus converties (la conversion du lexique prenait 14 minutes) : le moteur
lit les fichiers de règles et les dictionnaires d'origine, 15 Mio en tout.

## Ce qui a changé dans l'application

- `scripts/moteur/construire.sh` compile le moteur et copie ses données (`moteur/data/lt`,
  `moteur/data/grammaria`) ; plus de conversion, plus de cache à gérer.
- `src-tauri` : dépendance `grammaria_rc` épinglée à la nouvelle révision ; les ressources de
  l'application sont les deux dossiers de données ; `correcteur.rs` demande aussi les règles
  de style, comme LanguageTool par défaut (le serveur aussi : `grammaria serve` les inclut).
- `tests/fixtures/correcteur/reference.json` régénéré (20 textes, 353 détections) ; les tests
  qui attendaient la règle `D_N` sur « un pomme » attendent `D_N_E_OU_E`, celle que
  LanguageTool donne réellement, et le passage signalé « manger » au lieu de « Il a manger ».

Vérifié ici : format, lint et types ; 638 tests unitaires ; 144 tests Bun, dont la référence du
correcteur ; 87 tests Rust du backend ; **build réel de l'application de bureau et son
autotest complet** sous WebKitGTK (25 critères tenus, détections identiques à celles du serveur
sur 20 textes sur 20).

Non vérifié à l'écriture du rapport : l'image Docker, le build Windows, les workflows GitHub,
la documentation du site. Voir la PR du lot v0.4.0 pour ce qui l'a été depuis (image
reconstituée étape par étape, workflows Linux exécutés, documentation mise à jour).

## Méthode

Mesures brutes : seuls les résumés sont gardés dans `mesures/` (`rapport.json`, serveurs,
bureau dans Chromium). Les relevés détection par détection (`moteur-reference.json`,
`moteur-experimental.json`, 59 000 lignes) et le JSON complet de l'autotest
(`bureau-experimental-autotest.json`) sont dans l'historique git (commit `c3c4b9e`) et se
régénèrent avec les scripts ci-dessous :

```bash
# Arbre de la v0.3.0 (git worktree, npm ci) et arbre courant (npm run build:moteur)
bun scripts/comparaison/mesurer-moteur.ts --racine <arbre> --nom <étiquette> --sortie moteur-<étiquette>.json
bun scripts/comparaison/mesurer-serveur.ts --racine <arbre> --nom <étiquette> --sortie serveur-<étiquette>.json
bun scripts/comparaison/rapport.ts --reference moteur-reference.json --experimental moteur-experimental.json \
  --serveur-reference serveur-reference.json --serveur-experimental serveur-experimental.json --sortie rapport.json
```

- Machine : 4 cœurs Intel Xeon 2,1 GHz, 15 Go, Linux. Chaque version est mesurée seule, machine
  au repos. Toutes les mesures de ce rapport ont été refaites pour les deux versions.
- Les deux versions exposent la même classe `GrammarChecker` et la même route `POST /api/check` :
  elles sont mesurées par les mêmes scripts (`scripts/comparaison/`).
- **Qualité.** L'application ne retient une détection que si le modèle a corrigé le passage.
  Pour comparer à réponse du modèle égale, chaque texte du corpus du correcteur
  (`tests/fixtures/correcteur/corpus.ts`) a un corrigé écrit à la main
  (`scripts/comparaison/corriges.ts`). Les « fautes de référence » sont les modifications de
  ce corrigé, hors ponctuation : 92 fautes sur 18 textes. Le résultat « dans l'application »
  est celui de `analyze()`, le code de production.
- Second jeu, plus large : 1 000 phrases fautives et 1 000 phrases correctes tirées des exemples
  des fichiers de règles de LanguageTool.
- **Limites.** Corrigés d'une seule main, sans vrai modèle de langage : un modèle reformule
  davantage. Corpus court (940 mots, hors textes composés). Huit des fautes gagnées le sont par
  des règles écrites en ayant ce corpus sous les yeux, parmi d'autres jeux d'essai : le gain sur
  des textes jamais vus est plus faible (dans le banc du moteur, +6,5 points sur la moitié mise
  de côté, contre +13,5 sur celle qui a servi à écrire les règles).

## Qualité sur le corpus du correcteur

18 textes, 92 fautes de référence (modifications du corrigé, hors ponctuation).

|  | v0.3.0 (ltjs) | Expérimental (Rust) |
| --- | ---: | ---: |
| Détections brutes | 99 | 107 |
| Fautes de référence couvertes par une détection | 75 (82 %) | 83 (90 %) |
| Détections hors de toute modification (écartées) | 13 (13 %) | 13 (12 %) |
| Dans l'application : modifications classées | 84 (91 %) | 89 (97 %) |
| — par une fiche de confusion | 26 | 26 |
| — par une règle du moteur | 50 | 58 |
| — par le repli « accord » | 8 | 5 |
| Modifications non classées | 8 | 3 |
| Fautes comptées dans la note | 80 | 83 |

### Par texte

| Texte | Fautes | Couvertes reference | Couvertes experimental | Non classées reference | Non classées experimental | Note reference | Note experimental |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| marche-160-mots | 15 | 15 | 15 | 0 | 0 | 2.5 | 2.5 |
| courriel-pro | 14 | 10 | 13 | 2 | 1 | 0 | 0 |
| accords | 12 | 10 | 10 | 0 | 0 | 0 | 0 |
| homophones | 12 | 10 | 10 | 1 | 1 | 0 | 0 |
| sans-faute | 0 | 0 | 0 | 0 | 0 | 20 | 20 |
| typographie | 2 | 1 | 2 | 1 | 0 | 20 | 14.6 |
| conjugaison | 10 | 9 | 9 | 0 | 0 | 0 | 0 |
| court | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| vide | 0 | 0 | 0 | 0 | 0 | — | — |
| blancs | 0 | 0 | 0 | 0 | 0 | — | — |
| apostrophes-typographiques | 1 | 1 | 1 | 0 | 0 | 12.6 | 12.6 |
| emojis | 4 | 4 | 4 | 0 | 0 | 0 | 0 |
| majuscules | 13 | 8 | 10 | 3 | 1 | 0 | 0 |
| ponctuation | 0 | 0 | 0 | 0 | 0 | 20 | 20 |
| dates-chiffres-adresses | 2 | 1 | 2 | 0 | 0 | 12.5 | 12.5 |
| lignes-et-liste | 2 | 2 | 2 | 0 | 0 | 10 | 10 |
| sans-faute-long | 0 | 0 | 0 | 0 | 0 | 20 | 20 |
| recit | 4 | 3 | 4 | 1 | 0 | 15.7 | 14.3 |

### Fautes de référence : qui les voit

|  | Fautes |
| --- | ---: |
| Vues par les deux moteurs | 75 |
| — dont avec au moins une règle commune | 75 (100 %) |
| Vues seulement par reference (perdues) | 0 |
| Vues seulement par experimental (gagnées) | 8 |
| Vues par aucun | 9 |

**Gagnées (vues seulement par experimental)**

- courriel-pro : « prévus » → « prévu » (GRM_MOTS_INVARIABLES)
- courriel-pro : « malgré » → « bien » (GRM_LOC_DIVERS)
- courriel-pro : « pris » → « prie » (GRM_LOC_DIVERS)
- typographie : « chère » → « cher » (GRM_ATTRIBUT_DE_CA)
- majuscules : « paris » → « Paris » (GRM_MAJ_GEOGRAPHIE)
- majuscules : « jean » → « Jean » (GRM_MAJ_GEOGRAPHIE)
- dates-chiffres-adresses : « pomme » → « pommes » (GRM_COLLECTIF_DE_NOM_SING)
- recit : « quelques un » → « quelques-uns » (GRM_TU_MOTS_COMPOSES)

### Règles les plus déclenchées (corpus, détections brutes)

- **reference** (49 règles distinctes) : ACCORD_R_PERS_VERBE ×8, D_N ×6, R_VAVOIR_VINF ×5, COMMA_PARENTHESIS_WHITESPACE ×5, TIRET ×5, AGREEMENT_POSTPONED_ADJ ×4, ETRE_VPPA_OU_ADJ ×3, ACCORD_SUJET_VERBE ×3, QUE_AVOIR ×3, A_ACCENT ×3, A_A_ACCENT2 ×3, SA_CA_SE ×3
- **experimental** (55 règles distinctes) : ACCORD_R_PERS_VERBE ×8, D_N ×6, R_VAVOIR_VINF ×5, COMMA_PARENTHESIS_WHITESPACE ×5, TIRET ×5, AGREEMENT_POSTPONED_ADJ ×4, ETRE_VPPA_OU_ADJ ×3, ACCORD_SUJET_VERBE ×3, QUE_AVOIR ×3, A_ACCENT ×3, A_A_ACCENT2 ×3, SA_CA_SE ×3

Types de détection (`issueType`, dont dépend ce qui compte dans la note) : reference : uncategorized ×75, typographical ×13, whitespace ×8, misspelling ×3 ; experimental : uncategorized ×75, typographical ×15, whitespace ×8, grammar ×5, misspelling ×4.
Détections qui compteraient dans la note : reference 78/99, experimental 84/107.

### Fidélité des détections

|  | v0.3.0 (ltjs) | Expérimental (Rust) |
| --- | ---: | ---: |
| Longueur moyenne du passage signalé (caractères) | 5.6 | 5.7 |
| Détections sans suggestion | 0/99 | 0/107 |

Sur les 107 détections de experimental, 99 portent la même règle qu'une détection de reference au même endroit ; 99 signalent exactement le même passage.

### Bruit sur les textes sans faute

- **reference** : 0 détection(s)
- **experimental** : 0 détection(s)

## Exemples des règles de LanguageTool

Échantillon de 1000 phrases fautives (passage marqué) et 1000 phrases correctes, tirées des fichiers de règles.

|  | v0.3.0 (ltjs) | Expérimental (Rust) |
| --- | ---: | ---: |
| Faute marquée détectée | 893 (89 %) | 892 (89 %) |
| — avec la règle attendue | 798 (80 %) | 795 (80 %) |
| Phrase correcte laissée sans détection | 667 (67 %) | 697 (70 %) |

## Performances du moteur (dans le processus du serveur)

|  | v0.3.0 (ltjs) | Expérimental (Rust) | Gain |
| --- | ---: | ---: | ---: |
| Chargement (premier contrôle) | 4512 ms | 579 ms | ×7.8 |
| Contrôle à chaud, 4 mots (médiane) | 13.59 ms | 1.47 ms | ×9.2 |
| Contrôle à chaud, 160 mots (médiane) | 213.12 ms | 58.86 ms | ×3.6 |
| Contrôle à chaud, 906 mots (médiane) | 1020.3 ms | 294.34 ms | ×3.5 |
| Contrôle à chaud, 1085 mots (médiane) | 1356.73 ms | 311.93 ms | ×4.3 |
| Phrase isolée (moyenne sur les exemples) | 15.27 ms | 6 ms | ×2.5 |
| Mémoire ajoutée par le moteur (après le corpus) | 989 Mo | 253 Mo | ×3.9 |

## Performances du serveur, de bout en bout (POST /api/check)

|  | v0.3.0 (ltjs) | Expérimental (Rust) | Gain |
| --- | ---: | ---: | ---: |
| Démarrage → premier contrôle servi | 4807 ms | 696 ms | ×6.9 |
| Latence, 4 mots (médiane / p95) | 30.23 / 43.39 ms | 2.24 / 3.63 ms | ×13.5 |
| Latence, 160 mots (médiane / p95) | 240.96 / 306.62 ms | 45.34 / 66.96 ms | ×5.3 |
| Latence, 906 mots (médiane / p95) | 1206.11 / 1545.49 ms | 288.2 / 376.69 ms | ×4.2 |
| Latence, 1085 mots (médiane / p95) | 1218.24 / 1363.31 ms | 325.47 / 449.11 ms | ×3.7 |
| Débit, 16 clients (160 mots) | 4.8 req/s | 18.7 req/s | ×3.9 |
| Mémoire du serveur au repos | 680 Mo | 266 Mo | ×2.6 |
| Mémoire du serveur après la charge | 1087 Mo | 292 Mo | ×3.7 |

## Application de bureau

| | v0.3.0 (Worker ltjs, Chromium) | Expérimental (application réelle, WebKitGTK) |
| --- | ---: | ---: |
| Chargement du correcteur | 3 566 ms | 657 ms |
| Premier contrôle rendu, depuis le lancement de la page | 4 096 ms | 1 146 ms |
| Contrôle à chaud (médiane) | 127 ms | 59 ms |
| Charge utile du correcteur, brute | 16,2 Mo (Worker + archive) | 15,1 Mio (données) |
| Paquet `.deb` | 8,05 Mio | 8,76 Mio |

Les chiffres de la v0.3.0 sont ceux de la première comparaison (son contrôle dans Chromium,
`mesures/bureau-reference-chromium.json`), non refaits ; ceux de l'expérimental viennent de
l'autotest de l'application construite ici (`mesures/bureau-experimental-autotest.json`).

Le moteur est compilé dans l'application en `opt-level = "s"` (taille) : il y est un peu plus
lent que dans le serveur (`opt-level = 3`), 59 ms contre 45 ms sur le texte de 160 mots.

La garde de taille du `.deb`, relevée à 20 Mio pour la première version expérimentale
(15,35 Mio), est ramenée à 12 Mio, sa valeur de la v0.3.0.

## Revérification (intégration du lot v0.4.0, révision `db00af6`)

Même machine, mêmes scripts (`scripts/comparaison/`), moteur reconstruit par
`npm run build:moteur` à la révision épinglée. Détections du corpus et des 2 000 exemples
identiques à celles de la mesure ci-dessus.

| | Rapport (`77488bd`) | Revérifié (`db00af6`) |
| --- | ---: | ---: |
| Fautes du corpus vues par le moteur | 83 sur 92 | 83 sur 92 |
| Modifications classées dans l'application | 89 (97 %) | 89 (97 %) |
| Contrôle à chaud, 160 mots (moteur, médiane) | 58,9 ms | 37,0 ms |
| Contrôle à chaud, 160 mots (serveur, médiane / p95) | 45,3 / 67,0 ms | 37,7 / 56,4 ms |
| Démarrage du serveur jusqu'au premier contrôle | 696 ms | 624 ms (590 à 638) |
| Débit du serveur, 16 clients | 18,7 req/s | 24,2 req/s |
| Mémoire du serveur au repos / après la charge | 266 / 292 Mo | 265 / 290 Mo |
| Paquet `.deb` du bureau | 8,76 Mio | 8,76 Mio |
| Chargement du correcteur dans le bureau (autotest) | 657 ms | 648 ms |
| Contrôle à chaud dans le bureau (médiane) | 59 ms | 44 ms |
| Mémoire de l'application de bureau, au repos | — | 621 Mo (RSS), 452 Mo (PSS) |
| Mémoire de l'application de bureau, après 10 corrections | — | 668 Mo (RSS), 485 Mo (PSS) |

Mémoire du bureau : `.deb` extrait et lancé dans sa disposition installée
(`/usr/lib/Grammaria/moteur/`), sous Xvfb, contre le faux modèle ; somme des processus
`grammaria`, `WebKitWebProcess` et `WebKitNetworkProcess` (dont `grammaria` : 402 Mo RSS,
le moteur et ses données compris). La v0.3.0 était mesurée à environ 0,9 Go sous Linux.

## Licences

Le moteur `grammaria-rc` est sous LGPL 2.1 ou ultérieure, la licence de LanguageTool dont il
porte le code ; les mentions des projets tiers sont dans son fichier `THIRD_PARTY_LICENSES.md`.
Grammaria est sous GPL 3.0 ou ultérieure, avec laquelle cette licence est compatible.

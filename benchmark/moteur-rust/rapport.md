# Moteur Rust `grammaria-rc` à la place de ltjs : gains et pertes

Comparaison de la version expérimentale de Grammaria (branche `claude/sleepy-tesla-re29jm`,
moteur Rust `grammaria-rc` révision `f55cf16`) avec la dernière version publiée, **v0.3.0**
(portage JavaScript de LanguageTool, `@valueerror/ltjs-core` 0.3.0).

## En bref

Le moteur Rust démarre et tient en mémoire beaucoup mieux, mais **il ne peut pas remplacer ltjs
en l'état** : il voit moitié moins de fautes, et ses contrôles à chaud sont deux à cinq fois
plus lents.

| | v0.3.0 (ltjs) | Expérimental (Rust) | |
| --- | ---: | ---: | --- |
| Fautes du corpus vues par le moteur | 82 % | 42 % | perte |
| Modifications classées dans l'application | 91 % | 80 % | perte |
| Fautes marquées des exemples de LanguageTool détectées | 89 % | 50 % | perte |
| Détections sur les textes sans faute | 0 | 4 | perte |
| Orthographe (`FR_SPELLING_RULE`, « mots pièges ») | oui | non | perte |
| Contrôle à chaud, 160 mots (serveur) | 199 ms | 565 ms | perte (×2,8) |
| Débit du serveur, 16 clients | 6,4 req/s | 1,7 req/s | perte (×3,8) |
| Paquet `.deb` du bureau | 8,05 Mio | 15,35 Mio | perte (+7,3 Mio) |
| Démarrage du serveur jusqu'au premier contrôle | 4,3 s | 0,23 s | gain (×19) |
| Chargement du correcteur dans le bureau | 3,6 s | 0,09 s | gain (×39) |
| Mémoire du serveur après la charge | 1 178 Mo | 117 Mo | gain (×10) |
| Code du correcteur côté bureau | Worker, archive, lecteur d'archive | 2 commandes Rust | gain |

## Ce qui a été construit

- **`grammaria-rc`** (branche `claude/sleepy-tesla-re29jm`, à jour de `main`) : une API de
  bibliothèque (`grammaria::api::Engine`), un mode `grammaria serve` (processus gardé ouvert,
  positions en unités UTF-16 comme en JavaScript), et la correction d'un plantage (voir plus
  bas).
- **Bureau** : le moteur est lié au backend Rust (`src-tauri/src/correcteur.rs`, dépendance
  `grammaria_rc` épinglée par révision). Deux commandes Tauri, `correcteur_prechauffer` et
  `correcteur_controler`. Le Worker de la WebView, l'archive `fr.pack`, son lecteur et le
  contrôle dans Chromium sont supprimés (environ 1 100 lignes supprimées, avec le Worker du serveur). Les données du moteur sont des
  ressources de l'application.
- **Serveur** : il n'a pas de code Rust (Bun). `grammar.ts` lance `moteur/grammaria serve` une
  fois et lui parle par ses entrées et sorties standard ; le moteur est relancé s'il tombe.
- Les paquets `@valueerror/ltjs-core` et `@valueerror/ltjs-lang-fr` ne sont plus des
  dépendances. `npm run build:moteur` compile le moteur et ses données dans `moteur/`.

Vérifié ici : format, lint et types ; 638 tests unitaires ; 144 tests Bun ; tests Rust du
correcteur et 87 tests Rust du backend ; **build réel de l'application de bureau et son autotest complet** sous WebKitGTK
(25 critères tenus, détections identiques à celles du serveur sur 20 textes sur 20).

Non vérifié : l'image Docker (pas de démon Docker ici), le build Windows, les workflows GitHub
modifiés (jamais exécutés), la documentation du site (`docs/`, non mise à jour).

## Méthode

- Machine : 4 cœurs Intel Xeon 2,1 GHz, 15 Go, Linux ; Bun 1.4.4, Rust 1.97. Chaque version est
  mesurée seule, machine au repos.
- Les deux versions exposent la même classe `GrammarChecker` et la même route `POST /api/check` :
  elles sont mesurées par les mêmes scripts (`scripts/comparaison/`).
- **Qualité.** L'application ne retient une détection que si le modèle a corrigé le passage.
  Pour comparer à réponse du modèle égale, chaque texte du corpus du correcteur
  (`tests/fixtures/correcteur/corpus.ts`) a un corrigé écrit à la main
  (`scripts/comparaison/corriges.ts`). Les « fautes de référence » sont les modifications de
  ce corrigé, hors ponctuation : 92 fautes sur 18 textes. Le résultat « dans l'application »
  est celui de `analyze()`, le code de production.
- Second jeu, plus large : 1 000 phrases fautives et 1 000 phrases correctes tirées des exemples
  des fichiers de règles de LanguageTool (environ un exemple sur huit).
- **Limites.** Corrigés d'une seule main, sans vrai modèle de langage : un modèle reformule
  davantage. Corpus court (940 mots, hors textes composés). La référence du bureau est mesurée dans Chromium (le
  contrôle de la v0.3.0), l'expérimental dans la vraie application sous WebKitGTK.

## Performances de l'application de bureau

| | v0.3.0 (Worker ltjs, Chromium) | Expérimental (application réelle) |
| --- | ---: | ---: |
| Chargement du correcteur | 3 566 ms | 92 ms |
| Premier contrôle rendu, depuis le lancement de la page | 4 096 ms | 1 020 ms |
| Contrôle à chaud, 160 mots (médiane) | 127 ms | 695 ms |
| Mémoire ajoutée par le correcteur | +374 Mo (processus de rendu) | non mesurée (moteur seul : ≈ 80 Mo) |
| Charge utile du correcteur, brute | 16,2 Mo (Worker + archive) | 35,9 Mo (données) |
| Paquet `.deb` (v0.3.0 : valeur notée dans `build-desktop.yml`) | 8,05 Mio | 15,35 Mio |

Le contrôle à chaud est plus lent dans l'application (695 ms) que dans le serveur (556 ms) :
`src-tauri` compile en `opt-level = "s"` (taille), le moteur seul en `opt-level = 3`.

Le `.deb` dépasse la garde de taille de la v0.3.0 (12 Mio). Elle est relevée à 20 Mio dans
`build-desktop.yml` pour cette branche.

## Pourquoi le moteur Rust est lent à chaud

Son coût croît avec le nombre de mots, pas avec le nombre de phrases :

| Une phrase de | ltjs | Rust |
| --- | ---: | ---: |
| 7 mots | 9 ms | 26 ms |
| 14 mots | 9 ms | 52 ms |
| 35 mots | 18 ms | 127 ms |
| 75 mots | 38 ms | 320 ms |

Soit environ 4 ms par mot contre 0,5 à 1,2 ms pour ltjs. Sur 40 piles d'appels relevées pendant
un contrôle, 20 sont dans `tagregex::Prog::full_match` (le moteur d'expressions régulières
maison, appelé par `TokenPattern::matches_token`), et 30 contiennent une allocation ou une
libération de mémoire. C'est un échantillon, pas un profil complet, mais la piste est nette :
le filtrage des motifs par expression régulière, avec des allocations à chaque essai.

Le parallélisme ajouté sur `main` ne joue qu'à partir de 40 phrases : il fait passer le texte de
906 mots de 3,6 s à 2,1 s, sans effet sur un texte courant.

La conversion du lexique (`grammaria-build`) a pris 14 minutes ici, contre 7 annoncées dans le
README du moteur. Elle n'est refaite que si le moteur change (cache en CI).

## Pourquoi la qualité baisse

1. **Pas de correcteur orthographique.** `FR_SPELLING_RULE` n'existe pas dans le moteur Rust.
   L'écran Progression en tire les « mots pièges » : ils resteraient vides.
2. **Des familles de règles absentes.** Homophones (`A_ACCENT`, `SA_CA_SE`, `ON_ONT`, `SE_CE`),
   accord du participe (`QUE_AVOIR`), adjectif postposé (`AGREEMENT_POSTPONED_ADJ`), accord
   sujet-verbe au pluriel : 38 fautes du corpus vues par ltjs ne le sont plus, 2 sont gagnées.
3. **Le passage signalé est trop large.** Le moteur Rust signale souvent tout le motif de la
   règle (« Il a manger ») là où ltjs signale le mot marqué (« manger ») : 13,2 caractères en
   moyenne contre 5,6. Sur 36 détections portant la même règle au même endroit, 8 seulement
   désignent le même passage. Or l'application enregistre ce passage comme mot fautif.
4. **Pas de type de détection.** `issueType` vaut toujours `uncategorized` : ce qui compte ou
   non dans la note ne repose plus que sur l'identifiant de catégorie.
5. **25 détections sur 60 n'ont aucune suggestion** (0 sur 99 pour ltjs). L'application ne s'en
   sert pas aujourd'hui (c'est le modèle qui corrige).

L'application amortit une partie de la perte : ses fiches de confusion (26 modifications) ne
dépendent pas du moteur, et le repli « accord » classe 23 modifications au lieu de 8. Mais une
faute classée par ce repli porte la règle générique `ACCORD` au lieu d'une règle précise : le
suivi des fautes récurrentes, qui est le cœur de Grammaria, perd en finesse.

## Défauts trouvés en route

- **Plantage du moteur.** « Les enfants était content de leur vacances. » faisait tomber le
  processus (indice hors bornes dans le désambiguïsateur : les lemmes étaient vidés sans les
  étiquettes correspondantes). 3 des 20 textes du corpus et 5 des 800 premiers exemples de
  LanguageTool étaient touchés. Corrigé sur la branche de `grammaria-rc`, avec un test ; les
  évaluations du moteur sont inchangées (accord des étiquettes 88,3 %, 16 cas de régression
  identiques sur 16).
- La branche de travail partait de `261a5c6`, cinq commits derrière `main`. `main` a été
  fusionné avant les mesures.

## Ce qu'il faudrait au moteur pour remplacer ltjs

Par ordre d'effet sur l'application :

1. signaler le passage marqué (`<marker>`) plutôt que tout le motif ;
2. un correcteur orthographique (le lexique est déjà là) ;
3. les règles d'homophones et d'accord qui manquent ;
4. `issueType` tiré du type de la catégorie ou de la règle ;
5. le coût par mot du filtrage des motifs.

## Reproduire

```bash
npm run build:moteur
```

```bash
bun scripts/comparaison/mesurer-moteur.ts --racine <arbre v0.3.0> --nom "v0.3.0 (ltjs)" --sortie ref.json --exemples ../grammaria-rc/eval/lt_examples_fr.json
```

```bash
bun scripts/comparaison/mesurer-moteur.ts --racine . --nom "expérimental (Rust)" --sortie exp.json --exemples ../grammaria-rc/eval/lt_examples_fr.json
```

```bash
bun scripts/comparaison/rapport.ts --reference ref.json --experimental exp.json
```

`mesurer-serveur.ts` prend les mêmes options `--racine`, `--nom` et `--sortie`. Les mesures
brutes de ce rapport sont dans `mesures/`.

---

# Résultats détaillés

## Qualité sur le corpus du correcteur

18 textes, 92 fautes de référence (modifications du corrigé, hors ponctuation).

|  | v0.3.0 (ltjs) | expérimental (Rust) |
| --- | ---: | ---: |
| Détections brutes | 99 | 60 |
| Fautes de référence couvertes par une détection | 75 (82 %) | 39 (42 %) |
| Détections hors de toute modification (écartées) | 13 (13 %) | 17 (28 %) |
| Dans l'application : modifications classées | 84 (91 %) | 74 (80 %) |
| — par une fiche de confusion | 26 | 26 |
| — par une règle du moteur | 50 | 25 |
| — par le repli « accord » | 8 | 23 |
| Modifications non classées | 8 | 18 |
| Fautes comptées dans la note | 80 | 75 |

### Par texte

| Texte | Fautes | Couvertes v0.3.0 (ltjs) | Couvertes expérimental (Rust) | Non classées v0.3.0 (ltjs) | Non classées expérimental (Rust) | Note v0.3.0 (ltjs) | Note expérimental (Rust) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| marche-160-mots | 15 | 15 | 8 | 0 | 3 | 2.5 | 3.8 |
| courriel-pro | 14 | 10 | 5 | 2 | 2 | 0 | 0 |
| accords | 12 | 10 | 5 | 0 | 1 | 0 | 0 |
| homophones | 12 | 10 | 5 | 1 | 1 | 0 | 0 |
| sans-faute | 0 | 0 | 0 | 0 | 0 | 20 | 20 |
| typographie | 2 | 1 | 0 | 1 | 2 | 20 | 20 |
| conjugaison | 10 | 9 | 7 | 0 | 1 | 0 | 0 |
| court | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| vide | 0 | 0 | 0 | 0 | 0 | — | — |
| blancs | 0 | 0 | 0 | 0 | 0 | — | — |
| apostrophes-typographiques | 1 | 1 | 1 | 0 | 0 | 12.6 | 12.6 |
| emojis | 4 | 4 | 1 | 0 | 0 | 0 | 0 |
| majuscules | 13 | 8 | 3 | 3 | 7 | 0 | 0 |
| ponctuation | 0 | 0 | 0 | 0 | 0 | 20 | 20 |
| dates-chiffres-adresses | 2 | 1 | 0 | 0 | 0 | 12.5 | 12.5 |
| lignes-et-liste | 2 | 2 | 1 | 0 | 1 | 10 | 10 |
| sans-faute-long | 0 | 0 | 0 | 0 | 0 | 20 | 20 |
| recit | 4 | 3 | 2 | 1 | 0 | 15.7 | 14.3 |

### Fautes de référence : qui les voit

|  | Fautes |
| --- | ---: |
| Vues par les deux moteurs | 37 |
| — dont avec au moins une règle commune | 30 (81 %) |
| Vues seulement par v0.3.0 (ltjs) (perdues) | 38 |
| Vues seulement par expérimental (Rust) (gagnées) | 2 |
| Vues par aucun | 15 |

**Perdues (vues seulement par v0.3.0 (ltjs))**

- marche-160-mots : « était » → « étaient » (ACCORD_SUJET_VERBE)
- marche-160-mots : « soeur » → « sœur » (OE)
- marche-160-mots : « a » → « à » (A_INFINITIF)
- marche-160-mots : « avions » → « n'avions » (P_V_PAS)
- marche-160-mots : « commandé » → « commandés » (QUE_AVOIR)
- marche-160-mots : « comprenais » → « comprenait » (ACCORD_R_PERS_VERBE)
- marche-160-mots : « rit » → « ri » (AUX_AVOIR_VCONJ)
- courriel-pro : « envoi » → « envoie » (PRONSUJ_NONVERBE)
- courriel-pro : « annulés » → « annulé » (QUE_AVOIR)
- courriel-pro : « a » → « à » (A_A_ACCENT2)
- courriel-pro : « renseignements » → « renseignement » (D_N)
- courriel-pro : « distingués » → « distinguées » (AGREEMENT_POSTPONED_ADJ)
- accords : « était » → « étaient » (ACCORD_SUJET_VERBE)
- accords : « leur » → « leurs » (D_N)
- accords : « Leur » → « Leurs » (D_N)
- accords : « vu » → « vue » (QUE_AVOIR)
- accords : « bleu » → « bleue » (AGREEMENT_POSTPONED_ADJ)
- homophones : « Sa » → « Ça » (SA_CA_SE)
- homophones : « Ont » → « On » (ON_ONT)
- homophones : « a » → « à » (A_ACCENT)
- homophones : « se » → « ce » (SE_CE)
- homophones : « sa » → « ça » (SA_CA_SE)
- typographie : « au » → « Au » (UPPERCASE_SENTENCE_START)
- conjugaison : «  » → « ne » (P_V_PAS)
- conjugaison : « c'est » → « s'est » (CE_SE)
- emojis : « arrivé » → « arrivées » (ETRE_VPPA_OU_ADJ)
- emojis : « leur » → « leurs » (D_N)
- emojis : « sa » → « ça » (SA_CA_SE)
- majuscules : « je » → « Je » (UPPERCASE_SENTENCE_START)
- majuscules : « a » → « à » (A_A_ACCENT2)
- majuscules : « LEUR » → « LEURS » (D_N)
- majuscules : « Etat » → « État » (FR_SPELLING_RULE)
- majuscules : « Ecole » → « École » (FR_SPELLING_RULE)
- majuscules : « Eglise » → « Église » (FR_SPELLING_RULE)
- dates-chiffres-adresses : « chat » → « chats » (AGREEMENT_NUMERAL_PLURAL)
- lignes-et-liste : « oeufs » → « œufs » (OE)
- recit : « a » → « à » (A_A_ACCENT2)
- recit : « couvert » → « couverts » (AGREEMENT_POSTPONED_ADJ)

**Gagnées (vues seulement par expérimental (Rust))**

- majuscules : « ÉTAIT » → « ÉTAIENT » (ACCORD_SUJET_VERBE)
- recit : « quelques un » → « quelques-uns » (D_N)

### Règles les plus déclenchées (corpus, détections brutes)

- **v0.3.0 (ltjs)** (49 règles distinctes) : ACCORD_R_PERS_VERBE ×8, D_N ×6, R_VAVOIR_VINF ×5, COMMA_PARENTHESIS_WHITESPACE ×5, TIRET ×5, AGREEMENT_POSTPONED_ADJ ×4, ETRE_VPPA_OU_ADJ ×3, ACCORD_SUJET_VERBE ×3, QUE_AVOIR ×3, A_ACCENT ×3, A_A_ACCENT2 ×3, SA_CA_SE ×3
- **expérimental (Rust)** (40 règles distinctes) : ACCORD_R_PERS_VERBE ×6, R_VAVOIR_VINF ×5, ESPACE_UNITES ×3, D_N ×3, TIRET ×3, NOUS_SOMMES ×2, SUBJ_LOCU ×2, MOIS ×2, ACCORD_SUJET_VERBE ×2, DEUX_POINTS_ESPACE ×2, ETRE_VPPA_OU_ADJ ×1, D_N_E_OU_E ×1

Types de détection (`issueType`, dont dépend ce qui compte dans la note) : v0.3.0 (ltjs) : uncategorized ×75, typographical ×13, whitespace ×8, misspelling ×3 ; expérimental (Rust) : uncategorized ×60.
Détections qui compteraient dans la note : v0.3.0 (ltjs) 78/99, expérimental (Rust) 50/60.

### Fidélité des détections

|  | v0.3.0 (ltjs) | expérimental (Rust) |
| --- | ---: | ---: |
| Longueur moyenne du passage signalé (caractères) | 5.6 | 13.2 |
| Détections sans suggestion | 0/99 | 25/60 |

Sur les 60 détections de expérimental (Rust), 36 portent la même règle qu'une détection de v0.3.0 (ltjs) au même endroit ; 8 signalent exactement le même passage.

### Bruit sur les textes sans faute

- **v0.3.0 (ltjs)** : 0 détection(s)
- **expérimental (Rust)** : 4 détection(s) — ADJ_GN « Les lecteurs y découvrent des salles plus lumineuses, des fauteuils » ; DEUX_POINTS_ESPACE « : la » ; EST_CE « est désormais ouverte le dimanche matin, ce » ; ESPACE_UNITES « doublé »

## Exemples des règles de LanguageTool

Échantillon de 1000 phrases fautives (passage marqué) et 1000 phrases correctes, tirées des fichiers de règles.

|  | v0.3.0 (ltjs) | expérimental (Rust) |
| --- | ---: | ---: |
| Faute marquée détectée | 893 (89 %) | 498 (50 %) |
| — avec la règle attendue | 798 (80 %) | 410 (41 %) |
| Phrase correcte laissée sans détection | 667 (67 %) | 686 (69 %) |

## Performances du moteur (dans le processus du serveur)

|  | v0.3.0 (ltjs) | expérimental (Rust) | Gain |
| --- | ---: | ---: | ---: |
| Chargement (premier contrôle) | 4226 ms | 121 ms | ×34.9 |
| Contrôle à chaud, 4 mots (médiane) | 12.57 ms | 18.3 ms | ×0.7 |
| Contrôle à chaud, 160 mots (médiane) | 190.69 ms | 556.34 ms | ×0.3 |
| Contrôle à chaud, 906 mots (médiane) | 985.46 ms | 2141.81 ms | ×0.5 |
| Contrôle à chaud, 1085 mots (médiane) | 1010.31 ms | 2611.61 ms | ×0.4 |
| Phrase isolée (moyenne sur les exemples) | 13.21 ms | 28.82 ms | ×0.5 |
| Mémoire ajoutée par le moteur (après le corpus) | 1053 Mo | 77 Mo | ×13.7 |

## Performances du serveur, de bout en bout (POST /api/check)

|  | v0.3.0 (ltjs) | expérimental (Rust) | Gain |
| --- | ---: | ---: | ---: |
| Démarrage → premier contrôle servi | 4313 ms | 230 ms | ×18.8 |
| Latence, 4 mots (médiane / p95) | 30.24 / 48.22 ms | 18.06 / 20.89 ms | ×1.7 |
| Latence, 160 mots (médiane / p95) | 198.73 / 294.44 ms | 565.31 / 650.78 ms | ×0.4 |
| Latence, 906 mots (médiane / p95) | 954.06 / 1067.93 ms | 1924.28 / 2103.64 ms | ×0.5 |
| Latence, 1085 mots (médiane / p95) | 895.8 / 1000.69 ms | 2526.01 / 2676.92 ms | ×0.4 |
| Débit, 16 clients (160 mots) | 6.4 req/s | 1.7 req/s | ×0.3 |
| Mémoire du serveur au repos | 691 Mo | 102 Mo | ×6.7 |
| Mémoire du serveur après la charge | 1178 Mo | 117 Mo | ×10.0 |


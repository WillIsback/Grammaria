# Grammaria

Correcteur de français qui corrige aussi vite qu'avant, mais observe vos fautes pour vous aider à ne plus les refaire. Issu d'[ai_corrector](https://github.com/WillIsback/ai_corrector).

## Principe

1. **Correction instantanée.** Le LLM renvoie uniquement le texte corrigé, affiché au fil de la génération. Le bouton « Copier » est disponible tout de suite.
2. **Analyse sans coût pour le LLM.** Les modifications sont calculées par diff entre le texte d'origine et le texte corrigé. LanguageTool analyse le texte d'origine en parallèle.
3. **Croisement.** Une détection LanguageTool n'est retenue que si le LLM a réellement modifié le passage, ce qui écarte les faux positifs. Les confusions courantes (a/à, on/ont, ces/ses, -er/-é…) sont reconnues directement dans le diff et accompagnées d'une fiche « remplacez par X, car Y ».
4. **Journal.** Chaque faute retenue est enregistrée dans une base SQLite locale : règle, mot fautif, correction et phrase concernée. Le texte complet n'est jamais conservé.
5. **Note.** Une note sur 20 est calculée sur la densité de fautes (2 points par faute pour 100 mots). La moyenne sur 7 jours cumule fautes et mots avant le calcul.

La typographie, la ponctuation et le style sont affichés mais n'entrent pas dans la note. Une modification du LLM que rien n'explique est affichée « Non classé » et n'est pas comptée.

### Feuille de route

- **Phase 1 (cette version)** : socle décrit ci-dessus, sans événement pédagogique.
- **Phase 2** : cycle de vie des règles (observée, signalée, travaillée, acquise) et interventions sur le bouton « Copier », réglées sur les données du journal.

## Architecture

```
Navigateur
  ├─ POST /v1/chat/completions → Bun → LLM (API compatible OpenAI, streaming)
  ├─ POST /api/lt/v2/check     → Bun → LanguageTool
  └─ POST /api/analyze         → Bun : diff + croisement + journal SQLite

GET    /api/journal?days=7   bilan : note, règles et mots les plus fréquents
DELETE /api/journal          efface tout le journal
```

| Fichier | Rôle |
|---|---|
| `server.ts` | Serveur Bun : fichiers statiques, proxys, analyse, journal |
| `journal.ts` | Journal SQLite (`bun:sqlite`) |
| `src/analysis/diff.ts` | Diff au niveau du mot |
| `src/analysis/fiches.ts` | Fiches de règles et détection des confusions |
| `src/analysis/analyze.ts` | Croisement diff / LanguageTool |
| `src/analysis/score.ts` | Note sur 20 |

## Pré-requis

- Bun (serveur) et Node.js 20+ (build)
- Un fournisseur LLM compatible avec l'API OpenAI (vLLM, SGLang, Ollama…)
- LanguageTool (port 3002). Sans lui, la correction fonctionne mais seules les confusions des fiches sont classées.

## Configuration

Fichier `.env` à la racine (voir `.env.example`) :

```env
PORT=25000
LLM_TARGET=http://localhost:11434
LLM_API_KEY=sk-...
LLM_MODEL_NAME=llama3
LLM_DISABLE_THINKING=true
LT_TARGET=http://localhost:3002
JOURNAL_PATH=./data/grammaria.db
CORS_ORIGIN=https://mondomaine.com
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006
```

En Docker, le journal est écrit dans `/app/data` : montez un volume pour le conserver.

## Démarrage

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

Accès : http://localhost:25000

En développement, lancez `bun run server.ts` dans un terminal et `npm run dev` dans un autre (Vite sur http://localhost:25001).

## Tests

```bash
npm run test:run
```

```bash
npm run test:journal
```

Le second lance les tests du journal avec Bun, car `bun:sqlite` n'est pas disponible sous vitest.

## Limites connues

- Le classement des catégories LanguageTool (ce qui compte ou non dans la note) repose sur `issueType` et sur l'identifiant de catégorie. Il reste à ajuster sur des réponses réelles du serveur LanguageTool français.
- Le dossier `docs/` et le dossier `eval/` décrivent encore ai_corrector.

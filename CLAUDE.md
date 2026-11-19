@AGENTS.md

## Méthode de travail

Au début de chaque session, charger le skill `semver-batch-workflow`
(`.claude/skills/semver-batch-workflow/SKILL.md`) et suivre ce workflow : issues typées
avec impact semver, lots de version (patch → minor → major), branche de lot et
sous-branches par issue, une seule PR par lot vers `main`, alpha et « Réserves à lever »
avant le merge, release calculée depuis les commits.

Le skill est une copie de `skills/semver-batch-workflow/` du dépôt
[WillIsback/agent-skills](https://github.com/WillIsback/agent-skills), qui fait foi :
le mettre à jour depuis cette source plutôt que de le modifier ici.

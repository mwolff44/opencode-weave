# Weave pour PI : Analyse critique face à la philosophie de PI

## Ce que Mario Zechner pense des sub-agents

Mario est **explicitement et délibérément opposé** aux sub-agents intégrés. Sa position est documentée à trois niveaux :

### 1. README de PI — Philosophy

> **No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way.

### 2. Blog post — Section "No sub-agents"

Ses arguments principaux :

- **Obscurité** : Les sub-agents sont des "black boxes within a black boxes". Pas de visibilité, pas de steerability.
- **Le problème est mal posé** : Si tu as besoin d'un sub-agent pour rassembler du contexte, c'est que tu n'as pas planifié. Il faut faire la collecte de contexte **avant**, dans une session dédiée, créer un artifact, puis l'utiliser dans une session fraîche.
- **Les modèles sont mauvais pour trouver tout le contexte** : Les agents ratent des choses. Utiliser des sub-agents en parallèle aggrave ce problème.
- **Le parallélisme est un anti-pattern** : *"Spawning multiple sub-agents to implement various features in parallel is an anti-pattern in my book and doesn't work, unless you don't care if your codebase devolves into a pile of garbage."*
- **Son cas d'usage unique** : La revue de code. Il lance un `pi --print` via bash avec un prompt de revue.

### 3. L'exemple subagent qu'il fournit

Mario fournit un exemple `subagent/` dans les extensions PI, mais ce n'est **pas** une fonctionnalité intégrée. C'est un **exemple** de ce qu'une extension peut faire. Il documente explicitement :

- Les agents sont des fichiers `.md` avec du frontmatter
- L'exécution se fait via `spawn("pi --mode json")`
- C'est l'extension qui gère la découverte, le routing, la parallélisation

---

## Ce que ça signifie pour Weave

Weave tente de résoudre des problèmes réels. La question est : **Mario a-t-il raison que ces problèmes sont mieux résolus autrement ?**

### Les problèmes que Weave résout

| Problème Weave | Solution de Mario | Qui a raison ? |
|---|---|---|
| **Context pollution** — un agent unique accumule trop de contexte | Sessions séparées + artifacts | **Mario** — une session par phase est plus simple et plus fiable |
| **Tool scoping** — empêcher l'écriture lors de l'exploration | `--tools read,grep,find` en CLI | **Égal** — Weave le fait via `--tools` aussi, mais l'ajoute dans une couche de config complexe |
| **Plan → Execute** workflow | Fichiers plan + sessions manuelles | **Mario** — écrire un plan dans un fichier, puis l'exécuter dans une session fraîche, est plus simple et donne plus de contrôle |
| **Parallel exploration** | `pi` dans plusieurs tmux | **Mario** — visibilité totale, interaction directe |
| **Code review par un agent spécialisé** | `pi --print` avec prompt de revue | **Mario** — c'est littéralement son seul cas d'usage sub-agent |
| **Per-agent model routing** | Changer de modèle manuellement (`/model`) | **Dépend** — Weave automatise ce que Mario fait manuellement |
| **Persistent state** | Sessions PI (JSONL, branching, compaction) | **Mario** — PI a déjà un système de session sophistiqué avec `/tree`, `/fork`, `/resume` |

### Ce que Mario a vu et que Weave ignore

1. **La qualité du contexte > l'automatisation du routing**. Weave automatise la délégation mais ne résout pas le problème fondamental que les modèles ratent du contexte. La solution de Mario (pré-collecte manuelle + artifact) attaque le vrai problème.

2. **La visibilité est non-négociable**. Weave lance des `pi --mode json` en arrière-plan. L'utilisateur ne voit que le résultat final. Mario insiste sur le fait que pouvoir observer et intervenir est essentiel.

3. **La complexité se paie en tokens et en bugs**. Chaque délégation Weave coûte un process spawn + un context window frais + un system prompt complet. Pour une tâche qu'un agent unique pourrait faire en 3 tours, Weave en dépense 15.

### Ce que Weave fait de vraiment valable

1. **Config pipeline** — Le système de JSONC + merge + overrides est indépendant des sub-agents. Il pourrait être utile comme package PI séparé pour gérer des profils de config par projet.

2. **Hooks** — Le WriteGuard est une bonne idée. Mais Mario dirait : utilise `--tools read,grep` et le problème disparaît à la racine.

3. **Plan checkbox tracking** — C'est la feature la plus utile. Un plan avec `- [ ]` / `- [x]` est un artifact persistant. Ça marche **avec** la philosophie de Mario (create artifact → consume in fresh session).

---

## Conclusion honnête

**Weave pour PI résout un problème que PI a délibérément choisi de ne pas avoir.**

L'architecture de délégation (8 agents, `task` tool, `state.json`, `--mode json` child processes) est un chef-d'œuvre d'ingénierie pour contourner l'absence d'un système natif. Mais Mario a raison sur l'essentiel :

1. La plupart des workflows Weave se font mieux avec des **sessions PI séparées + artifacts**
2. Le **parallélisme d'agents est un anti-pattern** pour la qualité du code
3. La **visibilité** que PI offre nativement (`/tree`, `/fork`, sessions JSONL) est perdue quand on wrappe tout dans des child processes

### Ce qui vaut la peine de garder

Si je devais refactorer, je garderais :

- **Le plan checkbox tracking** (`- [ ]` → `- [x]`) — c'est un artifact pattern qui colle à la philosophie PI
- **Le config pipeline** — en tant que package indépendant
- **Le skill injection** — PI le fait déjà nativement, mais l'assignation par agent via config est intéressante
- **Les prompt templates** pour les workflows (scout→plan→implement) — remplace les 8 agents par des templates `/scout-and-plan`, `/implement-and-review` comme dans l'exemple subagent de Mario

### Ce que je supprimerais

- Les 8 agents en tant que sub-agents spawnés
- Le `task` tool custom
- `state.json` et le work continuation automatique
- La couche complète de simulation de sub-agents

**En résumé** : Weave est un excellent projet d'ingénierie qui a permis de comprendre en profondeur PI et OpenCode. Mais pour un usage quotidien avec PI, la philosophie de Mario — minimalisme, visibilité, artifacts persistants, sessions séparées — est probablement la bonne.

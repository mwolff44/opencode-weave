# Plan de refactorisation de Weave pour PI

## Objectif

Transformer Weave d'un système de sub-agents simulés en un **package PI minimaliste** qui respecte la philosophie de Mario Zechner : visibilité, artifacts persistants, sessions séparées, pas de boîtes noires.

## Décisions architecturales

| Avant (Weave actuel) | Après (refactorisé) |
|---|---|
| 8 agents spawnés via `pi --mode json` | **0 agent spawné** — PI est l'unique agent |
| `task` tool custom avec modes single/parallel/chain | **Supprimé** — remplacé par des prompt templates + sessions PI |
| `state.json` pour le suivi de plan | **Artifact markdown** — le plan EST l'état (`- [ ]` / `- [x]`) |
| Hooks (WriteGuard, KeywordDetector, etc.) | **Supprimé** — `--tools` en CLI fait le même travail |
| Config pipeline (JSONC, Zod, merge) | **Conservé** — mais simplifié, orienté profils de session |
| Extension TypeScript ~750 lignes | **~200 lignes** — juste le plan tracker + config loader |
| Skill injection per-agent | **Supprimé** — PI gère les skills nativement |
| Analytics (SessionTracker, JSONL) | **Supprimé** — PI a son propre tracking (`/session`, coût affiché) |

---

## Phase A : Prompt templates de workflow (~1h)

**Objectif** : Remplacer les 8 agents par des prompt templates réutilisables.

### Fichiers à créer dans `pi/prompts/`

| Template | Description | Remplace |
|---|---|---|
| `explore.md` | Exploration read-only d'un domaine du code | Thread + scout |
| `plan.md` | Création d'un plan structuré avec checkboxes | Pattern |
| `execute.md` | Exécution d'un plan existant (checkbox tracking) | Tapestry + Shuttle |
| `review.md` | Revue de code structurée | Weft |
| `security.md` | Audit sécurité | Warp |
| `research.md` | Recherche web/docs externe | Spindle |

### Templates détaillés

#### `pi/prompts/explore.md`
```markdown
---
description: Explore le codebase en lecture seule sur un domaine précis
argument-hint: "<domaine ou question>"
---
Explore le codebase pour répondre à : $@

Contraintes :
- Utilise uniquement read, grep, find, ls, bash (lecture seule)
- Ne modifie aucun fichier
- Structure ta sortie ainsi :

## Fichiers pertinents
1. `chemin/vers/fichier.ts` (lignes X-Y) — ce qu'on y trouve

## Code clé
Types, interfaces, fonctions importantes

## Architecture
Comment les pièces s'articulent

## Point de départ
Quel fichier regarder en premier et pourquoi
```

#### `pi/prompts/plan.md`
```markdown
---
description: Crée un plan d'implémentation structuré avec checkboxes
argument-hint: "<description de la feature ou tâche>"
---
Crée un plan d'implémentation pour : $@

Contraintes :
- Explore le codebase d'abord avec read/grep/find pour comprendre le contexte
- Ne modifie aucun fichier existant hors de .weave/plans/
- Sauvegarde le plan dans .weave/plans/<slug>.md

Format du plan :

# <Titre>

## Contexte
Ce qui a été trouvé dans le codebase

## Tâches
- [ ] **1. <verbe> <quoi>** — fichier(s) concerné(s), détail de l'action
- [ ] **2. <verbe> <quoi>** — fichier(s) concerné(s), détail de l'action
- [ ] ...

## Risques
Points d'attention potentiels

Règles :
- Chaque tâche est atomique et vérifiable
- 3-10 tâches par plan (découper si plus)
- Slug en kebab-case dérivé du titre
- Numérotation séquentielle pour le tracking
```

#### `pi/prompts/execute.md`
```markdown
---
description: Exécute un plan existant en cochant les tâches terminées
argument-hint: "[nom-du-plan]"
---
Exécute le plan .weave/plans/$@.md (ou le plan le plus récent si pas d'argument).

Protocole :
1. Lis le plan pour identifier les tâches non cochées (- [ ])
2. Pour chaque tâche non cochée, de la première à la dernière :
   a. Lis les fichiers concernés
   b. Exécute la tâche
   c. Vérifie le résultat (relis le fichier modifié)
   d. Édite le plan pour cocher la tâche (- [x])
3. Quand toutes les tâches sont cochées, fais un résumé

Règles :
- Ne jamais passer à la tâche suivante sans avoir coché la précédente
- Si une tâche échoue, note le problème dans le plan et continue
- Toujours lire un fichier avant de le modifier
```

#### `pi/prompts/review.md`
```markdown
---
description: Revue de code structurée sur des fichiers ou un diff
argument-hint: "<fichiers, répertoire ou 'staged'>"
---
Fais une revue de code sur : $@

Si l'argument est "staged", utilise `git diff --cached`.
Si c'est un chemin, lis les fichiers concernés.

Analyse :
## Bugs & erreurs de logique
- [par fichier, précis]

## Problèmes de sécurité
- [par fichier, précis]

## Gestion d'erreurs
- [par fichier, précis]

## Performance
- [par fichier, précis]

## Suggestions
- [améliorations optionnelles]

Niveau de sévérité : 🔴 critique / 🟡 attention / 🟢 suggestion
```

#### `pi/prompts/security.md`
```markdown
---
description: Audit sécurité du codebase ou d'une zone spécifique
argument-hint: "<zone ou 'full'>"
---
Audit sécurité sur : $@

Vérifie :
- Injection SQL / commande
- XSS / injection de template
- Authentification / autorisation
- Gestion des secrets et credentials
- Dépendances vulnérables (`npm audit` ou équivalent)
- Validation des entrées
- Gestion des erreurs (fuite d'informations)

Format de sortie :
## Vulnérabilités
| Sévérité | Fichier | Ligne | Description | Recommandation |
|---|---|---|---|---|
| 🔴 | ... | ... | ... | ... |

## Checklist OWASP Top 10
- [x] / [ ] par catégorie
```

#### `pi/prompts/research.md`
```markdown
---
description: Recherche externe sur une technologie, library ou pattern
argument-hint: "<sujet de recherche>"
---
Recherche et synthétise des informations sur : $@

Approche :
1. Utilise bash pour chercher dans la doc locale (man, --help, README)
2. Utilise webfetch si disponible pour les ressources en ligne
3. Synthétise en format structuré

Format de sortie :
## Résumé
1-2 paragraphes

## Points clés
- Point 1
- Point 2

## Exemples de code
```lang
// code pertinent
```

## Sources
- URL ou fichiers consultés

## Recommandation
Comment appliquer ça au projet actuel
```

### Action

```bash
mkdir -p pi/prompts
# Créer les 6 fichiers ci-dessus
```

### Validation

```bash
# Copier les prompts dans le répertoire utilisateur
cp pi/prompts/*.md ~/.pi/agent/prompts/

# Tester chaque template
pi    # puis /explore "authentification"
pi    # puis /plan "ajouter un cache Redis"
pi    # puis /review staged
```

---

## Phase B : Extension plan-tracker (~2h)

**Objectif** : Extension PI minimale qui gère le tracking des plans (checkboxes) et les commandes associées. Remplace tout le système de sub-agents, hooks, skills, analytics.

### Architecture

```
pi/extensions/weave-lite/
├── index.ts          # Extension (~200 lignes)
└── config/
    ├── schema.ts     # Zod schema (conservé, simplifié)
    ├── merge.ts      # Deep merge (conservé tel quel)
    └── loader.ts     # JSONC loader (conservé tel quel)
```

### `pi/extensions/weave-lite/index.ts` — Structure

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config/loader";
import { getPlanProgress } from "./plan-utils";

export default function (pi: ExtensionAPI) {
  const config = loadConfig(process.cwd());

  // ---- Commande /plans ----
  pi.registerCommand("plans", {
    description: "Lister les plans Weave avec progression",
    handler: async (_args, ctx) => {
      const dir = path.join(ctx.cwd, ".weave", "plans");
      if (!fs.existsSync(dir)) { ctx.ui.notify("Aucun plan.", "info"); return; }
      const plans = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
      if (!plans.length) { ctx.ui.notify("Aucun plan.", "info"); return; }
      const lines = plans.map(p => {
        const progress = getPlanProgress(path.join(dir, p));
        const status = progress.isComplete ? "✓" : `${progress.completed}/${progress.total}`;
        return `${status}  ${p.replace(/\.md$/, "")}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---- Commande /start-work ----
  pi.registerCommand("start-work", {
    description: "Exécuter un plan (injecte le prompt d'exécution)",
    handler: async (args, ctx) => {
      const plansDir = path.join(ctx.cwd, ".weave", "plans");
      fs.mkdirSync(plansDir, { recursive: true });

      // Trouver le plan
      const plans = fs.readdirSync(plansDir).filter(f => f.endsWith(".md"));
      const name = args?.trim() || plans[0]?.replace(/\.md$/, "");
      if (!name) { ctx.ui.notify("Aucun plan trouvé.", "info"); return; }

      const planPath = path.join(plansDir, `${name}.md`);
      if (!fs.existsSync(planPath)) { ctx.ui.notify(`Plan introuvable : ${name}`, "error"); return; }

      const progress = getPlanProgress(planPath);
      if (progress.isComplete) { ctx.ui.notify(`Plan déjà terminé : ${name}`, "info"); return; }

      // Injecter le prompt d'exécution dans la session courante
      pi.sendUserMessage(
        `Exécute le plan .weave/plans/${name}.md.\n` +
        `Progression : ${progress.completed}/${progress.total} tâches terminées.\n` +
        `Lis le plan, trouve la première tâche non cochée, et exécute-la. ` +
        `Après chaque tâche, édite le plan pour cocher la checkbox. ` +
        `Continue jusqu'à ce que toutes les tâches soient cochées.`
      );
    },
  });

  // ---- Commande /weave-config ----
  pi.registerCommand("weave-config", {
    description: "Afficher la configuration Weave",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Config chargée. Fichiers : ${config.loadedFiles.join(", ") || "(défauts)"}`, "info");
    },
  });
}
```

### `pi/extensions/weave-lite/config/` — Fichiers conservés

Conserver `schema.ts`, `merge.ts`, `loader.ts` du Weave actuel **sans modification**.

### Fichiers supprimés

Tout le reste :
- `pi/extensions/weave/hooks/` — supprimé
- `pi/extensions/weave/skills/` — supprimé
- `pi/extensions/weave/analytics/` — supprimé
- `pi/extensions/weave/index.ts` — remplacé par la version lite

### Validation

```bash
# Installer l'extension lite
cp -r pi/extensions/weave-lite ~/.pi/agent/extensions/weave-lite

# Tester
pi    # /plans → liste les plans
pi    # /start-work mon-plan → injecte le prompt d'exécution
pi    # /weave-config → affiche la config
```

---

## Phase C : Agents .md simplifiés (~30min)

**Objectif** : Remplacer les 8 agents Weave par des définitions d'agents PI natives (sans sub-agent spawning). Ces agents servent uniquement si l'utilisateur veut utiliser le mode sub-agent de l'exemple PI natif.

### Fichiers à conserver (adaptés)

Conserver uniquement les agents qui ont une valeur en tant que personnalités spécialisées :

| Agent | Conservé ? | Pourquoi |
|---|---|---|
| `loom.md` | ❌ Supprimé | PI est déjà l'orchestrateur |
| `thread.md` | ✅ Renommé `scout.md` | Profil d'exploration read-only, réutilisable |
| `pattern.md` | ❌ Supprimé | Remplacé par `/plan` template |
| `tapestry.md` | ❌ Supprimé | Remplacé par `/start-work` + `/execute` |
| `shuttle.md` | ✅ Renommé `worker.md` | Profil d'implémentation par défaut |
| `weft.md` | ✅ Renommé `reviewer.md` | Profil de revue de code |
| `warp.md` | ❌ Supprimé | Remplacé par `/security` template |
| `spindle.md` | ❌ Supprimé | Remplacé par `/research` template |

### Agents conservés

#### `pi/agents/scout.md`
```markdown
---
name: scout
description: Exploration rapide du codebase en lecture seule
tools: read, bash, grep, find, ls
model: claude-haiku-4-5
---

Tu es un éclaireur. Explore le codebase rapidement et retourne des
conclusions structurées. Lecture seule — ne modifie aucun fichier.

Format de sortie :

## Fichiers pertinents
1. `chemin` (lignes X-Y) — description

## Code clé
Types, interfaces, fonctions importantes

## Architecture
Comment les pièces s'articulent

## Point de départ
Quel fichier regarder en premier
```

#### `pi/agents/worker.md`
```markdown
---
name: worker
description: Implémentation de tâches de code
---

Tu implémentes des tâches de code de manière précise et complète.

Règles :
- Toujours lire un fichier avant de le modifier
- Vérifier le résultat après chaque modification
- Documenter les choix effectués
- Si la tâche est ambiguë, faire un choix raisonnable et le documenter
```

#### `pi/agents/reviewer.md`
```markdown
---
name: reviewer
description: Revue de code structurée
tools: read, bash, grep, find, ls
---

Tu es un reviewer de code. Analyse le code pour :

- Bugs et erreurs de logique
- Problèmes de sécurité
- Gestion d'erreurs
- Performance
- Lisibilité et maintenabilité

Format de sortie par constat :
- Fichier et ligne
- Sévérité (🔴/🟡/🟢)
- Description du problème
- Recommandation de correction
```

### Action

```bash
# Supprimer les anciens agents
rm pi/agents/loom.md pi/agents/pattern.md pi/agents/tapestry.md
rm pi/agents/warp.md pi/agents/spindle.md

# Renommer les conservés
mv pi/agents/thread.md pi/agents/scout.md
mv pi/agents/shuttle.md pi/agents/worker.md
mv pi/agents/weft.md pi/agents/reviewer.md
```

---

## Phase D : Config simplifiée (~30min)

**Objectif** : Simplifier le schéma de config pour ne garder que ce qui est utile sans sub-agents.

### Ce qui est supprimé du schema

```typescript
// Supprimé — plus de sub-agents
disabled_agents    // Plus d'agents à désactiver
categories         // Plus de routing par catégorie
background         // Plus de parallélisme
analytics          // PI gère son propre tracking
disabled_skills    // PI gère les skills nativement
skill_directories  // PI gère les skills nativement
disabled_hooks     // Plus de hooks
```

### Ce qui est conservé

```typescript
// Conservé — profils de session
agents: {
  "*": {
    model?: string        // Modèle par défaut
    temperature?: number  // Température
  }
}
disabled_tools?: string[]        // Outils globaux désactivés
plan_tracking?: boolean          // Activer/désactiver le checkbox tracking
```

### Exemple de config simplifiée

```jsonc
// .pi/weave-config.jsonc
{
  // Modèle par défaut pour ce projet
  "agents": {
    "*": { "model": "anthropic/claude-sonnet-4" }
  },

  // Désactiver des outils (ex: projet read-only)
  "disabled_tools": ["write"],

  // Checkbox tracking dans les plans
  "plan_tracking": true
}
```

### Action

- Éditer `pi/extensions/weave-lite/config/schema.ts` pour retirer les champs supprimés
- `merge.ts` et `loader.ts` restent identiques

---

## Phase E : Documentation et package (~1h)

**Objectif** : Réécrire la doc pour refléter la nouvelle architecture.

### Fichiers à mettre à jour

| Fichier | Action |
|---|---|
| `pi/README.md` | Réécrire — workflow templates + plan tracker, pas de sub-agents |
| `pi/SUBAGENT-ARCHITECTURE.md` | Supprimer ou archiver — plus pertinent |
| `pi/ANALYSE-CRITIQUE.md` | Conserver — justification de la refactorisation |
| `pi/package.json` | Mettre à jour — point d'entrée vers `weave-lite/` |
| `pi/weave-config.jsonc.example` | Simplifier — voir exemple ci-dessus |
| `WEAVE-PI-PHASE0.md` | Remplacer par un document de statut final |

### Structure finale du package

```
pi/
├── package.json                  # Manifest PI package
├── README.md                     # Doc principale (réécrite)
├── ANALYSE-CRITIQUE.md           # Justification (conservé)
├── weave-config.jsonc.example    # Config simplifiée
├── prompts/                      # 6 prompt templates
│   ├── explore.md
│   ├── plan.md
│   ├── execute.md
│   ├── review.md
│   ├── security.md
│   └── research.md
├── extensions/
│   └── weave-lite/               # Extension minimale (~200 lignes)
│       ├── index.ts
│       └── config/
│           ├── schema.ts
│           ├── merge.ts
│           └── loader.ts
└── agents/                       # 3 agents (optionnel, pour subagent example)
    ├── scout.md
    ├── worker.md
    └── reviewer.md
```

---

## Phase F : Nettoyage (~30min)

### Supprimer les fichiers obsolètes

```
pi/extensions/weave/          # Tout l'ancien système (hooks, skills, analytics, index.ts)
pi/agents/loom.md
pi/agents/pattern.md
pi/agents/tapestry.md
pi/agents/warp.md
pi/agents/spindle.md
pi/SUBAGENT-ARCHITECTURE.md   # Optionnel : archiver
```

### Nettoyer le répertoire utilisateur

```bash
# Supprimer l'ancienne extension
rm -rf ~/.pi/agent/extensions/weave/

# Installer la nouvelle
cp -r pi/extensions/weave-lite ~/.pi/agent/extensions/weave-lite

# Installer les prompts
cp pi/prompts/*.md ~/.pi/agent/prompts/

# Installer les agents (optionnel)
cp pi/agents/*.md ~/.pi/agent/agents/
```

---

## Ordre d'exécution

| Phase | Durée estimée | Dépendance |
|---|---|---|
| **A** — Prompt templates | ~1h | Aucune |
| **B** — Extension weave-lite | ~2h | Aucune (parallèle avec A) |
| **C** — Agents simplifiés | ~30min | Aucune (parallèle avec A+B) |
| **D** — Config simplifiée | ~30min | B (schema utilisé par l'extension) |
| **E** — Documentation | ~1h | A+B+D (connaître le résultat final) |
| **F** — Nettoyage | ~30min | Toutes les autres |

**Total estimé : ~5h30**

### Workflow recommandé par session PI

Les phases A, B et C sont indépendantes et peuvent se faire en parallèle.

Pour un exécuteur unique, l'ordre optimal est :
1. **Phase A** — Créer les prompts, valider avec PI
2. **Phase B** — Écrire l'extension weave-lite, valider
3. **Phase C** — Nettoyer les agents
4. **Phase D** — Simplifier le config schema
5. **Phase F** — Nettoyage final
6. **Phase E** — Documentation (en dernier car elle décrit le résultat)

---

## Validation finale

### Checklist par feature

- [ ] `/explore "auth"` → exploration read-only structurée
- [ ] `/plan "ajouter cache Redis"` → plan créé dans `.weave/plans/` avec checkboxes
- [ ] `/plans` → liste avec progression
- [ ] `/start-work redis-cache` → exécution du plan, checkboxes cochées une par une
- [ ] `/review staged` → revue de code sur `git diff --cached`
- [ ] `/security "api/routes"` → audit sécurité ciblé
- [ ] `/research "OAuth 2.0 PKCE"` → synthèse structurée
- [ ] `/weave-config` → affiche la config
- [ ] L'extension charge sans erreur
- [ ] Le package s'installe via `pi install ./pi`

### Checklist de suppression

- [ ] Plus de `pi --mode json` spawné nulle part
- [ ] Plus de `task` tool custom
- [ ] Plus de `state.json`
- [ ] Plus de hooks (WriteGuard, KeywordDetector, etc.)
- [ ] Plus de skill injection per-agent
- [ ] Plus de SessionTracker / analytics JSONL
- [ ] L'extension fait moins de 250 lignes

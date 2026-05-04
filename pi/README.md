# Weave for PI

Multi-agent orchestration extension for [PI coding agent](https://pi.dev).

## What It Does

Weave brings structured multi-agent workflows to PI:

- **8 specialized agents** — Loom (orchestrator), Thread (explorer), Pattern (planner), Tapestry (executor), Shuttle (implementer), Weft (reviewer), Warp (security auditor), Spindle (researcher)
- **Plan → Review → Execute** workflow with persistent state and checkpoint resumption
- **Parallel & chain delegation** — run multiple agents concurrently or sequentially with output chaining
- **Config pipeline** — JSONC config with user/project merge, per-agent overrides, category routing
- **Governance hooks** — write guard, keyword detection, verification reminders, compaction recovery
- **Per-agent skill injection** — assign skills to specific agents via config
- **Analytics** — session tracking, token reports, cost breakdown (opt-in)

## Installation

```bash
# From git
pi install git:github.com/mwolff44/opencode-weave

# Or install locally (from this directory)
pi install ./pi

# Or try without installing
pi -e git:github.com/mwolff44/opencode-weave
```

## Quick Start

1. Start PI — Weave auto-loads as the default orchestrator
2. Ask PI to delegate to agents: *"Use the task tool with agent='thread' to explore the codebase"*
3. Create a plan: *"Use agent='pattern' to create a plan for adding auth"*
4. Execute: `/start-work`

## Agent Overview

| Agent | Role | Tools |
|-------|------|-------|
| **Loom** | Main orchestrator | Full |
| **Thread** | Codebase explorer | Read-only |
| **Pattern** | Strategic planner | Read + write (.weave/) |
| **Tapestry** | Execution coordinator | Full |
| **Shuttle** | Domain specialist | Full |
| **Weft** | Code reviewer | Read-only |
| **Warp** | Security auditor | Read-only |
| **Spindle** | External researcher | Read-only |

## Configuration

Place config in `~/.pi/agent/weave-config.jsonc` (user) or `.pi/weave-config.jsonc` (project):

```jsonc
{
  // Per-agent overrides
  "agents": {
    "pattern": { "model": "anthropic/claude-sonnet-4", "temperature": 0.5 },
    "loom": { "prompt_append": "Always use TypeScript strict mode." }
  },

  // Domain categories for shuttle routing
  "categories": {
    "frontend": { "description": "React/UI", "model": "openai/gpt-5", "temperature": 0.3 },
    "backend": { "description": "API development", "model": "anthropic/claude-sonnet-4", "temperature": 0.1 }
  },

  // Toggle features
  "disabled_agents": ["spindle"],
  "disabled_hooks": ["keyword-detector"],
  "disabled_skills": [],

  // Skills per agent
  "agents": {
    "shuttle": { "skills": ["typescript-strict"] }
  },

  // Analytics (opt-in)
  "analytics": { "enabled": true }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/start-work [plan]` | Start or resume plan execution via Tapestry |
| `/plans` | List plans with progress |
| `/token-report` | Show token usage and cost breakdown |
| `/weave-config` | Show current configuration |

## Task Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{agent, task}` | Delegate one task |
| Parallel | `{tasks: [{agent, task}, ...]}` | Run N agents concurrently (max 8) |
| Chain | `{chain: [{agent, task}, ...]}` | Sequential with `{previous}` placeholder |

## Package Structure

```
pi/
├── package.json                  # PI package manifest
├── README.md                     # This file
├── weave-config.jsonc.example    # Example configuration
├── extensions/
│   └── weave/
│       ├── index.ts              # Main extension (~750 lines)
│       ├── config/
│       │   ├── schema.ts         # Zod validation schemas
│       │   ├── merge.ts          # Deep merge logic
│       │   └── loader.ts         # JSONC config loader (user + project)
│       ├── hooks/
│       │   └── index.ts          # WriteGuard, KeywordDetector, VerificationReminder,
│       │                         # CompactionRecovery, WorkContinuation, WorkState CRUD
│       ├── skills/
│       │   └── index.ts          # Multi-source skill discovery, per-agent injection
│       └── analytics/
│           └── index.ts          # SessionTracker, JSONL storage, token report generator
└── agents/
    ├── loom.md                   # Main orchestrator
    ├── thread.md                 # Codebase explorer (read-only)
    ├── pattern.md                # Strategic planner (writes .weave/plans/)
    ├── tapestry.md               # Execution orchestrator
    ├── shuttle.md                # Domain specialist worker
    ├── weft.md                   # Reviewer/auditor (read-only)
    ├── warp.md                   # Security auditor (read-only)
    └── spindle.md                # External researcher (read-only)
```

## Pros & Cons of Using Weave with PI

### ✅ Pros

| Benefit | Why It Matters |
|---------|----------------|
| **Structured delegation** | Instead of one monolithic agent doing everything, tasks go to specialized agents with scoped tools and tailored prompts. A reviewer doesn't need write access; an explorer doesn't need edit tools. |
| **Persistent plan execution** | Create a plan once, execute it across sessions. Checkbox tracking (`- [ ]` → `- [x]`), `state.json` persistence, and automatic resume on re-entry mean you can stop and restart without losing progress. |
| **Parallel execution** | Run multiple agents concurrently (e.g., explore codebase + research docs simultaneously). Bounded concurrency prevents resource exhaustion. |
| **Tool scoping per agent** | Read-only agents (Thread, Weft, Warp, Spindle) physically cannot modify your codebase — enforcement happens at the tool level, not just prompt instructions. |
| **Governance hooks** | WriteGuard prevents overwriting files you haven't read. Keyword detection triggers focused mode. Verification reminders prompt post-task review. These run automatically without user discipline. |
| **Config-driven flexibility** | Override any agent's model, tools, or prompt per-project. Disable agents you don't need. Route domains to specific models. All via JSONC — no code changes. |
| **Per-agent skill injection** | Give Shuttle a TypeScript-strict skill without polluting the reviewer's prompt. Skills are scoped to the agents that need them. |
| **Analytics & cost visibility** | Track which agents cost the most, which models consume the most tokens. JSONL logs make it easy to audit and optimize. |
| **Works with any PI model** | Agents are model-agnostic. Use Claude for planning, GPT for implementation, a local model for exploration — mix and match per agent via config. |
| **Composable pipelines** | Chain mode lets you pipe one agent's output into the next (Thread explores → Weft reviews → Shuttle implements). Build reusable workflows without code. |

### ⚠️ Cons

| Limitation | Why It Matters |
|------------|----------------|
| **Token overhead** | Each subagent is a separate `pi` child process with its own system prompt and context window. For simple tasks (single-file edits, quick questions), spawning an agent costs more tokens than doing it directly. |
| **Latency per delegation** | Child process startup + model API call means each task has 5–15s of overhead. Parallel mode mitigates this, but chain mode is strictly sequential. |
| **No shared context between agents** | Each subagent starts with a fresh context — it only sees what you pass in the `task` description. Agents cannot reference each other's conversation history. Chain mode's `{previous}` placeholder is the only bridge. |
| **Soft enforcement for child processes** | WriteGuard uses PI's `{ block: true }` for the main session, but subagents run as separate `pi` processes. Tool scoping inside children relies on system prompt instructions, not hard enforcement. |
| **Complexity cost** | 8 agents, config files, state management, hooks — Weave adds conceptual overhead. For small projects or solo developers, PI's native single-agent mode is simpler and sufficient. |
| **State management is file-based** | `.weave/state.json` and plan files use the filesystem. No database, no locking. Concurrent PI sessions working on the same plan can conflict. |
| **Config sprawl** | User config + project config + deep merge + agent overrides + categories + skills = many knobs to tune. The defaults work well, but customization requires understanding the full schema. |
| **Analytics are opt-in and basic** | No built-in dashboards or trend analysis. Analytics writes JSONL files — you need external tooling (or `/token-report`) to make sense of the data. Token counts from child processes are approximate. |
| **PI extension API limitations** | No native agent registry in PI — agents are simulated via system prompts and tool scoping. This is a design constraint, not a bug, but it means some patterns (inter-agent communication, shared memory) aren't possible. |

### When to Use Weave vs. Plain PI

| Scenario | Recommendation |
|----------|---------------|
| Quick bug fix, single file | **Plain PI** — no need for orchestration |
| Exploring an unfamiliar codebase | **Weave** — Thread is purpose-built for this |
| Multi-file feature with tests + docs | **Weave** — Pattern plans, Tapestry coordinates, Shuttle implements |
| Security audit before release | **Weave** — Warp runs a focused security review |
| Refactoring across 10+ files | **Weave** — plan tracking and checkpoint resumption shine here |
| One-off question about a library | **Plain PI** — Spindle could help, but overhead isn't worth it |
| Large project with mixed domains | **Weave** — category routing sends frontend/backend to different models |

## License

MIT

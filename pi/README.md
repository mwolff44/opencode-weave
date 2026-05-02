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

## License

MIT

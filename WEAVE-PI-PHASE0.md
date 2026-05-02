# Weave for PI — Complete (Phases 0-7)

All core phases implemented and validated.

## Status

| Phase | Feature | Status |
|-------|---------|--------|
| 0 | Core delegation (8 agents, task tool, child `pi` processes) | ✅ |
| 1 | Config pipeline (JSONC, Zod, deep merge, per-agent overrides) | ✅ |
| 2 | Parallel & chain modes (concurrency-limited, `{previous}` placeholder) | ✅ |
| 3 | Hook system (write guard, keywords, verification, compaction recovery) | ✅ |
| 4 | Plan execution with state tracking (state.json, checkboxes, resume) | ✅ |
| 5 | Per-agent skill injection (multi-source discovery, config assignment) | ✅ |
| 6 | Analytics (session tracking, JSONL storage, token reports) | ✅ |
| 7 | Packaging (PI package manifest, README, installable) | ✅ |

## Installation

```bash
pi install git:github.com/mwolff44/opencode-weave
```

Or copy files manually:
- `extensions/weave/` → `~/.pi/agent/extensions/weave/`
- `agents/*.md` → `~/.pi/agent/agents/`

## Files

```
~/.pi/agent/extensions/weave/
├── index.ts              # Main extension (~750 lines)
├── config/
│   ├── schema.ts         # Zod validation schemas
│   ├── merge.ts          # Deep merge logic
│   └── loader.ts         # JSONC config loader (user + project)
├── hooks/
│   └── index.ts          # WriteGuard, KeywordDetector, VerificationReminder,
│                         # CompactionRecovery, WorkContinuation, WorkState CRUD
├── skills/
│   └── index.ts          # Multi-source skill discovery, per-agent injection
└── analytics/
    └── index.ts          # SessionTracker, JSONL storage, token report generator

~/.pi/agent/agents/
├── loom.md               # Main orchestrator
├── thread.md             # Codebase explorer (read-only)
├── pattern.md            # Strategic planner (writes .weave/plans/)
├── tapestry.md           # Execution orchestrator
├── shuttle.md            # Domain specialist worker
├── weft.md               # Reviewer/auditor (read-only)
├── warp.md               # Security auditor (read-only)
└── spindle.md            # External researcher (read-only)
```

## Commands

| Command | Description |
|---------|-------------|
| `/start-work [plan]` | Start or resume plan execution |
| `/plans` | List plans with progress |
| `/token-report` | Show token usage and cost breakdown |
| `/weave-config` | Show current configuration |

## Config Locations

| Scope | Path |
|-------|------|
| User | `~/.pi/agent/weave-config.jsonc` |
| Project | `.pi/weave-config.jsonc` |
| Legacy user | `~/.config/opencode/weave-opencode.jsonc` |
| Legacy project | `.opencode/weave-opencode.jsonc` |

## Key Validations

1. **Thread exploration** — correctly identified entry points, file counts, frameworks
2. **Pattern planning** — created `.weave/plans/*.md` with `- [ ]` checkboxes
3. **Full plan execution** — Pattern → Tapestry → Shuttle pipeline, all checkboxes marked
4. **Parallel mode** — 2 Thread agents ran concurrently, both returned correct results
5. **Chain mode** — Thread → Weft pipeline with `{previous}` output passing
6. **Write guard** — blocked write to unread file, allowed after read
7. **Keyword detector** — "ultrawork" triggered focused-mode injection
8. **Config pipeline** — disabled agents removed from tool + prompt; prompt_append applied
9. **Category routing** — `shuttle-frontend` resolved with category model/tools
10. **Skill injection** — `typescript-strict` skill caused Shuttle to use explicit type annotations
11. **Analytics** — session summaries written to `.weave/analytics/sessions.jsonl` with delegation records
12. **Compaction recovery** — reads `.weave/state.json` to restore plan context after `/compact`

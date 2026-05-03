# Weave Subagent Architecture: OpenCode vs PI

## The Core Problem

Weave is a **multi-agent orchestration system**. Its fundamental operation is **delegation** — one agent
handing work to another specialized agent. This requires a way to:

1. Define agents (name, role, tools, prompt)
2. Spawn an agent as an isolated process with its own context
3. Capture the agent's output and return it to the caller
4. Enforce tool restrictions (read-only agents cannot write)

OpenCode provides a native `task` tool that does all of this out of the box. PI does not have a
native agent registry or subagent system. This document explains how Weave bridges that gap.

---

## How OpenCode Handles Subagents (Native)

```
┌──────────────────────────────────────────────────────────────┐
│                     OpenCode Runtime                         │
│                                                              │
│  ┌─────────┐    task tool     ┌──────────────────────────┐  │
│  │  Loom   │ ───(builtin)───▶ │  OpenCode Agent System   │  │
│  │         │                  │                          │  │
│  │         │                  │  • AgentConfig registry  │  │
│  └─────────┘                  │  • Native tool scoping   │  │
│                               │  • Isolated context      │  │
│  ┌─────────┐    task tool     │  • Weave hooks via       │  │
│  │ Tapestry│ ───(builtin)───▶ │    plugin adapter        │  │
│  └─────────┘                  └──────────────────────────┘  │
│                                                              │
│  Weave plugin hooks into:                                    │
│  • config → registers agents via config.agent = {...}        │
│  • tool.execute.before/after → WriteGuard, tracking          │
│  • task tool args: { subagent_type, description, prompt }    │
│  • AgentConfig.tools = { write: false } → HARD enforcement   │
└──────────────────────────────────────────────────────────────┘
```

### How it works

1. **Agent registration**: Weave calls `config.agent = { ... }` in the OpenCode `config` hook.
   Each agent is an `AgentConfig` with `name`, `description`, `prompt`, `tools`, `model`.

2. **Native `task` tool**: OpenCode provides a built-in `task` tool. When any agent calls it
   with `{ subagent_type: "thread", prompt: "..." }`, OpenCode:
   - Looks up the agent in its internal registry
   - Spawns an **isolated conversation context** (same process, new context window)
   - Applies the agent's tool restrictions **natively** — `tools: { write: false }` means the
     tool literally does not exist for that agent
   - Returns the agent's response as the tool result

3. **Plugin hooks**: Weave's `plugin-adapter.ts` intercepts:
   - `tool.execute.before` (for WriteGuard, keyword detection, analytics tracking)
   - `tool.execute.after` (for analytics, delegation logging)
   - These hooks run **inside the same process** — they can intercept any tool call

4. **Tool enforcement**: OpenCode's `AgentConfig.tools: { write: false, task: false }` is
   **hard enforcement at the runtime level**. A read-only agent like Thread physically cannot
   call `write` or `task`. This is not a prompt instruction — it's a capability restriction.

### Key properties

| Property | Detail |
|----------|--------|
| Agent registry | Native — `config.agent` maps to OpenCode's internal agent system |
| Subagent spawning | Built-in `task` tool, same process, isolated context |
| Tool scoping | **Hard** — `tools: { write: false }` removes the tool from the agent's available set |
| Hook interception | **Hard** — `tool.execute.before/after` runs for every tool call |
| Context | Each subagent gets a fresh context window within the same process |
| Inter-agent communication | Via `task` tool args — the parent passes context in the `prompt` parameter |

---

## How PI Handles Subagents (Simulated)

```
┌──────────────────────────────────────────────────────────────┐
│                       PI Runtime                             │
│                                                              │
│  ┌─────────┐   task tool    ┌────────────────────────────┐  │
│  │  Loom   │ ──(custom)───▶ │  spawn("pi --mode json")   │  │
│  │         │                │                            │  │
│  │  (main  │                │  • Separate OS process     │  │
│  │ process)│                │  • --append-system-prompt  │  │
│  └─────────┘                │    loads agent .md file    │  │
│                             │  • --tools read,bash,grep  │  │
│  ┌─────────┐   task tool    │  • --model <model>         │  │
│  │ Tapestry│ ──(custom)───▶ │  • Isolated context       │  │
│  └─────────┘                │  • stdout = JSON lines     │  │
│                             └────────────────────────────┘  │
│                                                              │
│  Weave extension hooks into:                                 │
│  • before_agent_start → Loom system prompt                   │
│  • tool_call → WriteGuard (HARD block for main session)      │
│  • CANNOT hook into child processes                          │
└──────────────────────────────────────────────────────────────┘
```

### How it works

1. **Agent definitions**: Agent prompts are `.md` files in `~/.pi/agent/agents/` (or the package's
   `agents/` directory). PI discovers them natively, but they're just markdown — PI doesn't know
   about Weave's agent roles, tools, or routing logic.

2. **Custom `task` tool**: Weave registers a PI extension tool called `task`. When Loom calls it
   with `{ agent: "thread", task: "explore the codebase" }`, the extension:
   - Resolves the agent name to its `.md` file and config overrides
   - Builds a system prompt from the agent's `.md` content + config overrides + skills
   - Writes the system prompt to a temp file
   - Spawns `pi --mode json --append-system-prompt /tmp/prompt-xxx.md --tools read,bash,grep --model <model>`
   - Reads JSON lines from the child's stdout
   - Returns the assistant's text as the tool result

3. **Tool scoping**: Tools are restricted via `--tools` flag on the child `pi` process.
   For example, Thread gets `--tools read,bash,grep,find,ls` — it literally cannot call `write`
   or `edit` because those tools are not loaded. This is **hard enforcement** at the process level.

4. **Hook limitations**: The extension's `tool_call` hook (WriteGuard, etc.) only fires for the
   **main PI session**. Child `pi` processes are separate OS processes — Weave's hooks do not
   run inside them. Tool scoping inside children relies entirely on `--tools` flag restrictions.

### Key properties

| Property | Detail |
|----------|--------|
| Agent registry | **Simulated** — agent `.md` files + config schema + `resolveAgent()` function |
| Subagent spawning | `child_process.spawn("pi", ["--mode", "json", ...])` — separate OS process |
| Tool scoping | **Hard via `--tools` flag** — tools not listed are unavailable in the child |
| Hook interception | **Main session only** — cannot intercept tool calls inside child processes |
| Context | Each child gets a completely fresh context (new process) |
| Inter-agent communication | Via `task` tool args + chain mode `{previous}` placeholder |

---

## Side-by-Side Comparison

| Aspect | OpenCode (Native) | PI (Simulated) |
|--------|------------------|-----------------|
| **Agent registry** | `config.agent = {...}` → built-in registry | `.md` files + `resolveAgent()` + config schema |
| **Subagent execution** | Same process, isolated context window | Separate OS process (`pi --mode json`) |
| **Tool restrictions** | `tools: { write: false }` — hard, per-tool | `--tools read,bash,...` — hard, per-process |
| **Hook interception** | `tool.execute.before/after` — every call | `tool_call` — main session only |
| **Prompt composition** | `AgentConfig.prompt` property | `--append-system-prompt` temp file |
| **Model override** | `AgentConfig.model` property | `--model <model>` CLI flag |
| **Output capture** | Return value from `task` tool | Parse JSON lines from child stdout |
| **Context sharing** | None — fresh context per call | None — fresh process per call |
| **Process overhead** | Low (same process) | Medium (process spawn + model API) |
| **WriteGuard scope** | All agents (hooks run inside subagents) | Main Loom session only |
| **Parallel support** | Built into Weave's `background_manager` | Custom `Promise.all` with concurrency limiter |

---

## Attention Points

### 1. No hook interception inside subagents

**OpenCode**: Weave's WriteGuard, KeywordDetector, and VerificationReminder run inside every
agent via `tool.execute.before/after`. If Shuttle tries to write a file it hasn't read, the
WriteGuard fires — regardless of whether Shuttle is the main agent or a subagent.

**PI**: Hooks only fire for the main PI session. If Loom delegates to Shuttle (a child process)
and Shuttle tries to write a file it hasn't read, nothing stops it. The `--tools` flag ensures
Shuttle has write access, but there's no WriteGuard inside the child.

**Impact**: Medium. WriteGuard is the main safety net. In practice, Shuttle's system prompt
instructs it to read before writing, but this is **soft enforcement** — prompt instructions
that the model can ignore.

**Mitigation**: Could be partially addressed by creating a second Weave extension that runs
inside child processes (via PI's `--append-extension` flag), but this would double overhead
and hasn't been implemented.

### 2. Process spawn latency

**OpenCode**: Subagent execution is in-process — context window isolation has minimal overhead.

**PI**: Each delegation spawns a new OS process (`pi --mode json`), which:
- Starts the PI runtime
- Loads extensions
- Initializes the model client
- Makes the API call
- Streams output

This adds ~5-15 seconds of overhead per delegation. For a plan with 10 tasks executed
sequentially, that's 50-150 seconds of pure overhead.

**Impact**: Medium-High for large plans. Parallel mode helps (up to `defaultConcurrency`
agents run concurrently), but chain mode is strictly sequential.

### 3. JSON mode output parsing

**OpenCode**: The `task` tool returns structured output directly.

**PI**: The child process streams JSON events on stdout (`{ type: "message_end", message: ... }`).
Weave's `runSubagent()` function parses these lines and extracts:
- Assistant message text
- Token usage (`usage.input`, `usage.output`, `usage.cost`)
- Turn count

If the model produces malformed output or the process crashes mid-stream, parsing can fail
partially. The extension handles this with try/catch, but incomplete results are possible.

**Impact**: Low in practice — `pi --mode json` is a well-documented, stable interface.

### 4. Tool scoping is all-or-nothing

**OpenCode**: `AgentConfig.tools = { write: false, task: false, bash: true }` — fine-grained
per-tool permissions.

**PI**: `--tools read,bash,grep,find,ls` — tools not listed are unavailable. This is equivalent
but specified differently. The mapping is in `resolveAgent()`:

```typescript
// Thread (read-only)
tools: ["read", "bash", "grep", "find", "ls"]

// Shuttle (full access)  
tools: ["read", "bash", "edit", "write", "grep", "find", "ls"]
```

Config overrides can modify this list, but the tool names must match PI's actual tool names.

**Impact**: Low. The mapping is straightforward and works correctly.

### 5. System prompt construction is complex

**OpenCode**: `AgentConfig.prompt` is a single string property. Weave's `prompt-composer.ts`
builds it once during agent creation.

**PI**: System prompts are assembled from multiple sources at delegation time:
1. Agent `.md` file content
2. Config overrides (`prompt_append`, `model`, `tools`)
3. Per-agent skill injection
4. Dynamic delegation context (plan progress, category info)

This happens in `resolveAgent()` on every call. If any source is malformed, the child process
receives a broken prompt.

**Impact**: Low-Medium. The composition is well-tested but has more moving parts.

### 6. No inter-agent communication

**Both**: Neither OpenCode nor PI support agents talking to each other directly. All
communication flows through the `task` tool's arguments.

In chain mode, Weave passes `{previous}` as a placeholder that gets replaced with the
previous agent's output text. This is a text-level bridge, not shared memory.

**Impact**: Low. This is by design — agents are stateless workers.

### 7. State management is file-based

**OpenCode**: Weave uses `localStorage` equivalent via OpenCode's storage API.

**PI**: State is stored in `.weave/state.json` on the filesystem. No locking mechanism.

If two PI sessions work on the same project simultaneously:
- Both read the same `state.json`
- Both may write to it
- Last writer wins — state can be corrupted

**Impact**: Low for single-session workflows (the common case). Medium for teams sharing
a project directory.

### 8. `pi.sendUserMessage` in command handlers

The `/start-work` command creates state and then calls `pi.sendUserMessage()` to inject a
delegation prompt. This works in interactive PI sessions but is effectively a no-op in
`pi -p` one-shot mode (the process exits before the message triggers a turn).

**Impact**: Low. `/start-work` is designed for interactive use. Programmatic plan execution
works by directly instructing the agent (not via the command).

---

## Summary

The PI port is architecturally faithful to the original — same agents, same delegation patterns,
same config pipeline. The key trade-off is:

| | OpenCode | PI |
|---|---|---|
| **Correctness** | Native agent system guarantees behavior | Simulated via child processes — correct by design but relies on CLI flags |
| **Safety** | Hooks run everywhere | Hooks run in main session only; child processes rely on `--tools` flag + prompt instructions |
| **Performance** | In-process, minimal overhead | Process spawn per delegation (~5-15s overhead) |
| **Maintainability** | Tightly coupled to OpenCode SDK types | Loosely coupled — uses PI's public CLI interface |

The port works because `pi --mode json` is a stable, well-designed interface that gives Weave
everything it needs to simulate the subagent pattern. The gaps (no child-process hooks, spawn
latency) are inherent to the "child process as subagent" approach and cannot be fully closed
without native agent support in PI.

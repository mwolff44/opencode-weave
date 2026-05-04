/**
 * Weave for PI — Multi-agent orchestration extension
 *
 * Phases 0-4: Core delegation + config pipeline + parallel/chain + hooks + plan execution
 *
 * Plan execution flow:
 *   /start-work → create .weave/state.json → delegate to Tapestry
 *   Tapestry reads plan → delegates each task to Shuttle via task tool
 *   After each task: verify result → edit plan checkboxes (- [ ] → - [x])
 *   On completion: report summary, optionally delegate to Weft/Warp for review
 *   On interruption: state.json persists → /start-work resumes from checkpoint
 *
 * Governance hooks for the main Loom agent:
 *   WriteGuard, VerificationReminder, KeywordDetector, CompactionRecovery,
 *   ContextWindowMonitor
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadWeaveConfig, type ConfigLoadResult } from "./config/loader";
import type { WeaveConfig, CategoryConfig } from "./config/schema";
import {
  WriteGuard,
  buildVerificationReminder,
  detectKeywords,
  buildCompactionRecoveryPrompt,
  buildWorkContinuationPrompt,
  isPathInWeaveDir,
  readWorkState,
  writeWorkState,
  clearWorkState,
  createWorkState,
  appendSessionId,
  pauseWork,
  resumeWork,
  getPlanProgress,
  resolveHookConfig,
  type HookConfig,
  type WorkState,
} from "./hooks";
import {
  discoverSkills,
  getAgentSkills,
  buildSkillInjection,
  type LoadedSkill,
} from "./skills";
import {
  SessionTracker,
  appendSessionSummary,
  readSessionSummaries,
  generateTokenReport,
} from "./analytics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

export interface WeaveAgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): WeaveAgentConfig[] {
  const agents: WeaveAgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return agents; }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools?.split(",").map((t: string) => t.trim()).filter(Boolean);
    agents.push({ name: frontmatter.name, description: frontmatter.description, tools: tools?.length ? tools : undefined, model: frontmatter.model, systemPrompt: body, source, filePath });
  }
  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    try { if (fs.statSync(path.join(current, ".pi", "agents")).isDirectory()) return path.join(current, ".pi", "agents"); } catch { /* */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function discoverWeaveAgents(cwd: string, disabledAgents: Set<string>): WeaveAgentConfig[] {
  const agentMap = new Map<string, WeaveAgentConfig>();
  for (const a of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) agentMap.set(a.name, a);
  const projectDir = findNearestProjectAgentsDir(cwd);
  if (projectDir) for (const a of loadAgentsFromDir(projectDir, "project")) agentMap.set(a.name, a);
  for (const name of disabledAgents) agentMap.delete(name);
  return Array.from(agentMap.values());
}

// ---------------------------------------------------------------------------
// Subagent runner
// ---------------------------------------------------------------------------

export interface SubagentResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  model?: string;
  turns: number;
  usage: { input: number; output: number; cost: number };
  step?: number;
}

function getFinalAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      for (const part of messages[i].content ?? []) { if (part.type === "text") return part.text; }
    }
  }
  return "";
}

async function runSubagent(cwd: string, agent: WeaveAgentConfig, task: string, signal?: AbortSignal, step?: number): Promise<SubagentResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-"));
  const tmpFile = path.join(tmpDir, "system-prompt.md");
  try {
    await fs.promises.writeFile(tmpFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
    args.push("--append-system-prompt", tmpFile);
    args.push(task);
    const messages: any[] = [];
    const result: SubagentResult = { agent: agent.name, task, exitCode: 0, output: "", stderr: "", turns: 0, usage: { input: 0, output: 0, cost: 0 }, step };
    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "message_end" && event.message) {
          messages.push(event.message);
          if (event.message.role === "assistant") {
            result.turns++;
            const u = event.message.usage;
            if (u) { result.usage.input += u.input || 0; result.usage.output += u.output || 0; result.usage.cost += u.cost?.total || 0; }
            if (!result.model && event.message.model) result.model = event.message.model;
          }
        }
      };
      proc.stdout.on("data", (data: Buffer) => { buffer += data.toString(); const lines = buffer.split("\n"); buffer = lines.pop() || ""; for (const line of lines) processLine(line); });
      proc.stderr.on("data", (data: Buffer) => { result.stderr += data.toString(); });
      proc.on("close", (code) => { if (buffer.trim()) processLine(buffer); resolve(code ?? 0); });
      proc.on("error", () => resolve(1));
      if (signal) {
        const kill = () => { wasAborted = true; proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
        if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
      }
    });
    result.exitCode = exitCode;
    result.output = getFinalAssistantText(messages);
    if (wasAborted) throw new Error("Subagent was aborted");
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* */ }
    try { fs.rmdirSync(tmpDir); } catch { /* */ }
  }
}

// ---------------------------------------------------------------------------
// Parallel execution
// ---------------------------------------------------------------------------

async function mapWithConcurrency<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array(limit).fill(null).map(async () => { while (true) { const i = nextIndex++; if (i >= items.length) return; results[i] = await fn(items[i], i); } }));
  return results;
}

// ---------------------------------------------------------------------------
// Plan / work state helpers
// ---------------------------------------------------------------------------

function ensureWeaveDir(cwd: string): string {
  const plansDir = path.join(cwd, ".weave", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  return path.join(cwd, ".weave");
}

// ---------------------------------------------------------------------------
// Agent resolution
// ---------------------------------------------------------------------------

function resolveAgent(agentName: string, agents: WeaveAgentConfig[], cfg: WeaveConfig, skills: LoadedSkill[]): WeaveAgentConfig | null {
  let agent = agents.find(a => a.name === agentName) ?? null;
  if (!agent && agentName.startsWith("shuttle-")) {
    const catCfg = cfg.categories?.[agentName.slice("shuttle-".length)];
    if (catCfg) {
      agent = agents.find(a => a.name === "shuttle") ?? null;
      if (agent) agent = { ...agent, name: agentName, model: catCfg.model ?? agent.model, tools: catCfg.tools ? Object.entries(catCfg.tools).filter(([, v]) => v).map(([k]) => k) : agent.tools, systemPrompt: catCfg.prompt_append ? agent.systemPrompt + "\n\n" + catCfg.prompt_append : agent.systemPrompt };
    }
  }
  if (!agent) return null;
  const override = cfg.agents?.[agent.name];
  if (override) {
    if (override.model) agent = { ...agent, model: override.model };
    if (override.prompt_append) agent = { ...agent, systemPrompt: agent.systemPrompt + "\n\n" + override.prompt_append };
    if (override.tools) {
      const base = agent.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
      const filtered = base.filter(t => override.tools![t] !== false);
      for (const [tool, enabled] of Object.entries(override.tools)) { if (enabled && !filtered.includes(tool)) filtered.push(tool); }
      agent = { ...agent, tools: filtered };
    }
  }

  // Inject per-agent skills
  const agentSkills = getAgentSkills(agent.name, skills, cfg);
  const skillInjection = buildSkillInjection(agentSkills);
  if (skillInjection) {
    agent = { ...agent, systemPrompt: agent.systemPrompt + "\n\n" + skillInjection };
  }

  return agent;
}

// ---------------------------------------------------------------------------
// Loom system prompt builder
// ---------------------------------------------------------------------------

function buildLoomSystemPrompt(agents: WeaveAgentConfig[], config: WeaveConfig, skills: LoadedSkill[]): string {
  const loom = agents.find(a => a.name === "loom");
  if (!loom) return "";
  const enabled = new Set(agents.map(a => a.name));

  const delegationLines: string[] = [];
  if (enabled.has("thread"))   delegationLines.push("- Use thread for fast codebase exploration (read-only, cheap)");
  if (enabled.has("spindle"))  delegationLines.push("- Use spindle for external docs and research (read-only)");
  if (enabled.has("pattern"))  delegationLines.push("- Use pattern for planning, scoping, and work breakdown before substantial implementation begins");
  if (enabled.has("tapestry")) delegationLines.push("- Use /start-work to hand off to Tapestry for todo-list driven execution of multi-step plans");
  if (enabled.has("shuttle"))  delegationLines.push("- Use shuttle for category-specific specialist work");
  if (enabled.has("weft")) {
    let line = "- Use Weft for reviewing completed work or validating plans before execution";
    if (enabled.has("warp")) line += "\n  - MUST use Warp for security audits when changes touch auth, crypto, tokens, secrets, sessions, CORS, CSP, .env files, or OAuth/OIDC/SAML flows — not optional.";
    delegationLines.push(line);
  } else if (enabled.has("warp")) {
    delegationLines.push("- MUST use Warp for security audits on security-relevant changes");
  }
  delegationLines.push("- Delegate aggressively to keep your context lean");

  let prompt = loom.systemPrompt;
  prompt = prompt.replace(/<Delegation>[\s\S]*?<\/Delegation>/, `<Delegation>\n${delegationLines.join("\n")}\n</Delegation>`);
  if (!enabled.has("weft") && !enabled.has("warp")) prompt = prompt.replace(/<ReviewWorkflow>[\s\S]*?<\/ReviewWorkflow>/, "");

  const steps: string[] = [];
  let n = 1;
  if (enabled.has("pattern")) { steps.push(`${n}. PLAN: Delegate to Pattern → \`.weave/plans/{name}.md\``); n++; }
  const reviewers: string[] = [];
  if (enabled.has("weft")) reviewers.push("Weft");
  if (enabled.has("warp")) reviewers.push("Warp for security-relevant plans");
  if (reviewers.length) { steps.push(`${n}. REVIEW: ${reviewers.join(", ")}`); n++; }
  if (enabled.has("tapestry")) { steps.push(`${n}. EXECUTE: \`/start-work\``); n++; }
  steps.push(`${n}. RESUME: \`/start-work\` also resumes`);
  prompt = prompt.replace(/<PlanWorkflow>[\s\S]*?<\/PlanWorkflow>/, `<PlanWorkflow>\nPlans are executed by Tapestry. Tell user to run \`/start-work\`.\n\n${steps.join("\n")}\n\nUse for large features, multi-file refactors, or 5+ step tasks.\n</PlanWorkflow>`);

  prompt = prompt.replace(
    /<DelegationNarration>[\s\S]*?<\/DelegationNarration>/,
    `<DelegationNarration>\nWhen delegating:\n1. Tell the user which agent you're delegating to by name and why\n2. Summarize results when agents return\n3. For independent tasks, use parallel mode: tasks=[{agent,task},...]\n4. For sequential pipelines, use chain mode: chain=[{agent,task},...] with {previous}\n</DelegationNarration>`,
  );

  prompt += `\n\n<AvailableAgents>\n${agents.filter(a => a.name !== "loom").map(a => `- ${a.name}: ${a.description}`).join("\n")}\n</AvailableAgents>`;

  if (config.categories && Object.keys(config.categories).length > 0) {
    prompt += `\n\n<CategoryRouting>\n${Object.entries(config.categories).map(([n, c]) => `- shuttle-${n}${c.description ? ` — ${c.description}` : ""}${c.model ? ` [${c.model}]` : ""}`).join("\n")}\n</CategoryRouting>`;
  }

  const append = config.agents?.loom?.prompt_append;
  if (append) prompt += `\n\n${append}`;

  // Inject loom-specific skills
  const loomSkills = getAgentSkills("loom", skills, config);
  const skillSection = buildSkillInjection(loomSkills);
  if (skillSection) prompt += `\n\n${skillSection}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtUsage(u: { input: number; output: number; cost: number }, turns: number, model?: string): string {
  const p: string[] = [];
  if (turns) p.push(`${turns} turn${turns > 1 ? "s" : ""}`);
  if (u.input) p.push(`↑${u.input > 1000 ? Math.round(u.input / 1000) + "k" : u.input}`);
  if (u.cost) p.push(`$${u.cost.toFixed(4)}`);
  if (model) p.push(model);
  return p.join(" ");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()) });
const ChainItem = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()) });
const TaskParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(TaskItem)),
  chain: Type.Optional(Type.Array(ChainItem)),
});

export default function weaveExtension(pi: ExtensionAPI) {
  let configResult: ConfigLoadResult | null = null;
  let config: WeaveConfig = {};
  let cachedAgents: WeaveAgentConfig[] | null = null;

  // Hook state
  let writeGuard = new WriteGuard();
  let hookConfig: HookConfig = { writeGuardEnabled: true, verificationReminderEnabled: true, keywordDetectorEnabled: true, compactionRecoveryEnabled: true, rulesInjectorEnabled: true };
  let toolCallCount = 0;
  let keywordInjection: string | undefined;

  // Skill state
  let cachedSkills: LoadedSkill[] | null = null;

  // Analytics state
  let activeTracker: SessionTracker | null = null;

  function getAgents(cwd: string): WeaveAgentConfig[] {
    if (!cachedAgents) cachedAgents = discoverWeaveAgents(cwd, new Set(config.disabled_agents ?? []));
    return cachedAgents;
  }
  function invalidateCache() { cachedAgents = null; cachedSkills = null; }
  function getConcurrency(): number { return config.background?.defaultConcurrency ?? DEFAULT_CONCURRENCY; }

  function getSkills(cwd: string): LoadedSkill[] {
    if (!cachedSkills) cachedSkills = discoverSkills(cwd, config);
    return cachedSkills;
  }

  function reloadConfig(cwd: string) {
    configResult = loadWeaveConfig(cwd);
    config = configResult.config;
    hookConfig = resolveHookConfig(config);
    invalidateCache();
    writeGuard.reset();
    if (configResult.loadedFiles.length > 0) console.info(`[weave] Config: ${configResult.loadedFiles.join(", ")}`);
    for (const d of configResult.diagnostics) console.warn(`[weave] ${d.level}: ${d.message}`);
  }

  // =======================================================================
  // HOOKS — governance layer for the main Loom agent
  // =======================================================================

  // --- Keyword Detector (input event) ---
  pi.on("input", async (event, _ctx) => {
    if (!hookConfig.keywordDetectorEnabled) return { action: "continue" };
    const injection = detectKeywords(event.text);
    if (injection) {
      keywordInjection = injection;
      console.info(`[weave] Keyword detected in input`);
    }
    return { action: "continue" };
  });

  // --- System prompt injection (before_agent_start) ---
  pi.on("before_agent_start", async (_event, ctx) => {
    const systemPrompt = buildLoomSystemPrompt(getAgents(ctx.cwd), config, getSkills(ctx.cwd));
    if (!systemPrompt) return;

    let message: string | undefined;
    const parts: string[] = [];

    // Keyword injection
    if (keywordInjection) {
      parts.push(keywordInjection);
      keywordInjection = undefined;
    }

    // Verification reminder (every 6+ tool calls)
    if (hookConfig.verificationReminderEnabled && toolCallCount >= 6) {
      parts.push(buildVerificationReminder());
      toolCallCount = 0;
    }

    if (parts.length > 0) message = parts.join("\n\n");

    return {
      systemPrompt,
      ...(message ? { message: { customType: "weave-hooks", content: message, display: false } } : {}),
    };
  });

  // --- Write Guard + Rules Injector (tool_call event) ---
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;

    // Track reads for write guard
    if (hookConfig.writeGuardEnabled) {
      if (event.toolName === "read" || event.toolName === "bash") {
        const filePath = event.input?.path || event.input?.file_path;
        if (typeof filePath === "string") writeGuard.trackRead(filePath);
        // Bash commands might read files — track common patterns
        if (event.toolName === "bash" && typeof event.input?.command === "string") {
          const cmd = event.input.command as string;
          const catMatch = cmd.match(/cat\s+["']?([^\s"']+)/);
          const lessMatch = cmd.match(/less\s+["']?([^\s"']+)/);
          if (catMatch) writeGuard.trackRead(catMatch[1]);
          if (lessMatch) writeGuard.trackRead(lessMatch[1]);
        }
      }

      // Block writes to unread files
      if (event.toolName === "write" || event.toolName === "edit") {
        const filePath = event.input?.path || event.input?.file_path;
        if (typeof filePath === "string") {
          // Allow writes to .weave/ always (plans, state)
          if (isPathInWeaveDir(filePath, cwd)) {
            // Allowed — weave directory
          } else {
            const check = writeGuard.check(filePath);
            if (!check.allowed) {
              return { block: true, reason: check.warning };
            }
          }
        }
      }
    }

    // Rules injector: when reading a file, inject any rules from that directory
    // (PI already loads AGENTS.md natively, but this adds per-directory context)
    // This is a soft enhancement — we don't inject anything, just track for future use.

    // Increment tool call counter for verification reminder
    toolCallCount++;
  });

  // --- Compaction Recovery (session_before_compact) ---
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!hookConfig.compactionRecoveryEnabled) return;
    const recovery = buildCompactionRecoveryPrompt(ctx.cwd);
    if (recovery) return { compaction: { summary: recovery } };
  });

  // --- Work Continuation (agent_end) --- inject continuation if plan incomplete
  pi.on("agent_end", async (_event, ctx) => {
    if (!hookConfig.compactionRecoveryEnabled) return;
    const continuation = buildWorkContinuationPrompt(ctx.cwd);
    if (!continuation) return;
    pi.sendMessage(
      { customType: "weave-continuation", content: continuation, display: true },
      { triggerTurn: true, deliverAs: "nextTurn" },
    );
  });

  // --- Context Window Monitor (turn_end) ---
  pi.on("turn_end", async (_event, ctx) => {
    const warn = config.experimental?.context_window_warning_threshold ?? 0.8;
    const crit = config.experimental?.context_window_critical_threshold ?? 0.95;
    const usage = ctx.getContextUsage();
    if (!usage) return;
    const ratio = usage.tokens / (usage.maxTokens || 200_000);
    if (ratio >= crit) ctx.ui.notify(`⚠️ Context at ${Math.round(ratio * 100)}%. /compact or new session.`, "error");
    else if (ratio >= warn) ctx.ui.notify(`Context at ${Math.round(ratio * 100)}%.`, "info");
  });

  // =======================================================================
  // TASK TOOL — single / parallel / chain
  // =======================================================================

  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Delegate tasks to specialized Weave agents. Single ({agent,task}), parallel ({tasks:[...]}), or chain ({chain:[...]} with {previous}).",
    promptSnippet: "Delegate to a specialized Weave agent",
    promptGuidelines: [
      "Use task tool when work benefits from a specialist.",
      "Parallel mode (tasks=[...]) for independent concurrent work.",
      "Chain mode (chain=[...]) for sequential pipelines with {previous}.",
      "thread=explore, pattern=plan, shuttle=implement, weft=review, warp=security.",
    ],
    parameters: TaskParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = getAgents(ctx.cwd);
      const concurrency = getConcurrency();
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        return { content: [{ type: "text", text: `Provide one mode: {agent,task}, {tasks:[...]}, or {chain:[...]}.\nAgents: ${agents.map(a => a.name).join(", ")}` }] };
      }

      // CHAIN
      if (hasChain && params.chain) {
        const results: SubagentResult[] = [];
        let previousOutput = "";
        for (let i = 0; i < params.chain.length; i++) {
          const s = params.chain[i];
          const taskText = s.task.replace(/\{previous\}/g, previousOutput);
          const agent = resolveAgent(s.agent, agents, config, getSkills(ctx.cwd));
          if (!agent) return { content: [{ type: "text", text: `Chain step ${i + 1}: unknown agent "${s.agent}"` }], isError: true };
          try {
            const r = await runSubagent(s.cwd ?? ctx.cwd, agent, taskText, signal, i + 1);
            results.push(r);
            if (r.exitCode !== 0) {
              return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${agent.name}): ${r.stderr || r.output}` }], details: { mode: "chain", results }, isError: true };
            }
            previousOutput = r.output;
          } catch (err: any) {
            if (err.message === "Subagent was aborted") return { content: [{ type: "text", text: `Chain aborted at step ${i + 1}` }], details: { mode: "chain", results }, isError: true };
            return { content: [{ type: "text", text: `Chain error at step ${i + 1}: ${err.message}` }], isError: true };
          }
        }
        const summary = results.map((r, i) => `**Step ${i + 1} (${r.agent})**: ${r.output.slice(0, 200)}`).join("\n\n");
        const totalU = results.reduce((a, r) => ({ input: a.input + r.usage.input, output: a.output + r.usage.output, cost: a.cost + r.usage.cost }), { input: 0, output: 0, cost: 0 });
        return { content: [{ type: "text", text: `**Chain complete (${results.length} steps)**\n\n${summary}\n\n_${fmtUsage(totalU, results.reduce((a, r) => a + r.turns, 0))}_` }], details: { mode: "chain", results } };
      }

      // PARALLEL
      if (hasTasks && params.tasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) return { content: [{ type: "text", text: `Max ${MAX_PARALLEL_TASKS} parallel tasks.` }] };
        const allResults: SubagentResult[] = params.tasks.map(t => ({ agent: t.agent, task: t.task, exitCode: -1, output: "", stderr: "", turns: 0, usage: { input: 0, output: 0, cost: 0 } }));
        const emitUpdate = () => { if (onUpdate) { const done = allResults.filter(r => r.exitCode >= 0).length; onUpdate({ content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done...` }], details: { mode: "parallel", results: allResults } }); } };
        const results = await mapWithConcurrency(params.tasks, concurrency, async (t, idx) => {
          const agent = resolveAgent(t.agent, agents, config, getSkills(ctx.cwd));
          if (!agent) { allResults[idx] = { agent: t.agent, task: t.task, exitCode: 1, output: "", stderr: `Unknown: ${t.agent}`, turns: 0, usage: { input: 0, output: 0, cost: 0 } }; emitUpdate(); return allResults[idx]; }
          try { const r = await runSubagent(t.cwd ?? ctx.cwd, agent, t.task, signal); allResults[idx] = r; emitUpdate(); return r; }
          catch (err: any) { allResults[idx] = { agent: agent.name, task: t.task, exitCode: 1, output: "", stderr: err.message, turns: 0, usage: { input: 0, output: 0, cost: 0 } }; emitUpdate(); return allResults[idx]; }
        });
        const ok = results.filter(r => r.exitCode === 0).length;
        const summaries = results.map(r => `${r.exitCode === 0 ? "✓" : "✗"} **${r.agent}**: ${r.output.slice(0, 150) || r.stderr || "(no output)"}`);
        const totalU = results.reduce((a, r) => ({ input: a.input + r.usage.input, output: a.output + r.usage.output, cost: a.cost + r.usage.cost }), { input: 0, output: 0, cost: 0 });
        return { content: [{ type: "text", text: `**Parallel: ${ok}/${results.length} succeeded**\n\n${summaries.join("\n\n")}\n\n_${fmtUsage(totalU, results.reduce((a, r) => a + r.turns, 0))}_` }], details: { mode: "parallel", results } };
      }

      // SINGLE
      if (params.agent && params.task) {
        const agent = resolveAgent(params.agent, agents, config, getSkills(ctx.cwd));
        if (!agent) return { content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${agents.map(a => a.name).join(", ")}` }] };
        try {
          const r = await runSubagent(params.cwd ?? ctx.cwd, agent, params.task, signal);
          if (r.exitCode !== 0) return { content: [{ type: "text", text: `[${agent.name}] failed: ${r.stderr || r.output}` }], isError: true };
          activeTracker?.trackDelegation({ agent: agent.name, task: params.task, exitCode: 0, turns: r.turns, cost: r.usage.cost, model: r.model });
          return { content: [{ type: "text", text: r.output || "(no output)" }], details: { mode: "single", agent: agent.name, turns: r.turns, model: r.model, usage: r.usage } };
        } catch (err: any) {
          if (err.message === "Subagent was aborted") return { content: [{ type: "text", text: `[${agent.name}] aborted` }], isError: true };
          return { content: [{ type: "text", text: `[${agent.name}] error: ${err.message}` }], isError: true };
        }
      }

      return { content: [{ type: "text", text: "No valid mode." }] };
    },
  });

  // =======================================================================
  // COMMANDS
  // =======================================================================

  pi.registerCommand("start-work", {
    description: "Start or resume a Weave plan",
    handler: async (args, ctx) => {
      const weaveDir = path.join(ctx.cwd, ".weave");
      const plansDir = path.join(weaveDir, "plans");
      fs.mkdirSync(plansDir, { recursive: true });

      const select = async () => {
        if (!fs.existsSync(plansDir)) { ctx.ui.notify("No plans.", "info"); return null; }
        const plans = fs.readdirSync(plansDir).filter(f => f.endsWith(".md"));
        if (!plans.length) { ctx.ui.notify("No plans.", "info"); return null; }
        return ctx.ui.select("Select plan:", plans.map(p => p.replace(/\.md$/, "")));
      };
      const name = args?.trim() || await select();
      if (!name) return;

      // Find plan file
      let planPath: string | null = null;
      for (const ext of [".md", ""]) { const p = path.join(plansDir, name + ext); if (fs.existsSync(p)) { planPath = p; break; } }
      if (!planPath) {
        try {
          const files = fs.readdirSync(plansDir).filter(f => f.endsWith(".md"));
          const match = files.find(f => f.toLowerCase().includes(name.toLowerCase()));
          if (match) planPath = path.join(plansDir, match);
        } catch { /* */ }
      }
      if (!planPath) { ctx.ui.notify(`Not found: ${name}`, "error"); return; }

      const planBasename = path.basename(planPath, ".md");
      const progress = getPlanProgress(planPath);

      // Check for existing work state
      const existingState = readWorkState(weaveDir);
      if (existingState && existingState.active_plan === planPath && existingState.paused) {
        // Resume paused work
        resumeWork(weaveDir);
        ctx.ui.notify(`Resumed: ${planBasename} (${progress.completed}/${progress.total})`, "info");
      } else if (existingState && existingState.active_plan !== planPath) {
        // Different plan — clear old state and start fresh
        clearWorkState(weaveDir);
        const state = createWorkState(planPath, planBasename, "cmd", ctx.cwd);
        writeWorkState(weaveDir, state);
        ctx.ui.notify(`Started: ${planBasename} (${progress.completed}/${progress.total})`, "info");
      } else if (existingState) {
        // Same plan, already running — just resume
        appendSessionId(weaveDir, "cmd");
        ctx.ui.notify(`Continuing: ${planBasename} (${progress.completed}/${progress.total})`, "info");
      } else {
        // Fresh start
        const state = createWorkState(planPath, planBasename, "cmd", ctx.cwd);
        writeWorkState(weaveDir, state);
        ctx.ui.notify(`Started: ${planBasename} (${progress.completed}/${progress.total})`, "info");
      }

      // Build execution prompt for Tapestry
      const execPrompt = progress.completed > 0
        ? `Resume plan execution at \`${planPath}\`. Progress: ${progress.completed}/${progress.total} tasks completed. Read the plan, find the first unchecked task, and continue. agent="tapestry"`
        : `Execute plan at \`${planPath}\` from the beginning. Read the plan, then delegate each task to shuttle via the task tool. agent="tapestry"`;

      pi.sendUserMessage(execPrompt);
    },
  });

  pi.registerCommand("plans", {
    description: "List Weave plans",
    handler: async (_args, ctx) => {
      const dir = path.join(ctx.cwd, ".weave", "plans");
      if (!fs.existsSync(dir)) { ctx.ui.notify("No plans dir.", "info"); return; }
      const plans = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
      if (!plans.length) { ctx.ui.notify("No plans.", "info"); return; }
      ctx.ui.notify(plans.map(p => { const g = getPlanProgress(path.join(dir, p)); return `${g.isComplete ? "✓" : g.completed + "/" + g.total}  ${p.replace(/\.md$/, "")}`; }).join("\n"), "info");
    },
  });

  pi.registerCommand("weave-config", {
    description: "Show Weave configuration",
    handler: async (_args, ctx) => {
      if (!configResult) { ctx.ui.notify("No config.", "info"); return; }
      const l: string[] = [configResult.loadedFiles.length ? "Files: " + configResult.loadedFiles.join(", ") : "Files: (defaults)"];
      if (config.disabled_agents?.length) l.push(`Disabled agents: ${config.disabled_agents.join(", ")}`);
      if (config.disabled_tools?.length) l.push(`Disabled tools: ${config.disabled_tools.join(", ")}`);
      if (config.categories) l.push(`Categories: ${Object.entries(config.categories).map(([k, v]) => k + (v.model ? ` (${v.model})` : "")).join(", ")}`);
      l.push(`Concurrency: ${getConcurrency()}`);
      l.push(`Hooks: writeGuard=${hookConfig.writeGuardEnabled}, verify=${hookConfig.verificationReminderEnabled}, keywords=${hookConfig.keywordDetectorEnabled}, compaction=${hookConfig.compactionRecoveryEnabled}`);
      l.push(`Analytics: ${config.analytics?.enabled ? "on" : "off"}`);
      ctx.ui.notify(l.join("\n"), "info");
    },
  });

  // -----------------------------------------------------------------------
  // /token-report — show token usage and cost breakdown
  // -----------------------------------------------------------------------
  pi.registerCommand("token-report", {
    description: "Show Weave token usage and cost report",
    handler: async (_args, ctx) => {
      const weaveDir = path.join(ctx.cwd, ".weave");
      const summaries = readSessionSummaries(weaveDir);
      const report = generateTokenReport(summaries);
      ctx.ui.notify(report, "info");
    },
  });

  // =======================================================================
  // LIFECYCLE
  // =======================================================================

  pi.on("session_start", async (_event, ctx) => {
    ensureWeaveDir(ctx.cwd);
    reloadConfig(ctx.cwd);
    writeGuard.reset();
    toolCallCount = 0;
    keywordInjection = undefined;
    // Start analytics tracker if enabled
    if (config.analytics?.enabled) {
      activeTracker = new SessionTracker("session-" + Date.now());
    }
  });

  pi.on("resources_discover", async (event, _ctx) => {
    const dirs: string[] = [];
    const ws = path.join(event.cwd, ".weave", "skills");
    if (fs.existsSync(ws)) dirs.push(ws);
    for (const d of config.skill_directories ?? []) { const abs = path.resolve(event.cwd, d); if (fs.existsSync(abs)) dirs.push(abs); }
    return dirs.length ? { skillPaths: dirs } : {};
  });

  // --- Session shutdown: finalize analytics ---
  pi.on("session_shutdown", async (_event, ctx) => {
    if (activeTracker && config.analytics?.enabled) {
      const weaveDir = path.join(ctx.cwd, ".weave");
      const summary = activeTracker.finalize();
      appendSessionSummary(weaveDir, summary);
      activeTracker = null;
    }
  });
}

/**
 * Weave hooks — governance + work state management
 *
 * Phase 4 additions:
 *   - Full WorkState CRUD (create/read/write/clear)
 *   - Plan progress tracking via checkbox counting
 *   - Git HEAD SHA capture for post-execution review
 *   - Pause/resume support
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { WeaveConfig } from "../config/schema";

// ---------------------------------------------------------------------------
// Work State types & storage
// ---------------------------------------------------------------------------

export interface WorkState {
  active_plan: string;
  plan_name: string;
  started_at: string;
  session_ids: string[];
  agent?: string;
  start_sha?: string;
  paused?: boolean;
}

const WORK_STATE_FILE = "state.json";

export function readWorkState(weaveDir: string): WorkState | null {
  try {
    const p = path.join(weaveDir, WORK_STATE_FILE);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

export function writeWorkState(weaveDir: string, state: WorkState): void {
  fs.writeFileSync(path.join(weaveDir, WORK_STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

export function clearWorkState(weaveDir: string): void {
  const p = path.join(weaveDir, WORK_STATE_FILE);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
}

export function createWorkState(planPath: string, planName: string, sessionId: string, cwd: string, agent = "tapestry"): WorkState {
  let startSha: string | undefined;
  try { startSha = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim(); } catch { /* not a git repo */ }
  return { active_plan: planPath, plan_name: planName, started_at: new Date().toISOString(), session_ids: [sessionId], agent, start_sha: startSha };
}

export function appendSessionId(weaveDir: string, sessionId: string): WorkState | null {
  const state = readWorkState(weaveDir);
  if (!state) return null;
  if (!state.session_ids.includes(sessionId)) state.session_ids.push(sessionId);
  writeWorkState(weaveDir, state);
  return state;
}

export function pauseWork(weaveDir: string): boolean {
  const state = readWorkState(weaveDir);
  if (!state) return false;
  state.paused = true;
  writeWorkState(weaveDir, state);
  return true;
}

export function resumeWork(weaveDir: string): boolean {
  const state = readWorkState(weaveDir);
  if (!state) return false;
  state.paused = false;
  writeWorkState(weaveDir, state);
  return true;
}

// ---------------------------------------------------------------------------
// Plan progress
// ---------------------------------------------------------------------------

export interface PlanProgress {
  total: number;
  completed: number;
  isComplete: boolean;
}

export function getPlanProgress(planPath: string): PlanProgress {
  try {
    const c = fs.readFileSync(planPath, "utf-8");
    const all = c.match(/- \[[ x]\]/g) ?? [];
    const done = c.match(/- \[x\]/g) ?? [];
    return { total: all.length, completed: done.length, isComplete: all.length > 0 && all.length === done.length };
  } catch { return { total: 0, completed: 0, isComplete: false }; }
}

export function findPlans(weaveDir: string): string[] {
  const plansDir = path.join(weaveDir, "plans");
  if (!fs.existsSync(plansDir)) return [];
  try {
    return fs.readdirSync(plansDir).filter(f => f.endsWith(".md")).sort().map(f => path.join(plansDir, f));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Write Guard
// ---------------------------------------------------------------------------

export class WriteGuard {
  private readFiles = new Set<string>();
  trackRead(fp: string) { this.readFiles.add(path.resolve(fp)); }
  check(fp: string): { allowed: boolean; warning?: string } {
    const r = path.resolve(fp);
    if (!fs.existsSync(r)) return { allowed: true };
    if (this.readFiles.has(r)) return { allowed: true };
    return { allowed: false, warning: `Write guard: read \`${fp}\` before overwriting.` };
  }
  reset() { this.readFiles.clear(); }
}

// ---------------------------------------------------------------------------
// Keyword Detector
// ---------------------------------------------------------------------------

const KEYWORDS = [
  { keyword: "ultrawork", injection: "[ULTRAWORK MODE ACTIVATED]\nMaximum effort. Use ALL agents in parallel. No shortcuts." },
  { keyword: "ulw", injection: "[ULTRAWORK MODE ACTIVATED]\nMaximum effort. Use ALL agents in parallel. No shortcuts." },
];

export function detectKeywords(message: string): string | undefined {
  const lower = message.toLowerCase();
  const hits = KEYWORDS.filter(k => lower.includes(k.keyword));
  return hits.length ? hits.map(h => h.injection).join("\n\n") : undefined;
}

// ---------------------------------------------------------------------------
// Verification Reminder
// ---------------------------------------------------------------------------

export function buildVerificationReminder(planName?: string, progress?: PlanProgress): string {
  const ctx = planName && progress ? `\n**Plan**: ${planName} (${progress.completed}/${progress.total})` : "";
  return `## Verification Required\n${ctx}\n\nBefore marking complete:\n1. Read changed files\n2. Run tests/checks\n3. Validate behavior matches requirements\n4. Security gate: auth/crypto/token changes → delegate to warp (mandatory)`;
}

// ---------------------------------------------------------------------------
// Compaction Recovery
// ---------------------------------------------------------------------------

export function buildCompactionRecoveryPrompt(cwd: string): string | null {
  const weaveDir = path.join(cwd, ".weave");
  const state = readWorkState(weaveDir);
  if (!state || state.paused) return null;
  if (!fs.existsSync(state.active_plan)) return null;
  const progress = getPlanProgress(state.active_plan);
  if (progress.isComplete || progress.total === 0) return null;
  const remaining = progress.total - progress.completed;
  return [
    "## Context Restored After Compaction",
    "Resume your active work plan.",
    "",
    `**Plan**: ${state.plan_name}`,
    `**File**: \`${state.active_plan}\``,
    `**Progress**: ${progress.completed}/${progress.total} tasks completed (${remaining} remaining)`,
    "",
    "1. Read the plan file and re-check the first unchecked task",
    "2. Continue execution from the current state",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Continuation prompt (for session.idle equivalent)
// ---------------------------------------------------------------------------

export function buildWorkContinuationPrompt(cwd: string): string | null {
  const weaveDir = path.join(cwd, ".weave");
  const state = readWorkState(weaveDir);
  if (!state || state.paused) return null;
  if (!fs.existsSync(state.active_plan)) return null;
  const progress = getPlanProgress(state.active_plan);
  if (progress.isComplete || progress.total === 0) return null;
  const remaining = progress.total - progress.completed;
  return `Active work: ${state.plan_name} — ${progress.completed}/${progress.total} done (${remaining} remaining). Continue from first unchecked task.`;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function isPathInWeaveDir(fp: string, cwd: string): boolean {
  const weave = path.resolve(cwd, ".weave");
  const r = path.resolve(fp);
  return r.startsWith(weave + path.sep) || r === weave;
}

// ---------------------------------------------------------------------------
// Hook config
// ---------------------------------------------------------------------------

export interface HookConfig {
  writeGuardEnabled: boolean;
  verificationReminderEnabled: boolean;
  keywordDetectorEnabled: boolean;
  compactionRecoveryEnabled: boolean;
  rulesInjectorEnabled: boolean;
}

export function resolveHookConfig(cfg: WeaveConfig): HookConfig {
  const d = new Set(cfg.disabled_hooks ?? []);
  return {
    writeGuardEnabled: !d.has("write-existing-file-guard"),
    verificationReminderEnabled: !d.has("verification-reminder"),
    keywordDetectorEnabled: !d.has("keyword-detector"),
    compactionRecoveryEnabled: !d.has("work-continuation"),
    rulesInjectorEnabled: !d.has("rules-injector"),
  };
}

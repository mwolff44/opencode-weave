/**
 * Weave Analytics — session tracking, token reports, and cost analysis
 *
 * Lightweight analytics that writes JSONL session summaries to .weave/analytics/.
 * Opt-in via config: analytics.enabled = true
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalMessages: number;
}

export interface DelegationRecord {
  agent: string;
  task: string;
  exitCode: number;
  turns: number;
  cost: number;
  model?: string;
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  agentName?: string;
  model?: string;
  delegations: DelegationRecord[];
  totalCost: number;
  tokenUsage: TokenUsage;
  planName?: string;
}

const zeroTokens: TokenUsage = {
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, totalMessages: 0,
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const ANALYTICS_DIR = "analytics";
const SESSIONS_FILE = "sessions.jsonl";

function ensureAnalyticsDir(weaveDir: string): string {
  const dir = path.join(weaveDir, ANALYTICS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendSessionSummary(weaveDir: string, summary: SessionSummary): void {
  const dir = ensureAnalyticsDir(weaveDir);
  const line = JSON.stringify(summary) + "\n";
  fs.appendFileSync(path.join(dir, SESSIONS_FILE), line, "utf-8");
}

export function readSessionSummaries(weaveDir: string): SessionSummary[] {
  const p = path.join(weaveDir, ANALYTICS_DIR, SESSIONS_FILE);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, "utf-8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Session Tracker (tracks one active session)
// ---------------------------------------------------------------------------

export class SessionTracker {
  private sessionId: string;
  private startedAt: string;
  private delegations: DelegationRecord[] = [];
  private totalCost = 0;
  private tokens: TokenUsage = { ...zeroTokens };
  private agentName?: string;
  private model?: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startedAt = new Date().toISOString();
  }

  trackDelegation(record: DelegationRecord): void {
    this.delegations.push(record);
    this.totalCost += record.cost;
  }

  trackTokens(usage: Partial<TokenUsage>): void {
    this.tokens.inputTokens += usage.inputTokens ?? 0;
    this.tokens.outputTokens += usage.outputTokens ?? 0;
    this.tokens.reasoningTokens += usage.reasoningTokens ?? 0;
    this.tokens.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.tokens.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.tokens.totalMessages += usage.totalMessages ?? 0;
  }

  setAgent(name: string): void { this.agentName = name; }
  setModel(model: string): void { this.model = model; }

  getSessionId(): string { return this.sessionId; }

  finalize(planName?: string): SessionSummary {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      agentName: this.agentName,
      model: this.model,
      delegations: this.delegations,
      totalCost: this.totalCost,
      tokenUsage: this.tokens,
      planName,
    };
  }
}

// ---------------------------------------------------------------------------
// Token Report Generator
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

export function generateTokenReport(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return "No session data available.";

  const lines: string[] = ["## Token Usage Report\n"];

  // Overall totals
  const totalInput = summaries.reduce((s, r) => s + r.tokenUsage.inputTokens, 0);
  const totalOutput = summaries.reduce((s, r) => s + r.tokenUsage.outputTokens, 0);
  const totalCost = summaries.reduce((s, r) => s + r.totalCost, 0);
  const totalDelegations = summaries.reduce((s, r) => s + r.delegations.length, 0);

  lines.push(`**${summaries.length} sessions** | ${fmt(totalInput)} in / ${fmt(totalOutput)} out | ${fmtCost(totalCost)} total | ${totalDelegations} delegations`);

  // Per-agent breakdown
  const agentGroups = new Map<string, { cost: number; sessions: number; tokens: number }>();
  for (const s of summaries) {
    const key = s.agentName ?? "(unknown)";
    const g = agentGroups.get(key) ?? { cost: 0, sessions: 0, tokens: 0 };
    g.cost += s.totalCost;
    g.sessions++;
    g.tokens += s.tokenUsage.inputTokens + s.tokenUsage.outputTokens;
    agentGroups.set(key, g);
  }

  if (agentGroups.size > 0) {
    lines.push("\n### Per Agent\n");
    for (const [agent, g] of [...agentGroups.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(`- **${agent}**: ${g.sessions} sessions, ${fmt(g.tokens)} tokens, ${fmtCost(g.cost)}`);
    }
  }

  // Per-model breakdown
  const modelGroups = new Map<string, { cost: number; sessions: number }>();
  for (const s of summaries) {
    if (!s.model) continue;
    const g = modelGroups.get(s.model) ?? { cost: 0, sessions: 0 };
    g.cost += s.totalCost;
    g.sessions++;
    modelGroups.set(s.model, g);
  }

  if (modelGroups.size > 0) {
    lines.push("\n### Per Model\n");
    for (const [model, g] of [...modelGroups.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(`- **${model}**: ${g.sessions} sessions, ${fmtCost(g.cost)}`);
    }
  }

  return lines.join("\n");
}

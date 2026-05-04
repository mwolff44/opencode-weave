/**
 * Weave config schema — Zod validation for weave-config.jsonc
 * Ported from opencode-weave/src/config/schema.ts
 */
import { z } from "zod";
import { isAbsolute } from "node:path";

const SafeRelativePathSchema = z.string().refine(
  (p) => {
    if (typeof process !== "undefined" && process.platform === "win32") {
      return !isAbsolute(p) && !p.split(/[/\\]/).includes("..");
    }
    return !isAbsolute(p) && !p.split("/").includes("..");
  },
  { message: "Directory paths must be relative and must not contain '..' segments" },
);

const ModelOptionsSchema = z.record(z.string(), z.unknown());

export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
  fallback_models: z.array(z.string()).optional(),
  variant: z.string().optional(),
  category: z.string().optional(),
  skills: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  prompt: z.string().optional(),
  prompt_append: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  modelOptions: ModelOptionsSchema.optional(),
  disable: z.boolean().optional(),
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  maxTokens: z.number().optional(),
  display_name: z.string().optional(),
});

export const AgentOverridesSchema = z.record(z.string(), AgentOverrideConfigSchema);

export const CategoryConfigSchema = z.object({
  description: z.string().optional(),
  model: z.string().optional(),
  fallback_models: z.array(z.string()).optional(),
  variant: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  maxTokens: z.number().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  prompt_append: z.string().optional(),
  disable: z.boolean().optional(),
  patterns: z.array(z.string()).optional(),
});

export const CategoriesConfigSchema = z.record(z.string(), CategoryConfigSchema);

export const BackgroundConfigSchema = z.object({
  defaultConcurrency: z.number().min(1).optional(),
  providerConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  modelConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  staleTimeoutMs: z.number().min(60000).optional(),
});

export const ContinuationRecoveryConfigSchema = z.object({
  compaction: z.boolean().optional(),
});

export const ContinuationIdleConfigSchema = z.object({
  enabled: z.boolean().optional(),
  work: z.boolean().optional(),
  workflow: z.boolean().optional(),
  todo_prompt: z.boolean().optional(),
});

export const ContinuationConfigSchema = z.object({
  recovery: ContinuationRecoveryConfigSchema.optional(),
  idle: ContinuationIdleConfigSchema.optional(),
});

export const AnalyticsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  use_fingerprint: z.boolean().optional(),
});

export const ExperimentalConfigSchema = z.object({
  context_window_warning_threshold: z.number().min(0).max(1).optional(),
  context_window_critical_threshold: z.number().min(0).max(1).optional(),
});

export const CustomAgentConfigSchema = z.object({
  prompt: z.string().optional(),
  prompt_file: z.string().optional(),
  model: z.string().optional(),
  display_name: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  fallback_models: z.array(z.string()).optional(),
  category: z.enum(["exploration", "specialist", "advisor", "utility"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  skills: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const CustomAgentsConfigSchema = z.record(z.string(), CustomAgentConfigSchema);

export const WorkflowConfigSchema = z.object({
  disabled_workflows: z.array(z.string()).optional(),
  directories: z.array(SafeRelativePathSchema).optional(),
});

export const WeaveConfigSchema = z.object({
  $schema: z.string().optional(),
  agents: AgentOverridesSchema.optional(),
  custom_agents: CustomAgentsConfigSchema.optional(),
  categories: CategoriesConfigSchema.optional(),
  disabled_hooks: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
  disabled_agents: z.array(z.string()).optional(),
  disabled_skills: z.array(z.string()).optional(),
  skill_directories: z.array(SafeRelativePathSchema).optional(),
  background: BackgroundConfigSchema.optional(),
  analytics: AnalyticsConfigSchema.optional(),
  continuation: ContinuationConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  workflows: WorkflowConfigSchema.optional(),
  log_level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional(),
});

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;
export type CategoriesConfig = z.infer<typeof CategoriesConfigSchema>;
export type CategoryConfig = z.infer<typeof CategoryConfigSchema>;
export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;
export type ContinuationConfig = z.infer<typeof ContinuationConfigSchema>;
export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;
export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;
export type CustomAgentsConfig = z.infer<typeof CustomAgentsConfigSchema>;
export type CustomAgentConfig = z.infer<typeof CustomAgentConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
export type WeaveConfig = z.infer<typeof WeaveConfigSchema>;

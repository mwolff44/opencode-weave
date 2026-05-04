/**
 * Config loader — loads and validates weave-config.jsonc from user + project dirs
 * Adapted from opencode-weave for PI's directory structure.
 *
 * PI paths:
 *   User config:    ~/.pi/agent/weave-config.jsonc (or .json)
 *   Project config: .pi/weave-config.jsonc (or .json)
 *
 * OpenCode paths (original):
 *   User config:    ~/.config/opencode/weave-opencode.jsonc
 *   Project config: .opencode/weave-opencode.jsonc
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeConfigs } from "./merge";
import { WeaveConfigSchema, type WeaveConfig } from "./schema";

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

export interface ConfigDiagnostic {
  level: "warn" | "error";
  section: string;
  message: string;
  fields?: Array<{ path: string; message: string }>;
}

export interface ConfigLoadResult {
  config: WeaveConfig;
  loadedFiles: string[];
  diagnostics: ConfigDiagnostic[];
}

/**
 * Minimal JSONC parser — strips single-line (//) and multi-line (/* * /) comments,
 * then parses as JSON. Good enough for config files.
 * For production, use the `jsonc-parser` npm package.
 */
function parseJsonc(text: string): unknown {
  // Remove multi-line comments
  let result = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove single-line comments (but not inside strings)
  result = result.replace(/\/\/.*$/gm, "");
  // Remove trailing commas before } or ]
  result = result.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(result);
}

function readJsoncFile(filePath: string): DeepPartial<WeaveConfig> {
  try {
    const text = readFileSync(filePath, "utf-8");
    return (parseJsonc(text) as DeepPartial<WeaveConfig>) ?? {};
  } catch (error: any) {
    console.warn(`[weave] Failed to read config file ${filePath}: ${error.message}`);
    return {};
  }
}

function detectConfigFile(basePath: string): string | null {
  // Prefer .jsonc (supports comments), fallback to .json
  for (const ext of [".jsonc", ".json"]) {
    const p = basePath + ext;
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve config directories for PI.
 * Checks both legacy OpenCode paths and new PI paths.
 */
function resolveConfigPaths(directory: string): { userBase: string; projectBase: string } {
  const home = homedir();

  // PI paths (preferred)
  const piUserBase = join(home, ".pi", "agent", "weave-config");
  const piProjectBase = join(directory, ".pi", "weave-config");

  // Legacy OpenCode paths (backward compat)
  const ocUserBase = join(home, ".config", "opencode", "weave-opencode");
  const ocProjectBase = join(directory, ".opencode", "weave-opencode");

  // Use PI path if config exists, otherwise check legacy OpenCode path
  const userBase = detectConfigFile(piUserBase) ? piUserBase :
                   detectConfigFile(ocUserBase) ? ocUserBase : piUserBase;
  const projectBase = detectConfigFile(piProjectBase) ? piProjectBase :
                      detectConfigFile(ocProjectBase) ? ocProjectBase : piProjectBase;

  return { userBase, projectBase };
}

export function loadWeaveConfig(directory: string): ConfigLoadResult {
  const { userBase, projectBase } = resolveConfigPaths(directory);

  const userConfigPath = detectConfigFile(userBase);
  const projectConfigPath = detectConfigFile(projectBase);

  const loadedFiles: string[] = [];
  if (userConfigPath) loadedFiles.push(userConfigPath);
  if (projectConfigPath) loadedFiles.push(projectConfigPath);

  const merged = mergeConfigs(
    userConfigPath ? readJsoncFile(userConfigPath) : {},
    projectConfigPath ? readJsoncFile(projectConfigPath) : {},
  );

  const result = WeaveConfigSchema.safeParse(merged);
  if (!result.success) {
    const diagnostics: ConfigDiagnostic[] = [{
      level: "error",
      section: "(root)",
      message: "Config validation failed — using defaults",
      fields: result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    }];

    const issues = result.error.issues.map(
      (i) => `  ${i.path.join(".")}: ${i.message}`,
    );
    console.warn(`[weave] Config validation errors:\n${issues.join("\n")}\nUsing defaults.`);

    const fallback = WeaveConfigSchema.parse({});
    return { config: fallback, loadedFiles, diagnostics };
  }

  return { config: result.data, loadedFiles, diagnostics: [] };
}

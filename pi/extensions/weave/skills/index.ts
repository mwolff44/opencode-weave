/**
 * Weave skill loader — discovers and resolves skills for per-agent injection
 *
 * Skills are Markdown files with frontmatter (name, description, model, tools)
 * placed in standard PI skill directories. Weave extends PI's native skill
 * loading with per-agent skill assignment via config.
 *
 * Skill sources (in priority order):
 * 1. .weave/skills/          (project, weave-specific)
 * 2. .pi/skills/             (project, PI-native)
 * 3. ~/.pi/agent/skills/     (user, PI-native)
 * 4. Custom dirs from config (skill_directories)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WeaveConfig } from "../config/schema";

export interface SkillMetadata {
  name?: string;
  description?: string;
  model?: string;
  tools?: string | string[];
}

export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  scope: "builtin" | "user" | "project";
  path?: string;
}

function parseFrontmatter(text: string): { metadata: SkillMetadata; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { metadata: {}, body: text };

  const rawMeta = match[1];
  const body = match[2];
  const metadata: SkillMetadata = {};

  for (const line of rawMeta.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "name") metadata.name = value.trim();
    else if (key === "description") metadata.description = value.trim();
    else if (key === "model") metadata.model = value.trim();
    else if (key === "tools") metadata.tools = value.split(",").map(s => s.trim());
  }

  return { metadata, body };
}

function scanDirectory(dir: string, scope: "user" | "project"): LoadedSkill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: LoadedSkill[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skill directories: name/SKILL.md or name.md files
      if (entry.isDirectory()) {
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          const text = fs.readFileSync(skillFile, "utf-8");
          const { metadata, body } = parseFrontmatter(text);
          skills.push({
            name: metadata.name ?? entry.name,
            description: metadata.description ?? "",
            content: body.trim(),
            scope,
            path: skillFile,
          });
        }
      } else if (entry.name.endsWith(".md")) {
        const filePath = path.join(dir, entry.name);
        const text = fs.readFileSync(filePath, "utf-8");
        const { metadata, body } = parseFrontmatter(text);
        skills.push({
          name: metadata.name ?? entry.name.replace(/\.md$/, ""),
          description: metadata.description ?? "",
          content: body.trim(),
          scope,
          path: filePath,
        });
      }
    }
  } catch { /* */ }

  return skills;
}

/**
 * Discover all available skills from all sources.
 */
export function discoverSkills(cwd: string, config: WeaveConfig): LoadedSkill[] {
  const skillMap = new Map<string, LoadedSkill>();

  // 1. User skills (lowest priority)
  const userDir = path.join(os.homedir(), ".pi", "agent", "skills");
  for (const s of scanDirectory(userDir, "user")) skillMap.set(s.name, s);

  // 2. Project skills
  const projectDir = path.join(cwd, ".pi", "skills");
  for (const s of scanDirectory(projectDir, "project")) skillMap.set(s.name, s);

  // 3. Weave-specific skills
  const weaveDir = path.join(cwd, ".weave", "skills");
  for (const s of scanDirectory(weaveDir, "project")) skillMap.set(s.name, s);

  // 4. Custom directories from config
  for (const dir of config.skill_directories ?? []) {
    const absDir = path.resolve(cwd, dir);
    if (fs.existsSync(absDir)) {
      for (const s of scanDirectory(absDir, "project")) skillMap.set(s.name, s);
    }
  }

  // Filter disabled skills
  const disabled = new Set(config.disabled_skills ?? []);
  for (const name of disabled) skillMap.delete(name);

  return Array.from(skillMap.values());
}

/**
 * Get skills assigned to a specific agent via config.
 * Returns the skill content strings to inject into the agent's system prompt.
 */
export function getAgentSkills(
  agentName: string,
  allSkills: LoadedSkill[],
  config: WeaveConfig,
): LoadedSkill[] {
  const agentConfig = config.agents?.[agentName];
  if (!agentConfig?.skills?.length) return [];

  const skillNames = new Set(agentConfig.skills);
  return allSkills.filter(s => skillNames.has(s.name));
}

/**
 * Build a skill injection section for an agent's system prompt.
 */
export function buildSkillInjection(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map(s => {
    const desc = s.description ? `\n> ${s.description}` : "";
    return `### Skill: ${s.name}${desc}\n\n${s.content}`;
  });

  return `<Skills>\n${sections.join("\n\n---\n\n")}\n</Skills>`;
}

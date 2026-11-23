// Skills: folders of instructions (a SKILL.md and the files it points to) a team gives an agent
// role. They are vendored into the repository at `.factory/skills/<name>/`, pinned in
// `.factory/skills.lock`, and read from the base branch like rules. The factory copies a role's
// skills into the sandbox's reference folder and lists them in the role's prompt; an "always"
// skill's SKILL.md is also put into the prompt.
//
// Pure: no I/O.

import { sha256 } from './context-pack.ts';

export const SKILLS_DIR = '.factory/skills';
export const SKILLS_LOCK = '.factory/skills.lock';
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillFile {
  /** Path inside the skill's folder. */
  path: string;
  content: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  /** SKILL.md without its front matter. */
  body: string;
}

/** One entry of `.factory/skills.lock`. */
export interface SkillLockEntry {
  /** Where it came from: a git URL, or `local` for the team's own. */
  source: string;
  /** The folder inside the source repository. */
  path?: string;
  /** The ref asked for, and the commit it resolved to. */
  ref?: string;
  commit?: string;
  /** {@link skillHash} of the vendored folder. */
  hash: string;
}

export type SkillsLock = Record<string, SkillLockEntry>;

/** Reads SKILL.md's front matter (`name`, `description`); undefined when it has none or lacks either. */
export function parseSkill(text: string): SkillManifest | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (!fields.name || !fields.description) return undefined;
  return { name: fields.name, description: fields.description, body: m[2]!.trim() };
}

/** A content hash of a whole skill folder: every file's path and content, in path order. */
export function skillHash(files: SkillFile[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\0${sha256(f.content)}\n`);
  return sha256(lines.join(''));
}

/** Parses `.factory/skills.lock`; an unreadable lock reads as empty, and validation reports it. */
export function parseLock(text: string | undefined): SkillsLock {
  if (!text?.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SkillsLock) : {};
  } catch {
    return {};
  }
}

export const formatLock = (lock: SkillsLock): string =>
  `${JSON.stringify(Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;

export interface GivenSkill {
  name: string;
  description: string;
  load: 'on-demand' | 'always';
  /** Where the agent finds the skill's folder. */
  readAt: string;
  body: string;
}

/** The part of a role's prompt that offers its skills. */
export function skillsPrompt(skills: GivenSkill[]): string {
  if (!skills.length) return '';
  const onDemand = skills.filter((s) => s.load === 'on-demand');
  const always = skills.filter((s) => s.load === 'always');
  const parts: string[] = [];
  if (onDemand.length) {
    parts.push(
      [
        "This project's team gives your role these skills. Each is a folder of instructions; when your task calls for one, read its SKILL.md first and follow it, along with any files it points to:",
        ...onDemand.map((s) => `- ${s.name}: ${s.description} (${s.readAt}/SKILL.md)`),
      ].join('\n'),
    );
  }
  for (const s of always) {
    parts.push(`The team's skill "${s.name}" (${s.description}) applies to all your work. Follow it; the files it mentions are in ${s.readAt}/.\n\n${s.body}`);
  }
  return parts.join('\n\n');
}

/** Which of `names` the agent's tool calls opened, from the paths in their inputs. */
export function skillsOpened(toolInputs: unknown[], skillsRoot: string, names: string[]): string[] {
  const text = toolInputs.map((i) => (typeof i === 'string' ? i : JSON.stringify(i ?? ''))).join('\n');
  return names.filter((n) => text.includes(`${skillsRoot}/${n}/`));
}

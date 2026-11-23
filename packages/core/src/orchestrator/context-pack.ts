// Assembles what an agent is shown before it starts: the project rules and the team's prompt
// addition for its role, size-budgeted. The manifest, with a content hash per file, is logged so
// anyone can see exactly what the agent was given.
//
// Both come from the base branch, never from the branch under work, so a change can't rewrite the
// rules or instructions of the agents that build or judge it. Rules are copied into the sandbox's
// reference folder (outside the checkout, read-only to the agent) and listed by that path; the
// addition is put into the role's prompt.

import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';

export const DEFAULT_CONTEXT_BUDGET_BYTES = 256 * 1024;

/** Where a role's prompt addition lives in the repository. */
export const promptAdditionPath = (role: string) => `.factory/prompts/${role}.md`;

/** Where, under the sandbox's reference folder, the base branch's rule files are copied. */
export const RULES_DIR = 'rules';

export interface ContextFile {
  /** Path in the repository. */
  path: string;
  bytes: number;
  /** `sha256:<hex>` of the content the agent was given. */
  sha256: string;
  /** `rule`: copied for the agent to read; `prompt`: put into the role's prompt; `skill`: a skill folder. */
  kind: 'rule' | 'prompt' | 'skill';
  /** For a skill: offered for the agent to open, or put into the prompt. */
  load?: 'on-demand' | 'always';
  /** For a skill: whether its folder matches `.factory/skills.lock`. */
  lock?: 'ok' | 'mismatch' | 'unlocked';
}

export interface ContextPack {
  /** In load order: the prompt addition first, then rules. */
  files: ContextFile[];
  /** Matched files left out because the budget ran out. */
  dropped: string[];
  budgetBytes: number;
  /** Names of the skills that fit. */
  skills: string[];
  /** The rules that fit, with their content, to copy into the sandbox. */
  rules: Array<{ path: string; content: string }>;
  /** The role's prompt addition, when there is one and it fit. */
  addition?: { path: string; text: string };
}

export const sha256 = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** The files of `tree` that the rule patterns match: in pattern order, sorted within each, each once. */
export function matchRules(tree: string[], patterns: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const path of tree.filter((p) => matchesGlob(p, pattern)).sort()) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/** A skill as the pack weighs it: an always skill costs its SKILL.md; an on-demand one only its line. */
export interface PackSkill {
  name: string;
  load: 'on-demand' | 'always';
  hash: string;
  lock: 'ok' | 'mismatch' | 'unlocked';
  /** What goes into the prompt for it. */
  promptBytes: number;
}

export function buildContextPack(
  rules: Array<{ path: string; content: string }>,
  budgetBytes = DEFAULT_CONTEXT_BUDGET_BYTES,
  addition?: { path: string; text: string },
  skills: PackSkill[] = [],
): ContextPack {
  const files: ContextFile[] = [];
  const dropped: string[] = [];
  const kept: ContextPack['rules'] = [];
  let used = 0;
  let added: ContextPack['addition'];
  // The addition goes first: it is short, aimed at this role, and a team that wrote one means it.
  if (addition) {
    const bytes = Buffer.byteLength(addition.text);
    if (bytes > budgetBytes) dropped.push(addition.path);
    else {
      used += bytes;
      files.push({ path: addition.path, bytes, sha256: sha256(addition.text), kind: 'prompt' });
      added = addition;
    }
  }
  // Then skills: named for this role, so ahead of the rules every role shares.
  const keptSkills: string[] = [];
  for (const skill of skills) {
    const path = `.factory/skills/${skill.name}`;
    if (used + skill.promptBytes > budgetBytes) {
      dropped.push(path);
      continue;
    }
    used += skill.promptBytes;
    files.push({ path, bytes: skill.promptBytes, sha256: skill.hash, kind: 'skill', load: skill.load, lock: skill.lock });
    keptSkills.push(skill.name);
  }
  for (const rule of rules) {
    const bytes = Buffer.byteLength(rule.content);
    if (used + bytes > budgetBytes) {
      dropped.push(rule.path);
      continue;
    }
    used += bytes;
    files.push({ path: rule.path, bytes, sha256: sha256(rule.content), kind: 'rule' });
    kept.push(rule);
  }
  return { files, dropped, budgetBytes, rules: kept, skills: keptSkills, ...(added ? { addition: added } : {}) };
}

/** The role prompt with the team's addition after it, marked so the agent knows whose words they are. */
export function withAddition(rolePrompt: string, addition: ContextPack['addition']): string {
  if (!addition) return rolePrompt;
  return `${rolePrompt}\n\nThis project's team adds these instructions for your role (from ${addition.path}). Follow them, unless they conflict with the instructions above; those come first:\n\n${addition.text.trim()}`;
}

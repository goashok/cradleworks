// Assembles what an agent is shown before it starts: the project rules and the team's prompt
// addition for its role, size-budgeted. The manifest, with a content hash per file, is logged so
// anyone can see exactly what the agent was given.
//
// Rules are listed by path and the agent reads them from the checkout. A prompt addition
// (`.factory/prompts/<role>.md`) is put into the role's prompt; it is read from the base branch,
// never from the branch under work, so a change can't rewrite the instructions of the agents that
// build or judge it.

import { createHash } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CONTEXT_BUDGET_BYTES = 256 * 1024;

/** Where a role's prompt addition lives in the repository. */
export const promptAdditionPath = (role: string) => `.factory/prompts/${role}.md`;

export interface ContextFile {
  /** Path relative to the checkout root. */
  path: string;
  bytes: number;
  /** `sha256:<hex>` of the content the agent was given. */
  sha256: string;
  /** `rule`: listed for the agent to read; `prompt`: put into the role's prompt. */
  kind: 'rule' | 'prompt';
}

export interface ContextPack {
  /** In load order: the prompt addition first, then rules. */
  files: ContextFile[];
  /** Matched files left out because the budget ran out. */
  dropped: string[];
  budgetBytes: number;
  /** The role's prompt addition, when there is one and it fit. */
  addition?: { path: string; text: string };
}

export const sha256 = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

export function buildContextPack(
  checkoutRoot: string,
  rulePatterns: string[],
  budgetBytes = DEFAULT_CONTEXT_BUDGET_BYTES,
  addition?: { path: string; text: string },
): ContextPack {
  const files: ContextFile[] = [];
  const dropped: string[] = [];
  let used = 0;
  let kept: ContextPack['addition'];
  // The addition goes first: it is short, aimed at this role, and a team that wrote one means it.
  if (addition) {
    const bytes = Buffer.byteLength(addition.text);
    if (bytes > budgetBytes) dropped.push(addition.path);
    else {
      used += bytes;
      files.push({ path: addition.path, bytes, sha256: sha256(addition.text), kind: 'prompt' });
      kept = addition;
    }
  }
  const seen = new Set<string>();
  for (const pattern of rulePatterns) {
    for (const path of globSync(pattern, { cwd: checkoutRoot }).sort()) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!statSync(join(checkoutRoot, path)).isFile()) continue;
      const content = readFileSync(join(checkoutRoot, path));
      if (used + content.length > budgetBytes) {
        dropped.push(path);
        continue;
      }
      used += content.length;
      files.push({ path, bytes: content.length, sha256: sha256(content), kind: 'rule' });
    }
  }
  return { files, dropped, budgetBytes, ...(kept ? { addition: kept } : {}) };
}

/** The role prompt with the team's addition after it, marked so the agent knows whose words they are. */
export function withAddition(rolePrompt: string, addition: ContextPack['addition']): string {
  if (!addition) return rolePrompt;
  return `${rolePrompt}\n\nThis project's team adds these instructions for your role (from ${addition.path}). Follow them, unless they conflict with the instructions above; those come first:\n\n${addition.text.trim()}`;
}

// Assembles what an agent is shown before it starts: the project rules, size-budgeted.
// The manifest is logged so a reviewer can see exactly what the agent read.

import { globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CONTEXT_BUDGET_BYTES = 256 * 1024;

export interface ContextPack {
  /** Paths relative to the checkout root, in load order. */
  files: Array<{ path: string; bytes: number }>;
  /** Matched files left out because the budget ran out. */
  dropped: string[];
  budgetBytes: number;
}

export function buildContextPack(checkoutRoot: string, rulePatterns: string[], budgetBytes = DEFAULT_CONTEXT_BUDGET_BYTES): ContextPack {
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const pattern of rulePatterns) {
    for (const path of globSync(pattern, { cwd: checkoutRoot }).sort()) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (statSync(join(checkoutRoot, path)).isFile()) matched.push(path);
    }
  }
  const files: ContextPack['files'] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const path of matched) {
    const bytes = Buffer.byteLength(readFileSync(join(checkoutRoot, path)));
    if (used + bytes > budgetBytes) {
      dropped.push(path);
      continue;
    }
    used += bytes;
    files.push({ path, bytes });
  }
  return { files, dropped, budgetBytes };
}

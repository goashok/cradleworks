// Which factory this is. An installed package carries build-info.json at its root, written when it
// was built; a source checkout asks git. A package installed inside someone else's git repository
// must not report that repository's commit, so build-info.json always wins.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FactoryVersion {
  /** The package version, or `source` for a checkout. */
  version: string;
  /** The commit it was built from, when known. */
  commit?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The package's (or checkout's) root: packages/cli/src → three folders up. */
export const FACTORY_ROOT = join(here, '..', '..', '..');

let cached: FactoryVersion | undefined;

export function factoryVersion(): FactoryVersion {
  if (cached) return cached;
  const info = join(FACTORY_ROOT, 'build-info.json');
  if (existsSync(info)) {
    const b = JSON.parse(readFileSync(info, 'utf8')) as { version: string; commit?: string };
    return (cached = { version: b.version, ...(b.commit ? { commit: b.commit } : {}) });
  }
  try {
    const commit = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return (cached = { version: 'source', commit });
  } catch {
    return (cached = { version: 'source' });
  }
}

// Drill cases: changes whose verdict is known, kept in the repository at `.factory/drill/`, that
// show a reviewer or agent check can tell a bad change from a good one.
//
//   .factory/drill/<check>/<case>.patch   known-bad: that check (or `reviewer`) must send it back
//   .factory/drill/<check>/<case>.md      the task text the change claims to do; its first line is the title
//   .factory/drill/controls/<case>.patch  known-good: every check must pass it
//   .factory/drill/known-misses.txt       `<check>/<case>  why`: reported, not counted
//
// A blocking agent check with no known-bad case runs as advisory. Pure: no I/O.

export const DRILL_DIR = '.factory/drill';
export const CONTROLS = 'controls';
export const KNOWN_MISSES = `${DRILL_DIR}/known-misses.txt`;

export interface DrillCase {
  /** `reviewer`, an agent check's name, or `controls`. */
  group: string;
  name: string;
  patchPath: string;
  /** The task text, when there is a `.md` beside the patch. */
  taskPath?: string;
}

/** The drill cases in a list of repository paths, by group, sorted. */
export function drillCases(paths: string[]): DrillCase[] {
  const set = new Set(paths);
  const out: DrillCase[] = [];
  for (const path of [...paths].sort()) {
    const m = new RegExp(`^${DRILL_DIR.replace(/[.]/g, '\\.')}/([^/]+)/([^/]+)\\.patch$`).exec(path);
    if (!m) continue;
    const taskPath = path.replace(/\.patch$/, '.md');
    out.push({ group: m[1]!, name: m[2]!, patchPath: path, ...(set.has(taskPath) ? { taskPath } : {}) });
  }
  return out;
}

/** Why a check set to block runs as advisory, or undefined when it may block. */
export function advisoryReason(check: { name: string; blocks: boolean }, paths: string[]): string | undefined {
  if (!check.blocks) return undefined;
  return drillCases(paths).some((c) => c.group === check.name) ? undefined : `no known-bad drill cases in ${DRILL_DIR}/${check.name}/`;
}

/** `known-misses.txt`: `<check>/<case>` and why, one per line; `#` starts a comment. */
export function parseKnownMisses(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [id, ...why] = line.split(/\s+/);
    out.set(id!, why.join(' '));
  }
  return out;
}

/** The title and description from a case's task text: the first line (without `#`), then the rest. */
export function caseTask(name: string, text: string | undefined): { title: string; description: string } {
  if (!text?.trim()) return { title: name.replace(/-/g, ' '), description: '' };
  const [first, ...rest] = text.trim().split('\n');
  return { title: first!.replace(/^#+\s*/, '').trim(), description: rest.join('\n').trim() };
}

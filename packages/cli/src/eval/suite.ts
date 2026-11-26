// An eval suite: tasks with a known right answer that the factory has never seen, so a team can
// measure its own factory on its own code. It lives outside the project's repository (the
// factory's agents must never be able to read the hidden tests), for example in a private repo:
//
//   <suite>/
//     suite.yaml                   repo, sets, how to grade, and optionally settings_from: a
//                                  commit whose .factory/ is laid over every task's base (for
//                                  tasks taken from before the project had one)
//     tasks/<id>/
//       task.yaml                  base_commit, and optional title, type, size, grade overrides
//       issue.md                   the only thing the factory sees: "# Title", then the request
//       hidden/                    tests copied over the result at the same paths, then run
//       solution.patch             a reference solution, to check the task itself
//       wrong/*.patch              optional: plausible wrong solutions the hidden tests reject

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseYaml } from '@cradleworks/config';

export interface GradeSpec {
  /** Run in the checkout after the hidden tests are copied in. Default: the project's build, then its tests. */
  command?: string;
  /** Default: the project's `stack.image` at the task's base commit. */
  image?: string;
  /** Folders of JUnit XML, from the checkout. With them, a pass needs hidden test cases to have run. */
  reports: string[];
  /** A test case is hidden when its class, file or suite matches. */
  hidden: RegExp;
  timeoutMinutes: number;
}

export interface Suite {
  dir: string;
  /** A path on this machine or a clone URL. */
  repo: string;
  sets: Record<string, string[]>;
  grade: GradeSpec;
  tasks: string[];
  /** A commit of the repository whose `.factory/` is laid over each task's base, its specs aside. */
  settingsFrom?: string;
}

export interface EvalTask {
  id: string;
  dir: string;
  title: string;
  issue: string;
  baseCommit: string;
  type?: string;
  size?: string;
  grade: GradeSpec;
  /** Whether the hidden tests should fail at the base commit; `pass` for a refactor. */
  expectBase: 'fail' | 'pass';
  solution?: string;
  wrong: string[];
}

const DEFAULT_HIDDEN = /(^|[./\\])hidden([./\\]|$)/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  return v;
};

function gradeSpec(raw: unknown, base: GradeSpec | undefined, where: string): GradeSpec {
  const g = obj(raw);
  const reports = g.reports === undefined ? (base?.reports ?? []) : Array.isArray(g.reports) ? g.reports.map(String) : [String(g.reports)];
  const minutes = g.timeout_minutes === undefined ? (base?.timeoutMinutes ?? 30) : Number(g.timeout_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${where}: grade.timeout_minutes must be a positive number`);
  const command = str(g.command, `${where}: grade.command`) ?? base?.command;
  const image = str(g.image, `${where}: grade.image`) ?? base?.image;
  const hidden = str(g.hidden, `${where}: grade.hidden`);
  return { ...(command ? { command } : {}), ...(image ? { image } : {}), reports, hidden: hidden ? new RegExp(hidden) : (base?.hidden ?? DEFAULT_HIDDEN), timeoutMinutes: minutes };
}

export function loadSuite(dir: string): Suite {
  const root = resolve(dir);
  const file = join(root, 'suite.yaml');
  if (!existsSync(file)) throw new Error(`no suite.yaml in ${root}`);
  const raw = obj(parseYaml(readFileSync(file, 'utf8'), 'suite.yaml'));
  const repoRaw = str(raw.repo, 'suite.yaml: repo');
  if (!repoRaw) throw new Error('suite.yaml: repo is required (a path from the suite folder, or a clone URL)');
  const repo = /^[a-z+]+:\/\/|^git@/.test(repoRaw) || isAbsolute(repoRaw) ? repoRaw : resolve(root, repoRaw);
  const tasksDir = join(root, 'tasks');
  const tasks = existsSync(tasksDir) ? readdirSync(tasksDir).filter((d) => statSync(join(tasksDir, d)).isDirectory() && existsSync(join(tasksDir, d, 'task.yaml'))).sort() : [];
  const sets: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(obj(raw.sets))) {
    if (!Array.isArray(ids)) throw new Error(`suite.yaml: sets.${name} must be a list of task ids`);
    for (const id of ids) if (!tasks.includes(String(id))) throw new Error(`suite.yaml: sets.${name} names ${String(id)}, which is not in tasks/`);
    sets[name] = ids.map(String);
  }
  const settingsFrom = str(raw.settings_from, 'suite.yaml: settings_from');
  if (settingsFrom !== undefined && !/^[0-9a-f]{7,40}$/.test(settingsFrom)) throw new Error('suite.yaml: settings_from must be a commit id');
  return { dir: root, repo, sets, grade: gradeSpec(raw.grade, undefined, 'suite.yaml'), tasks, ...(settingsFrom ? { settingsFrom } : {}) };
}

export function loadTask(suite: Suite, id: string): EvalTask {
  const dir = join(suite.dir, 'tasks', id);
  const where = `tasks/${id}/task.yaml`;
  if (!existsSync(join(dir, 'task.yaml'))) throw new Error(`no task ${id} in ${join(suite.dir, 'tasks')}`);
  const raw = obj(parseYaml(readFileSync(join(dir, 'task.yaml'), 'utf8'), where));
  const baseCommit = str(raw.base_commit, `${where}: base_commit`);
  if (!baseCommit) throw new Error(`${where}: base_commit is required`);
  if (!existsSync(join(dir, 'issue.md'))) throw new Error(`tasks/${id}: issue.md is missing`);
  if (!existsSync(join(dir, 'hidden'))) throw new Error(`tasks/${id}: hidden/ is missing`);
  const issue = readFileSync(join(dir, 'issue.md'), 'utf8');
  const heading = /^#\s+(.+)$/m.exec(issue)?.[1]?.trim();
  const expectBase = raw.expect_base === 'pass' ? 'pass' : 'fail';
  const wrongDir = join(dir, 'wrong');
  const type = str(raw.type, `${where}: type`);
  const size = str(raw.size, `${where}: size`);
  return {
    id,
    dir,
    title: str(raw.title, `${where}: title`) ?? heading ?? id,
    issue,
    baseCommit,
    ...(type ? { type } : {}),
    ...(size ? { size } : {}),
    grade: gradeSpec(raw.grade, suite.grade, where),
    expectBase,
    ...(existsSync(join(dir, 'solution.patch')) ? { solution: join(dir, 'solution.patch') } : {}),
    wrong: existsSync(wrongDir) ? readdirSync(wrongDir).filter((f) => f.endsWith('.patch')).sort().map((f) => join(wrongDir, f)) : [],
  };
}

/** Task ids from arguments: ids, `@<set>`, or `@all` (the default). */
export function selectTasks(suite: Suite, args: string[]): string[] {
  if (!args.length) return suite.tasks;
  const out: string[] = [];
  for (const a of args) {
    const ids = a === '@all' ? suite.tasks : a.startsWith('@') ? suite.sets[a.slice(1)] : [a];
    if (!ids) throw new Error(`no set ${a.slice(1)} in suite.yaml (sets: ${Object.keys(suite.sets).join(', ') || 'none'})`);
    for (const id of ids) {
      if (!suite.tasks.includes(id)) throw new Error(`no task ${id} in ${join(suite.dir, 'tasks')}`);
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Every file under hidden/, as [absolute source, path in the checkout]. */
export function hiddenFiles(task: EvalTask): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (at: string, rel: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(at, e.name), r);
      else out.push([join(at, e.name), r]);
    }
  };
  walk(join(task.dir, 'hidden'), '');
  return out.sort((a, b) => (a[1] < b[1] ? -1 : 1));
}

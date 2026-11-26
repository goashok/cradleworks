// Runs the factory on eval tasks and grades what it merged.
//
// Each task gets a scratch copy of the project's repository: a bare clone whose `main` is the
// task's base commit with the variant and the eval's settings committed on top. The factory
// works on that copy through `factory submit`, with its own state folder, and never sees the
// suite: only the task's issue text is handed over. After it finishes, the merged `main` (or,
// when nothing merged, the task's branch, for information) is checked out on this machine, the
// hidden tests are copied in and the grading command runs. A task passes only when the factory
// merged its change and the hidden tests pass on it.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDocker } from '@cradleworks/adapter-local';
import { loadProjectConfig } from '@cradleworks/config';
import { WorkItemRepository, type ProjectConfig } from '@cradleworks/core';
import { SqliteStateStore } from '@cradleworks/store-sqlite';
import { checkoutAt, dockerRunner, gradeCheckout, hostRunner, type GradeResult, type Runner } from './grade.ts';
import { loadTask, type EvalTask, type Suite } from './suite.ts';
import { applyVariant, type Variant } from './variant.ts';

/** Runs a `factory` command in-process. */
export type FactoryCall = (args: string[], cwd: string, env: Record<string, string | undefined>) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface EvalResult {
  task: string;
  label: string;
  /** The variant's name and hash, or null for the factory as configured. */
  variant: { name: string; hash: string } | null;
  /** The factory's own commit, when it runs from a git checkout. */
  factoryCommit?: string;
  startedAt: string;
  durationSeconds: number;
  workItemId?: string;
  /** The work item's state when the factory stopped: merged, escalated, failed, ... */
  factoryState: string;
  merged: boolean;
  reworkLoops: number;
  costUsd: number;
  /** What was graded: the merged main, the unmerged branch, or nothing. */
  graded: 'merged' | 'branch' | 'none';
  grade?: Omit<GradeResult, 'log'>;
  passed: boolean;
  error?: string;
}

export interface EvalOptions {
  suite: Suite;
  tasks: string[];
  variant?: Variant;
  /** The results file; one JSON line per task. Tasks already in it are skipped. */
  out: string;
  label: string;
  jobs: number;
  factory: FactoryCall;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Replaces how the grading command runs; for tests. */
  runner?: Runner;
}

const sh = (dir: string | undefined, cmd: string, args: string[]) =>
  execFileSync(cmd, args, { ...(dir ? { cwd: dir } : {}), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const git = (dir: string | undefined, ...args: string[]) => sh(dir, 'git', ['-c', 'core.hooksPath=/dev/null', ...args]);

export function factoryCommit(): string | undefined {
  try {
    return git(dirname(fileURLToPath(import.meta.url)), 'rev-parse', 'HEAD');
  } catch {
    return undefined;
  }
}

export function readResults(file: string): EvalResult[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalResult);
}

/** The project's build and tests, which grade a task that names no command of its own. */
export function defaultCommand(config: ProjectConfig): string {
  const { build, test } = config.stack.commands;
  return [build, test].filter((c): c is string => !!c?.trim()).join(' && ');
}

export function runnerFor(config: ProjectConfig, override?: Runner): Runner {
  return override ?? (config.adapters.sandbox === 'process' ? hostRunner : dockerRunner(findDocker()));
}

/**
 * A scratch bare copy of the suite's repository whose main is the task's base commit plus the
 * variant. It holds only the base commit's own history: nothing after it, no other branch and no
 * tag, since the agents can read the checkout's git history, and a task taken from the project's
 * past has its answer in a later commit.
 */
export function scratchRepo(suite: Suite, task: EvalTask, variant: Variant | undefined, dir: string): { remote: string; checkout: string } {
  const remote = join(dir, 'remote.git');
  const checkout = join(dir, 'checkout');
  const source = join(dir, 'source.git');
  git(undefined, 'clone', '--quiet', '--bare', suite.repo, source);
  try {
    git(source, 'cat-file', '-e', `${task.baseCommit}^{commit}`);
  } catch {
    rmSync(source, { recursive: true, force: true });
    throw new Error(`base commit ${task.baseCommit} is not in ${suite.repo}`);
  }
  // Pushing one commit sends only what it can reach: its own history and nothing else.
  git(undefined, 'init', '--quiet', '--bare', remote);
  git(source, 'push', '--quiet', remote, `${task.baseCommit}:refs/heads/main`);
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  rmSync(source, { recursive: true, force: true });
  git(undefined, 'clone', '--quiet', remote, checkout);
  git(checkout, 'checkout', '-q', '-B', 'main', task.baseCommit);
  applyVariant(checkout, variant);
  git(checkout, 'add', '-A');
  git(checkout, '-c', 'user.name=factory eval', '-c', 'user.email=eval@cradleworks.invalid', 'commit', '--quiet', '--allow-empty', '-m', `Eval settings${variant ? ` and variant ${variant.name}` : ''}`);
  git(checkout, 'push', '--quiet', '--force', 'origin', 'main');
  return { remote, checkout };
}

async function runOne(o: EvalOptions, id: string, commit: string | undefined): Promise<EvalResult> {
  const task = loadTask(o.suite, id);
  const started = Date.now();
  const dir = join(dirname(resolve(o.out)), `${o.label}.d`, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const base: EvalResult = {
    task: id,
    label: o.label,
    variant: o.variant ? { name: o.variant.name, hash: o.variant.hash } : null,
    ...(commit ? { factoryCommit: commit } : {}),
    startedAt: new Date(started).toISOString(),
    durationSeconds: 0,
    factoryState: 'not run',
    merged: false,
    reworkLoops: 0,
    costUsd: 0,
    graded: 'none',
    passed: false,
  };
  const done = (r: Partial<EvalResult>): EvalResult => ({ ...base, ...r, durationSeconds: Math.round((Date.now() - started) / 1000) });
  let scratch: { remote: string; checkout: string };
  let config: ProjectConfig;
  try {
    scratch = scratchRepo(o.suite, task, o.variant, dir);
    config = loadProjectConfig(scratch.checkout);
  } catch (error) {
    return done({ error: `setup: ${(error as Error).message}` });
  }

  // The factory gets the issue text and the scratch copy, nothing else from the suite.
  const issueFile = join(dir, 'issue.md');
  writeFileSync(issueFile, task.issue);
  const home = join(dir, 'home');
  const ran = await o.factory(['submit', issueFile], scratch.checkout, { ...o.env, CRADLEWORKS_HOME: home });
  writeFileSync(join(dir, 'factory.log'), `${ran.stdout}\n${ran.stderr}`);
  const wiId = /as (wi_\S+)/.exec(ran.stdout)?.[1];
  if (!wiId) return done({ error: `the factory did not take the task: ${(ran.stderr || ran.stdout).trim().split('\n').at(-1) ?? ''}` });

  const store = new SqliteStateStore({ path: join(home, 'state.db') });
  let state = 'unknown';
  let merged = false;
  let reworkLoops = 0;
  let costUsd = 0;
  let branch: string | undefined;
  try {
    const wi = await new WorkItemRepository(store).load(wiId);
    if (wi) {
      state = wi.state;
      merged = wi.state === 'merged';
      reworkLoops = wi.tasks.reduce((a, t) => a + t.reworkLoops, 0);
      costUsd = wi.spentUsd;
      branch = wi.tasks[0]?.branch;
    }
  } finally {
    await store.close();
  }
  const facts = { workItemId: wiId, factoryState: state, merged, reworkLoops, costUsd };
  const ref = merged ? 'main' : branch;
  if (!ref) return done({ ...facts });
  try {
    const gradeDir = join(dir, 'grade');
    checkoutAt(scratch.remote, ref, gradeDir);
    const result = await gradeCheckout({
      task,
      dir: gradeDir,
      command: task.grade.command ?? defaultCommand(config),
      image: task.grade.image ?? config.stack.image,
      runner: runnerFor(config, o.runner),
      cacheDir: join(dirname(resolve(o.out)), '.grade-cache'),
    });
    const { log: _log, ...grade } = result;
    return done({ ...facts, graded: merged ? 'merged' : 'branch', grade, passed: merged && result.verdict === 'pass' });
  } catch (error) {
    return done({ ...facts, error: `grading: ${(error as Error).message}` });
  }
}

/** Runs the tasks, `jobs` at a time, appending each result to `out` as it finishes. */
export async function runEval(o: EvalOptions): Promise<EvalResult[]> {
  mkdirSync(dirname(resolve(o.out)), { recursive: true });
  const already = new Set(readResults(o.out).filter((r) => r.label === o.label).map((r) => r.task));
  const todo = o.tasks.filter((t) => !already.has(t));
  for (const t of o.tasks.filter((x) => already.has(x))) o.log(`${t}: already in ${o.out}, skipped`);
  const commit = factoryCommit();
  const results: EvalResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++]!;
      o.log(`${id}: running${o.variant ? ` with variant ${o.variant.name}` : ''}`);
      const r = await runOne(o, id, commit);
      appendFileSync(o.out, `${JSON.stringify(r)}\n`);
      results.push(r);
      o.log(`${id}: ${r.passed ? 'PASS' : 'FAIL'}  factory ${r.factoryState}, $${r.costUsd.toFixed(2)}${r.grade ? `, hidden tests ${r.grade.verdict}: ${r.grade.reason}` : ''}${r.error ? `, ${r.error}` : ''}  (${r.durationSeconds}s)`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.jobs, todo.length)) }, worker));
  return results;
}

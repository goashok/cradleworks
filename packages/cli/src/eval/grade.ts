// The grader: copies a task's hidden tests over a checkout of the factory's result, runs the
// grading command in the project's image, and says pass or fail.
//
// It runs on this machine, never in an agent's sandbox, so the hidden tests stay out of the
// factory's reach. With JUnit report folders configured, a run that exits 0 without running a
// hidden test case (tests skipped, a suite emptied) is a fail, not a pass.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { hiddenFiles, type EvalTask } from './suite.ts';

export interface RunSpec {
  /** The checkout, with the hidden tests copied in. */
  dir: string;
  image: string;
  command: string;
  env: Record<string, string>;
  /** Where JUnit XML may be written, from the checkout; the runner passes it as $GRADER_REPORTS. */
  reportsDir: string;
  timeoutMs: number;
  logFile: string;
  /** A folder kept between grades, for build tool caches. */
  cacheDir: string;
}

/** Runs the grading command; returns its exit code, or 'timeout'. */
export type Runner = (spec: RunSpec) => Promise<number | 'timeout'>;

export interface TestCase {
  classname: string;
  name: string;
  suite: string;
  outcome: 'passed' | 'failed' | 'skipped';
  message?: string;
}

export interface GradeResult {
  verdict: 'pass' | 'fail' | 'error';
  reason: string;
  exitCode: number | null;
  timedOut: boolean;
  attempts: number;
  /** Non-hidden tests that failed, then passed on the retry. */
  flaky: string[];
  tests?: { total: number; failed: number; hidden: number; hiddenFailed: number };
  failures: string[];
  /** Files the result changed that the hidden tests overwrote. */
  overwritten: string[];
  durationSeconds: number;
  log: string;
}

const REPORTS = '.grader-reports';

// --- JUnit ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : undefined;
};

/** JUnit XML (Maven Surefire, Gradle, Vitest, Jest, pytest and most others write it) into test cases. */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const suites: Array<[number, string]> = [];
  const suiteRe = /<testsuite\b([^>]*)>/g;
  for (let s = suiteRe.exec(xml); s; s = suiteRe.exec(xml)) suites.push([s.index, attr(s[1]!, 'name') ?? '']);
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const at = m.index;
    const body = m[3] ?? '';
    const failure = /<(failure|error)\b([^>]*)/.exec(body);
    const message = failure ? attr(failure[2]!, 'message') : undefined;
    cases.push({
      classname: attr(m[1]!, 'classname') ?? attr(m[1]!, 'file') ?? '',
      name: attr(m[1]!, 'name') ?? '',
      suite: suites.filter(([i]) => i < at).at(-1)?.[1] ?? '',
      outcome: failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      ...(message !== undefined ? { message: message.trim().split('\n')[0]!.slice(0, 300) } : {}),
    });
  }
  return cases;
}

function junitFiles(dir: string, folders: string[]): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    if (!existsSync(at)) return;
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(at, e.name));
      else if (e.name.endsWith('.xml')) out.push(join(at, e.name));
    }
  };
  for (const f of [REPORTS, ...folders]) walk(join(dir, f));
  return out;
}

// --- runners ---------------------------------------------------------------------------

/** On this machine, for the test-only process sandbox. */
export const hostRunner: Runner = (spec) =>
  runLogged('sh', ['-c', spec.command], { cwd: spec.dir, env: { ...process.env, CI: 'true', ...spec.env, GRADER_REPORTS: join(spec.dir, spec.reportsDir) } }, spec);

/** In a throwaway container of the image, as the current user, with its home kept between grades. */
export function dockerRunner(docker: string): Runner {
  return (spec) => {
    const home = join(spec.cacheDir, 'home');
    mkdirSync(home, { recursive: true });
    const { uid, gid } = userInfo();
    const passwd = join(spec.cacheDir, `passwd-${spec.image.replace(/[^a-z0-9]+/gi, '_')}`);
    if (!existsSync(passwd)) {
      // Some tools look the user up; give the image's users plus this one.
      let base = '';
      try {
        base = execFileSync(docker, ['run', '--rm', '--entrypoint', 'cat', spec.image, '/etc/passwd'], { encoding: 'utf8', timeout: 120_000 });
      } catch {
        base = 'root:x:0:0:root:/root:/bin/sh\n';
      }
      writeFileSync(passwd, `${base.trimEnd()}\ngrader:x:${uid}:${gid}::/home/grader:/bin/sh\n`);
    }
    const name = `cw-grade-${randomBytes(4).toString('hex')}`;
    const env = Object.entries({ HOME: '/home/grader', CI: 'true', ...spec.env, GRADER_REPORTS: `/workspace/${spec.reportsDir}` }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = ['run', '--rm', '--name', name, '-v', `${spec.dir}:/workspace`, '-w', '/workspace', '-v', `${home}:/home/grader`, '-v', `${passwd}:/etc/passwd:ro`, '--user', `${uid}:${gid}`, ...env, '--entrypoint', 'sh', spec.image, '-c', spec.command];
    return runLogged(docker, args, {}, spec, () => spawn(docker, ['rm', '-f', name], { stdio: 'ignore' }));
  };
}

function runLogged(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }, spec: RunSpec, kill?: () => void): Promise<number | 'timeout'> {
  return new Promise((done, fail) => {
    const log: Buffer[] = [];
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => log.push(b));
    child.stderr.on('data', (b: Buffer) => log.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (kill) kill();
      else child.kill('SIGKILL');
    }, spec.timeoutMs);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(spec.logFile, Buffer.concat(log));
      done(timedOut ? 'timeout' : (code ?? 1));
    });
  });
}

// --- grading ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The files a checkout changed since the task's base commit. */
function changedSinceBase(dir: string, base: string): string[] {
  try {
    const out = git(dir, 'diff', '--name-only', `${base}...HEAD`);
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

/** The last lines of a log that explain a failure. */
function explain(log: string): string[] {
  const lines = log.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const telling = lines.filter((l) => /\b(error|fail(ed|ure)?|exception|assert)/i.test(l));
  return (telling.length ? telling : lines).slice(-8).map((l) => l.slice(0, 300));
}

export interface GradeInput {
  task: EvalTask;
  /** A git checkout of the result, at the commit to grade. Changed in place. */
  dir: string;
  /** The grading command; the task's, or the project's build and test. */
  command: string;
  image: string;
  runner: Runner;
  cacheDir: string;
}

export async function gradeCheckout(input: GradeInput): Promise<GradeResult> {
  const started = Date.now();
  const { task, dir } = input;
  const hidden = hiddenFiles(task);
  const hiddenPaths = new Set(hidden.map(([, p]) => p));
  const overwritten = changedSinceBase(dir, task.baseCommit).filter((f) => hiddenPaths.has(f));
  for (const [src, path] of hidden) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(src, join(dir, path));
  }
  const isHidden = (c: TestCase) => hiddenPaths.has(c.classname) || task.grade.hidden.test(c.classname) || task.grade.hidden.test(c.suite);
  const attempt = async (n: number) => {
    rmSync(join(dir, REPORTS), { recursive: true, force: true });
    for (const f of task.grade.reports) rmSync(join(dir, f), { recursive: true, force: true });
    mkdirSync(join(dir, REPORTS), { recursive: true });
    const logFile = `${dir}.grade${n > 1 ? `-${n}` : ''}.log`;
    const code = await input.runner({ dir, image: input.image, command: input.command, env: {}, reportsDir: REPORTS, timeoutMs: task.grade.timeoutMinutes * 60_000, logFile, cacheDir: input.cacheDir });
    const byId = new Map<string, TestCase>();
    for (const c of junitFiles(dir, task.grade.reports).flatMap((f) => parseJUnit(readFileSync(f, 'utf8')))) {
      const id = `${c.suite}|${c.classname}#${c.name}`;
      if (!byId.has(id) || c.outcome === 'failed') byId.set(id, c);
    }
    return { code, cases: [...byId.values()], logFile };
  };
  let run = await attempt(1);
  let attempts = 1;
  let flaky: string[] = [];
  const label = (c: TestCase) => `${c.classname} > ${c.name}`;
  // A failure only in the project's own tests may be a flaky test it already has: retry once.
  // A hidden test failing is never retried.
  const firstFailed = run.cases.filter((c) => c.outcome === 'failed');
  if (run.code !== 0 && run.code !== 'timeout' && firstFailed.length && !firstFailed.some(isHidden)) {
    run = await attempt(2);
    attempts = 2;
    if (run.code === 0) flaky = firstFailed.map(label);
  }
  const log = existsSync(run.logFile) ? readFileSync(run.logFile, 'utf8') : '';
  const hiddenCases = run.cases.filter(isHidden);
  const ran = hiddenCases.filter((c) => c.outcome !== 'skipped');
  const failedCases = run.cases.filter((c) => c.outcome === 'failed');
  const withReports = task.grade.reports.length > 0 || run.cases.length > 0;
  const result = (verdict: GradeResult['verdict'], reason: string, failures: string[]): GradeResult => ({
    verdict,
    reason,
    exitCode: run.code === 'timeout' ? null : run.code,
    timedOut: run.code === 'timeout',
    attempts,
    flaky,
    ...(withReports ? { tests: { total: run.cases.length, failed: failedCases.length, hidden: ran.length, hiddenFailed: hiddenCases.filter((c) => c.outcome === 'failed').length } } : {}),
    failures,
    overwritten,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    log: run.logFile,
  });
  if (run.code === 'timeout') return result('fail', `the grading command ran past ${task.grade.timeoutMinutes} minutes`, explain(log));
  if (run.code !== 0) {
    const failures = failedCases.length ? failedCases.map((c) => `${label(c)}${c.message ? `: ${c.message}` : ''}`) : explain(log);
    return result('fail', failedCases.length ? `${failedCases.length} test(s) failed, ${hiddenCases.filter((c) => c.outcome === 'failed').length} of them hidden` : `the grading command exited ${run.code}`, failures);
  }
  if (withReports && ran.length === 0) return result('fail', 'the command passed, but no hidden test case ran', []);
  return result('pass', withReports ? `${ran.length} hidden test case(s) passed` : 'the grading command passed', []);
}

/** A fresh checkout of `repo` at `ref`, for grading. */
export function checkoutAt(repo: string, ref: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-checkout', repo, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(dest, 'fetch', '-q', 'origin', ref);
  git(dest, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  return git(dest, 'rev-parse', 'HEAD');
}

export function applyPatch(dir: string, patch: string): void {
  execFileSync('git', ['apply', '--whitespace=nowarn', patch], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

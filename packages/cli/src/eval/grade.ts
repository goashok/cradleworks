// The grader: copies a task's hidden tests over a checkout of the factory's result, runs the
// grading command in the project's image, and says pass or fail.
//
// It runs on this machine, never in an agent's sandbox, so the hidden tests stay out of the
// factory's reach. With JUnit report folders configured, a run that exits 0 without running a
// hidden test case (tests skipped, a suite emptied) is a fail, not a pass.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { hiddenFiles, type EvalTask } from './suite.ts';
import { buildError, logTail, readOutput, relativeFile, REPORT_PREFIX, type OutputReading, type TestCase } from './test-output.ts';

export type { TestCase } from './test-output.ts';

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

/** A failing test, for a person to read. */
export interface FailedTest {
  name: string;
  file?: string;
  line?: number;
  /** A hidden test, or one of the project's (or the factory's) own. */
  hidden: boolean;
  message?: string;
  expected?: string;
  actual?: string;
}

export interface GradeResult {
  verdict: 'pass' | 'fail' | 'error';
  reason: string;
  exitCode: number | null;
  timedOut: boolean;
  attempts: number;
  /** Non-hidden tests that failed, then passed on the retry. */
  flaky: string[];
  /** `hidden` is null when the runner's output gives failures but not which tests ran where (Jest). */
  tests?: { total: number; failed: number; hidden: number | null; hiddenFailed: number };
  /** The failures as one line each, for older readers. */
  failures: string[];
  /** The failing tests, hidden ones first. */
  failed: FailedTest[];
  /** Where the test cases came from: a JUnit report, the runner's output, or nowhere. */
  source: 'junit' | 'output' | 'none';
  /** The last 80 lines of the grading command's output. For people only, never for the agents. */
  outputTail: string;
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
    const failure = /<(failure|error)\b([^>]*)>?([\s\S]*?)(?:<\/(?:failure|error)>|$)/.exec(body);
    const message = failure ? (attr(failure[2]!, 'message') ?? decode(failure[3] ?? '')) : undefined;
    // Node's report spells out the assertion: "actual: 3," and "expected: 2," in the failure's text.
    const detail = failure ? decode(failure[3] ?? '') : '';
    const expected = /^\s*expected: (.+?),?$/m.exec(detail)?.[1];
    const actual = /^\s*actual: (.+?),?$/m.exec(detail)?.[1];
    const frame = /\((?:file:\/\/)?(\/[^():]+?\.\w+):(\d+):\d+\)/.exec(detail);
    const own = attr(m[1]!, 'file');
    // The report's file (Node 24 and later) has no line; the stack's first frame in it does.
    const file = own ? (frame && frame[1] === own ? `${own}:${frame[2]}` : own) : frame && !frame[1]!.startsWith('node:') ? `${frame[1]}:${frame[2]}` : undefined;
    const lines = (message ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).map((l) => l.slice(0, 300));
    cases.push({
      classname: attr(m[1]!, 'classname') ?? file ?? '',
      name: attr(m[1]!, 'name') ?? '',
      suite: suites.filter(([i]) => i < at).at(-1)?.[1] ?? '',
      outcome: failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      ...(file ? { file } : {}),
      ...(message !== undefined && lines.length ? { message: lines.join('\n') } : {}),
      ...(expected ? { expected: expected.slice(0, 200) } : {}),
      ...(actual ? { actual: actual.slice(0, 200) } : {}),
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
  // A pytest class name is its module's dotted path: tests.test_fees is tests/test_fees.py.
  const pyFile = (c: TestCase) => (/^[\w]+(\.[\w]+)+$/.test(c.classname) ? `${c.classname.replace(/\./g, '/')}.py` : undefined);
  const byPath = (c: TestCase) => hiddenPaths.has(c.classname) || (!!c.file && hiddenPaths.has(c.file)) || (!!pyFile(c) && hiddenPaths.has(pyFile(c)!)) || task.grade.hidden.test(c.classname) || task.grade.hidden.test(c.suite) || (!!c.file && task.grade.hidden.test(c.file));
  // Where the runner gives no file for a test (Node 20 and 22, and TAP for a passing test), a test
  // is hidden when its name is written in a hidden test file.
  const hiddenText = hidden.map(([src]) => readFileSync(src, 'utf8')).join('\n');
  const byName = (c: TestCase) => {
    const n = c.name.split(' > ').at(-1)!;
    return n.length > 2 && [`'${n}'`, `"${n}"`, `\`${n}\``, `def ${n}(`].some((q) => hiddenText.includes(q));
  };
  // A test file that failed to load is reported as one test named after the file.
  const fileTest = (c: TestCase) => relativeFile(c.name, dirs).file;
  const located = (c: TestCase) => !!c.file || !!pyFile(c) || hiddenPaths.has(c.classname) || hiddenPaths.has(fileTest(c) ?? '');
  const isHidden = (c: TestCase) => byPath(c) || hiddenPaths.has(fileTest(c) ?? '') || (!located(c) && byName(c));
  // Ask Node's test runner and pytest for reports, unless the project picks its own reporters:
  // two sets of reporter flags would stop Node's test runner before any test ran.
  const asksForReports = !ownReporters(dir, input.command);
  // The checkout as the tests may name it: on macOS /var is /private/var.
  const dirs = [...new Set([dir, realpathSync(dir)])];
  const attempt = async (n: number, withReports: boolean) => {
    rmSync(join(dir, REPORTS), { recursive: true, force: true });
    for (const f of task.grade.reports) rmSync(join(dir, f), { recursive: true, force: true });
    mkdirSync(join(dir, REPORTS), { recursive: true });
    const logFile = `${dir}.grade${n > 1 ? `-${n}` : ''}.log`;
    const command = withReports ? `${REPORT_PREFIX}\n${input.command}` : input.command;
    const code = await input.runner({ dir, image: input.image, command, env: {}, reportsDir: REPORTS, timeoutMs: task.grade.timeoutMinutes * 60_000, logFile, cacheDir: input.cacheDir });
    const byId = new Map<string, TestCase>();
    for (const raw of junitFiles(dir, [...task.grade.reports, ...KNOWN_REPORTS]).flatMap((f) => parseJUnit(readFileSync(f, 'utf8')))) {
      const c = raw.file ? { ...raw, ...relativeFile(raw.file, dirs) } : raw;
      const id = `${c.suite}|${c.classname}|${c.file ?? ''}#${c.name}`;
      if (!byId.has(id) || c.outcome === 'failed') byId.set(id, c);
    }
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    // No report: what the runner printed.
    const reading = byId.size ? undefined : readOutput(log, dirs);
    const cases = byId.size ? [...byId.values()] : (reading?.cases ?? []);
    return { code, cases, reading, source: (byId.size ? 'junit' : reading ? 'output' : 'none') as GradeResult['source'], logFile, log };
  };
  let run = await attempt(1, asksForReports);
  let attempts = 1;
  // The flags meant for reports must never be why a grade fails: with them, a run that failed
  // and left nothing to read runs again as the project wrote it.
  if (asksForReports && run.code !== 0 && run.code !== 'timeout' && run.source === 'none') {
    run = await attempt(2, false);
    attempts = 2;
  }
  let flaky: string[] = [];
  const label = (c: TestCase) => `${c.file ?? c.classname} > ${c.name}`;
  // A failure only in the project's own tests may be a flaky test it already has: retry once.
  // A hidden test failing is never retried.
  const firstFailed = run.cases.filter((c) => c.outcome === 'failed');
  if (run.code !== 0 && run.code !== 'timeout' && firstFailed.length && !firstFailed.some(isHidden)) {
    run = await attempt(attempts + 1, asksForReports);
    attempts++;
    if (run.code === 0) flaky = firstFailed.map(label);
  }
  const log = run.log;
  const loadError = buildError(log);
  for (const c of run.cases)
    if (c.outcome === 'failed' && /\.\w+$/.test(c.name) && (!c.message || /^test failed$/i.test(c.message.trim())) && loadError) {
      c.message = `the file did not load: ${loadError}`;
      const f = fileTest(c);
      if (!c.file && f) c.file = f;
    }
  const didNotLoad = (c: TestCase) => c.message?.startsWith('the file did not load: ') === true;
  const hiddenCases = run.cases.filter(isHidden);
  const ran = hiddenCases.filter((c) => c.outcome !== 'skipped');
  const failedCases = run.cases.filter((c) => c.outcome === 'failed');
  const hiddenFailed = hiddenCases.filter((c) => c.outcome === 'failed');
  const counts = countTests(run, isHidden, hiddenPaths, task.grade.hidden);
  // Whether a run with no hidden test can be told: every test is known, each by its file (or the
  // suite names its reports, as before). A match by name alone never fails a grade.
  const complete = (run.source === 'junit' || run.reading?.runner === 'tap') && run.cases.every(located);
  const failed: FailedTest[] = failedCases
    .map((c) => ({ name: c.name, ...(c.file ? { file: c.file } : c.classname ? { file: c.classname } : {}), ...(c.line ? { line: c.line } : {}), hidden: isHidden(c), ...(c.message ? { message: c.message } : {}), ...(c.expected !== undefined ? { expected: c.expected } : {}), ...(c.actual !== undefined ? { actual: c.actual } : {}) }))
    .sort((a, b) => Number(b.hidden) - Number(a.hidden))
    .slice(0, 20);
  const result = (verdict: GradeResult['verdict'], reason: string, failures: string[]): GradeResult => ({
    verdict,
    reason,
    exitCode: run.code === 'timeout' ? null : run.code,
    timedOut: run.code === 'timeout',
    attempts,
    flaky,
    ...(counts ? { tests: counts } : {}),
    failures,
    failed,
    source: run.source,
    outputTail: logTail(log),
    overwritten,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    log: run.logFile,
  });
  // The change edited files the hidden tests then replaced: its own tests in them did not run.
  const putBack = overwritten.length
    ? overwritten.length === 1
      ? ` The change also edited ${overwritten[0]}, which the hidden tests replace, so its own tests in that file did not run.`
      : ` The change also edited ${overwritten.length} files the hidden tests replace (${overwritten.slice(0, 3).join(', ')}), so its own tests in them did not run.`
    : '';
  const lines = failedCases.length ? failedCases.map((c) => `${label(c)}${c.message ? `: ${c.message.split('\n')[0]}` : ''}`) : explain(log);
  if (run.code === 'timeout') return result('fail', `The tests ran past the ${task.grade.timeoutMinutes}-minute limit.${putBack}`, explain(log));
  if (run.code !== 0) {
    const broken = failedCases.length ? undefined : buildError(log);
    if (broken) return result('fail', `The change does not build or load: ${broken}${putBack}`, explain(log));
    if (hiddenFailed.length) {
      const first = hiddenFailed[0]!;
      if (didNotLoad(first)) {
        const others = hiddenFailed.length - 1;
        return result('fail', `The hidden test file ${first.file ?? first.name} did not load: ${first.message!.slice('the file did not load: '.length)}${others ? `; ${others} more hidden test${others === 1 ? '' : 's'} failed` : ''}.${putBack}`, lines);
      }
      const of = counts?.hidden ? ` of ${counts.hidden}` : '';
      const more = hiddenFailed.length > 1 ? `, and ${hiddenFailed.length - 1} more` : '';
      return result('fail', `${hiddenFailed.length}${of} hidden test${hiddenFailed.length === 1 && !of ? '' : 's'} failed: ${first.name}${describe(first)}${more}.${putBack}`, lines);
    }
    if (failedCases.length) {
      const first = failedCases[0]!;
      return result('fail', `The hidden tests passed, but ${failedCases.length === 1 ? 'one of the project’s own tests' : `${failedCases.length} of the project’s own tests`} failed: ${first.name}${describe(first)}${failedCases.length > 1 ? `, and ${failedCases.length - 1} more` : ''}.${putBack}`, lines);
    }
    if (counts && counts.failed > 0) return result('fail', `${counts.failed} test${counts.failed === 1 ? '' : 's'} failed; the output does not say which.${putBack}`, lines);
    return result('fail', `The test command exited ${run.code} without a test failing that could be read. The last lines of its output say why.${putBack}`, lines);
  }
  const withReports = task.grade.reports.length > 0 || complete;
  if (withReports && ran.length === 0) return result('fail', `The tests passed, but no hidden test ran: the change may have removed or skipped them.${putBack}`, []);
  const passedHidden = withReports ? ran.length : (counts?.hidden ?? 0);
  return result('pass', passedHidden ? `All ${passedHidden} hidden test${passedHidden === 1 ? '' : 's'} passed.${putBack}` : `The test command passed.${putBack}`, []);
}

/** " (expected 2, got 3)", or the first line of the message, for a reason. */
function describe(c: TestCase): string {
  if (c.expected !== undefined && c.actual !== undefined) return ` (expected ${c.expected}, got ${c.actual})`;
  const first = c.message?.split('\n').find((l) => l.trim());
  return first ? ` (${first.slice(0, 160)})` : '';
}

/** Totals for the grade: every case when they are all known, else the runner's own totals. */
function countTests(run: { cases: TestCase[]; reading: OutputReading | undefined; source: GradeResult['source'] }, isHidden: (c: TestCase) => boolean, hiddenPaths: Set<string>, hiddenRe: RegExp): GradeResult['tests'] {
  const failedHidden = run.cases.filter((c) => c.outcome === 'failed' && isHidden(c)).length;
  if (run.source === 'junit' || run.reading?.runner === 'tap') {
    const ran = run.cases.filter((c) => c.outcome !== 'skipped');
    const hidden = ran.filter(isHidden).length;
    // None found, with some tests not located by file: unknown rather than none.
    return { total: run.cases.length, failed: run.cases.filter((c) => c.outcome === 'failed').length, hidden: hidden || run.cases.every((c) => !!c.file || /\//.test(c.classname) || /^[\w]+(\.[\w]+)+$/.test(c.classname)) ? hidden : null, hiddenFailed: failedHidden };
  }
  const t = run.reading?.totals;
  if (!t) return undefined;
  // Vitest prints tests per file, so the hidden ones can be counted; Jest does not.
  const perFile = run.reading?.perFile;
  const hiddenFiles = perFile ? Object.entries(perFile).filter(([f]) => hiddenPaths.has(f) || hiddenRe.test(f)) : undefined;
  const hidden = hiddenFiles?.length ? hiddenFiles.reduce((a, [, x]) => a + x.total, 0) : null;
  return { total: t.total, failed: t.failed, hidden, hiddenFailed: failedHidden };
}

/** Report folders the common build tools write without being asked. */
const KNOWN_REPORTS = ['target/surefire-reports', 'build/test-results'];

/** Whether the command, or a package.json script it may run, picks Node's test reporters itself. */
function ownReporters(dir: string, command: string): boolean {
  if (/--test-reporter/.test(command)) return true;
  const walk = (at: string, depth: number): boolean => {
    if (depth > 3 || !existsSync(at)) return false;
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isDirectory() ? walk(join(at, e.name), depth + 1) : e.name === 'package.json' && /--test-reporter/.test(readFileSync(join(at, e.name), 'utf8'))) return true;
    }
    return false;
  };
  return walk(dir, 0);
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

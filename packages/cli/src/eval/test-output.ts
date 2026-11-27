// Reading what a project's tests did, for a grade a person can read: each test's name, file and
// outcome, and for a failure its message and expected against actual. From a JUnit report where
// the runner wrote one (grade.ts asks Node's test runner and pytest for one), else from the
// runner's own output: Node's TAP, Vitest and Jest.

export interface TestCase {
  classname: string;
  name: string;
  suite: string;
  outcome: 'passed' | 'failed' | 'skipped';
  /** Up to three lines. */
  message?: string;
  /** The test file, relative to the checkout, when the runner said. */
  file?: string;
  line?: number;
  expected?: string;
  actual?: string;
}

/** Tests the output reported, and the runner's own totals when it gives them. */
export interface OutputReading {
  cases: TestCase[];
  /** The runner's totals; when set, `cases` may hold only the failures. */
  totals?: { total: number; failed: number };
  /** Tests per file, when the runner prints them (Vitest), for counting a folder's tests. */
  perFile?: Record<string, { total: number; failed: number }>;
  runner: 'tap' | 'vitest' | 'jest';
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const short = (s: string | undefined, lines = 3) => {
  if (s === undefined) return undefined;
  const kept = s
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, lines)
    .map((l) => l.trim().slice(0, 300));
  return kept.length ? kept.join('\n') : undefined;
};
const value = (s: string | undefined) => (s === undefined ? undefined : s.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined);

/** A path as the checkout knows it: no `file://`, no container or checkout prefix, no line number. */
export function relativeFile(path: string | undefined, dir?: string | string[]): { file?: string; line?: number } {
  if (!path) return {};
  let p = path.replace(/^file:\/\//, '');
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(p);
  const line = m ? Number(m[2]) : undefined;
  if (m) p = m[1]!;
  const under = (Array.isArray(dir) ? dir : dir ? [dir] : []).find((d) => p.startsWith(`${d}/`));
  if (under) p = p.slice(under.length + 1);
  else if (p.startsWith('/workspace/')) p = p.slice('/workspace/'.length);
  p = p.replace(/^\.\//, '');
  return { file: p, ...(line ? { line } : {}) };
}

// --- TAP (Node's test runner when its output is not a terminal) -------------------------------

/** Node's TAP: `ok`/`not ok` lines, nested by indent, each with a YAML block of details. */
export function parseTap(text: string, dir?: string | string[]): OutputReading | undefined {
  const lines = stripAnsi(text).split('\n');
  if (!lines.some((l) => /^TAP version \d+/.test(l.trim()))) return undefined;
  const cases: TestCase[] = [];
  // The open subtests by indent, for names like "group > inner".
  const stack: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const indent = sub[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      stack.push({ indent, name: sub[2]!.trim() });
      continue;
    }
    const t = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (!t) continue;
    const indent = t[1]!.length;
    while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
    const parents = stack.filter((s) => s.indent < indent).map((s) => s.name);
    // Its YAML block: from "---" to "...", at the test's indent plus two.
    const yaml: string[] = [];
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      for (; j < lines.length && lines[j]!.trim() !== '...'; j++) yaml.push(lines[j]!);
      i = j;
    }
    const field = readYaml(yaml);
    // A test that only failed because its subtests did is not a test of its own.
    if (field.failureType === 'subtestsFailed' || field.type === 'suite') continue;
    const where = relativeFile(field.location, dir);
    const outcome: TestCase['outcome'] = t[4] ? 'skipped' : t[2] === 'ok' ? 'passed' : 'failed';
    cases.push({
      classname: where.file ?? '',
      name: [...parents, t[3]!.trim()].join(' > '),
      suite: parents[0] ?? '',
      outcome,
      ...where,
      ...(outcome === 'failed' ? failureFields(field) : {}),
    });
  }
  return cases.length ? { cases, runner: 'tap' } : undefined;
}

function failureFields(field: Record<string, string>): Pick<TestCase, 'message' | 'expected' | 'actual'> {
  const out: Pick<TestCase, 'message' | 'expected' | 'actual'> = {};
  const message = short(field.error);
  const expected = value(field.expected);
  const actual = value(field.actual);
  if (message) out.message = message;
  if (expected !== undefined) out.expected = expected;
  if (actual !== undefined) out.actual = actual;
  return out;
}

/** The top-level keys of a TAP YAML block, block scalars and nested maps flattened to text. */
function readYaml(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!lines.length) return out;
  const base = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  let key: string | undefined;
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const m = indent === base ? /^\s*([\w-]+):\s?(.*)$/.exec(raw) : null;
    if (m) {
      key = m[1]!;
      const v = m[2]!;
      out[key] = v === '|-' || v === '|' || v === '>-' ? '' : v.replace(/^'(.*)'$/, '$1');
    } else if (key) {
      out[key] = out[key] ? `${out[key]}\n${raw.slice(base + 2)}` : raw.slice(base + 2);
    }
  }
  return out;
}

// --- Vitest --------------------------------------------------------------------------------

export function parseVitest(text: string): OutputReading | undefined {
  const lines = stripAnsi(text).split('\n');
  const totals = lines.map((l) => /^\s*Tests\s+(.*)\((\d+)\)\s*$/.exec(l)).find(Boolean);
  if (!totals || !lines.some((l) => /\bRUN\b.*v\d/.test(l) || /^\s*Test Files\s/.test(l))) return undefined;
  const failedTotal = Number(/(\d+) failed/.exec(totals[1]!)?.[1] ?? 0);
  const perFile: Record<string, { total: number; failed: number }> = {};
  for (const l of lines) {
    const f = /^\s*[✓❯×↓]\s+(\S+\.\w+)\s+\((\d+) tests?(?:\s*\|\s*(\d+) failed)?/.exec(l);
    if (f) perFile[f[1]!] = { total: Number(f[2]), failed: Number(f[3] ?? 0) };
  }
  const cases: TestCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*FAIL\s+(\S+\.\w+)\s+>\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const parts = m[2]!.split(/\s+>\s+/).map((s) => s.trim());
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s*(FAIL\s|⎯)/.test(lines[j]!); j++) body.push(lines[j]!);
    const message = body.find((l) => l.trim() && !/^\s*❯/.test(l));
    const exp = body.findIndex((l) => /^\s*- Expected\s*$/.test(l));
    const diff = exp >= 0 ? body.slice(exp + 2).filter((l) => /^\s*[-+] /.test(l)) : [];
    const lineNo = body.map((l) => new RegExp(`❯\\s+${escape(m[1]!)}:(\\d+)`).exec(l)).find(Boolean);
    const expected = diff.filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2)).join(' ');
    const actual = diff.filter((l) => l.trim().startsWith('+ ')).map((l) => l.trim().slice(2)).join(' ');
    cases.push({
      classname: m[1]!,
      file: m[1]!,
      ...(lineNo ? { line: Number(lineNo[1]) } : {}),
      name: parts.join(' > '),
      suite: parts.length > 1 ? parts[0]! : '',
      outcome: 'failed',
      ...(message ? { message: short(message)! } : {}),
      ...(expected ? { expected: value(expected)! } : {}),
      ...(actual ? { actual: value(actual)! } : {}),
    });
  }
  return { cases, totals: { total: Number(totals[2]), failed: failedTotal }, perFile, runner: 'vitest' };
}

// --- Jest ----------------------------------------------------------------------------------

export function parseJest(text: string): OutputReading | undefined {
  const lines = stripAnsi(text).split('\n');
  const totals = lines.map((l) => /^Tests:\s+(.*?)(\d+) total/.exec(l)).find(Boolean);
  if (!totals) return undefined;
  const failedTotal = Number(/(\d+) failed/.exec(totals[1]!)?.[1] ?? 0);
  const cases: TestCase[] = [];
  let file = '';
  for (let i = 0; i < lines.length; i++) {
    const f = /^(?:PASS|FAIL)\s+(\S+)/.exec(lines[i]!);
    if (f) {
      file = f[1]!;
      continue;
    }
    const m = /^\s+● (.*)$/.exec(lines[i]!);
    if (!m || /^Test suite failed to run/.test(m[1]!)) continue;
    const parts = m[1]!.split(' › ').map((s) => s.trim());
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s+● /.test(lines[j]!) && !/^(PASS|FAIL|Test Suites:)/.test(lines[j]!); j++) body.push(lines[j]!);
    const message = body.find((l) => l.trim() && !/^\s*(>?\s*\d+ \||\|)/.test(l));
    const expected = body.map((l) => /^\s*Expected:\s*(.*)$/.exec(l)?.[1]).find((x) => x !== undefined);
    const actual = body.map((l) => /^\s*Received:\s*(.*)$/.exec(l)?.[1]).find((x) => x !== undefined);
    const at = body.map((l) => /\bat .*\((\S+?):(\d+):\d+\)/.exec(l)).find(Boolean);
    cases.push({
      classname: file,
      file: at?.[1] ?? file,
      ...(at ? { line: Number(at[2]) } : {}),
      name: parts.join(' > '),
      suite: parts.length > 1 ? parts[0]! : '',
      outcome: 'failed',
      ...(message ? { message: short(message)! } : {}),
      ...(expected !== undefined ? { expected: value(expected)! } : {}),
      ...(actual !== undefined ? { actual: value(actual)! } : {}),
    });
  }
  return { cases, totals: { total: Number(totals[2]), failed: failedTotal }, runner: 'jest' };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first reading the output gives, trying each runner's format. */
export function readOutput(text: string, dir?: string | string[]): OutputReading | undefined {
  return parseTap(text, dir) ?? parseVitest(text) ?? parseJest(text);
}

// --- what else a log says --------------------------------------------------------------------

const BUILD_ERRORS = [
  /error TS\d+:.*/,
  /SyntaxError: .*/,
  /Error \[ERR_MODULE_NOT_FOUND\]: .*/,
  /Cannot find module .*/,
  /ModuleNotFoundError: .*/,
  /ImportError: .*/,
  /error\[E\d+\]: .*/,
  /\[ERROR\] COMPILATION ERROR.*/,
  /error: cannot find symbol.*/,
  /Compilation failed.*/,
];

/** The first line of a log that says the code would not build or load. */
export function buildError(log: string): string | undefined {
  for (const line of stripAnsi(log).split('\n')) {
    for (const re of BUILD_ERRORS) {
      const m = re.exec(line);
      if (m) return m[0].trim().slice(0, 300);
    }
  }
  return undefined;
}

/** The end of a log, for a person to read: the last lines, colour codes taken out. */
export function logTail(log: string, lines = 80, chars = 16_000): string {
  const kept = stripAnsi(log).replace(/\r/g, '').split('\n').slice(-lines).join('\n');
  return kept.length > chars ? kept.slice(-chars) : kept;
}

/**
 * A shell prefix for the grading command that asks Node's test runner and pytest for JUnit
 * reports in $GRADER_REPORTS, keeping their usual output. Node's flags go in only when this Node
 * accepts them there, so an old Node runs the command as it was.
 */
export const REPORT_PREFIX = [
  '_cw_node="--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=$GRADER_REPORTS/node-test.xml"',
  'if command -v node >/dev/null 2>&1 && NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_cw_node" node -e 0 >/dev/null 2>&1; then export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_cw_node"; fi',
  'export PYTEST_ADDOPTS="${PYTEST_ADDOPTS:+$PYTEST_ADDOPTS }--junitxml=$GRADER_REPORTS/pytest.xml"',
  'unset _cw_node',
].join('; ');

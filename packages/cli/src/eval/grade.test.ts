import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeCheckout, hostRunner } from './grade.ts';
import type { EvalTask } from './suite.ts';

// Real grades of a small Node project, run by the grader on this machine.
const HIDDEN = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls } from '../src/print.js';
test('logs once without a schema', () => assert.equal(calls(undefined), 1));
test('logs twice with a schema', () => assert.equal(calls({}), 2));
test('null schema logs once', () => assert.equal(calls(null), 1));
`;

function project(src: string, scripts: Record<string, string> = { test: 'node --test' }, ownTest = "test('own', () => assert.ok(true));") {
  const dir = mkdtempSync(join(tmpdir(), 'cw-grade-'));
  const work = join(dir, 'work');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'test'), { recursive: true });
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'p', type: 'module', scripts }));
  writeFileSync(join(work, 'src', 'print.js'), 'export const calls = () => 1;\n');
  writeFileSync(join(work, 'test', 'own.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${ownTest}\n`);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(work, 'src', 'print.js'), src);
  git('commit', '-qam', 'change');
  const taskDir = join(dir, 'task');
  mkdirSync(join(taskDir, 'hidden', 'test'), { recursive: true });
  writeFileSync(join(taskDir, 'hidden', 'test', 'print.test.js'), HIDDEN);
  const task: EvalTask = { id: 't', dir: taskDir, title: 't', issue: '', baseCommit: base, grade: { reports: [], hidden: /(^|[./\\])hidden([./\\]|$)/, timeoutMinutes: 2 }, expectBase: 'fail', wrong: [] };
  return { work, task, cacheDir: join(dir, 'cache') };
}

const grade = (p: ReturnType<typeof project>, command = 'npm test --silent') => gradeCheckout({ task: p.task, dir: p.work, command, image: 'unused', runner: hostRunner, cacheDir: p.cacheDir });

describe('a grade a person can read', () => {
  it('names the hidden test that failed, with expected against actual, and counts the hidden tests', async () => {
    const g = await grade(project('export const calls = (s) => (s === undefined ? 1 : 2);\n'));
    expect(g.verdict).toBe('fail');
    expect(g.reason).toBe('1 of 3 hidden tests failed: null schema logs once (expected 1, got 2).');
    expect(g.source).toBe('junit');
    expect(g.tests).toEqual({ total: 4, failed: 1, hidden: 3, hiddenFailed: 1 });
    expect(g.failed).toEqual([{ name: 'null schema logs once', file: 'test/print.test.js', line: expect.any(Number), hidden: true, message: expect.stringContaining('2 !== 1'), expected: '1', actual: '2' }]);
    expect(g.failures).toEqual([expect.stringContaining('test/print.test.js > null schema logs once')]);
    expect(g.outputTail).toContain('null schema logs once');
  });

  it('passes with every hidden test passing, and says how many', async () => {
    const g = await grade(project('export const calls = (s) => (s === undefined || s === null ? 1 : 2);\n'));
    expect(g).toMatchObject({ verdict: 'pass', reason: 'All 3 hidden tests passed.', tests: { total: 4, hidden: 3, hiddenFailed: 0 } });
  });

  it('tells the project’s own failing test from a hidden one', async () => {
    const g = await grade(project('export const calls = (s) => (s === undefined || s === null ? 1 : 2);\n', undefined, "test('own check', () => assert.equal('a', 'b'));"));
    expect(g.verdict).toBe('fail');
    expect(g.reason).toBe("The hidden tests passed, but one of the project’s own tests failed: own check (expected 'b', got 'a').");
    expect(g.failed).toMatchObject([{ name: 'own check', file: 'test/own.test.js', hidden: false }]);
    // An own test failing is tried once more, in case it is flaky.
    expect(g.attempts).toBe(2);
  });

  it('says when the change does not build', async () => {
    const g = await grade(project('export const calls = (s) => {\n'), 'node --check src/print.js && npm test --silent');
    expect(g.verdict).toBe('fail');
    expect(g.reason).toMatch(/^The change does not build or load: SyntaxError: /);
  });

  it('says when the change edited a file the hidden tests replace', async () => {
    const p = project('export const calls = (s) => (s === undefined || s === null ? 1 : 2);\n');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: p.work, stdio: 'pipe' });
    writeFileSync(join(p.work, 'test', 'print.test.js'), "import { test } from 'node:test';\ntest('mine', () => {});\n");
    git('add', '-A');
    git('commit', '-qm', 'own tests');
    const g = await grade(p);
    expect(g.reason).toBe('All 3 hidden tests passed. The change also edited test/print.test.js, which the hidden tests replace, so its own tests in that file did not run.');
  });

  it('leaves a command that picks its own reporter as it is', async () => {
    const p = project('export const calls = (s) => (s === undefined || s === null ? 1 : 2);\n', { test: 'node --test --test-reporter=dot' });
    const g = await grade(p);
    // No report and no output it can read: graded by the exit code alone, as before.
    expect(g).toMatchObject({ verdict: 'pass', reason: 'The test command passed.', source: 'none', attempts: 1 });
  });
});

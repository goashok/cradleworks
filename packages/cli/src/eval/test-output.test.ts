import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJUnit } from './grade.ts';
import { buildError, logTail, parseJest, parseTap, parseVitest, readOutput, relativeFile } from './test-output.ts';

// Recorded from the runners themselves: Node 22's test runner (TAP when not a terminal, and its
// JUnit reporter), Vitest 3.2, Jest 29 and pytest 8.3, each with one failing test.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('reading what the tests did', () => {
  it('reads Node’s TAP: every test, nested names, file, and expected against actual', () => {
    const r = parseTap(fixture('node-tap.txt'))!;
    expect(r.runner).toBe('tap');
    // Node gives a test's file only when it fails.
    expect(r.cases.map((c) => [c.name, c.outcome, c.file])).toEqual([
      ['passes', 'passed', undefined],
      ['counts calls', 'failed', 'test/a.test.js'],
      ['group > inner fails', 'failed', 'test/a.test.js'],
      ['b passes', 'passed', undefined],
      ['b fails', 'failed', 'test/b.test.js'],
    ]);
    expect(r.cases[1]).toMatchObject({ line: 4, expected: '2', actual: '3', message: 'Expected values to be strictly equal:\n3 !== 2' });
    // A nested expected value is flattened to one line.
    expect(r.cases[2]).toMatchObject({ expected: 'a: 2', actual: 'a: 1' });
  });

  it('reads Node’s JUnit report, with the assertion’s values and a failure’s file from its stack', () => {
    const cases = parseJUnit(fixture('node-junit.xml'));
    const failed = cases.filter((c) => c.outcome === 'failed');
    expect(failed.map((c) => [c.name, relativeFile(c.file).file])).toEqual([
      ['counts calls', 'test/a.test.js'],
      ['inner fails', 'test/a.test.js'],
      ['b fails', 'test/b.test.js'],
    ]);
    expect(failed[0]).toMatchObject({ expected: '2', actual: '3', message: expect.stringContaining('3 !== 2') });
  });

  it('reads pytest’s report', () => {
    const cases = parseJUnit(fixture('pytest-junit.xml'));
    expect(cases.map((c) => [c.classname, c.name, c.outcome])).toEqual([
      ['tests.test_fees', 'test_passes', 'passed'],
      ['tests.test_fees', 'test_charges_at_23_hours', 'failed'],
    ]);
    expect(cases[1]!.message).toContain('assert 0 == 20');
  });

  it('reads Vitest’s failures, its totals and its tests per file', () => {
    const r = parseVitest(fixture('vitest.txt'))!;
    expect(r.totals).toEqual({ total: 4, failed: 1 });
    expect(r.perFile).toEqual({ 'test/b.test.js': { total: 2, failed: 0 }, 'test/a.test.js': { total: 2, failed: 1 } });
    expect(r.cases).toEqual([
      { classname: 'test/a.test.js', file: 'test/a.test.js', line: 3, name: 'fees > charges at 23 hours', suite: 'fees', outcome: 'failed', message: 'AssertionError: expected +0 to be 20 // Object.is equality', expected: '20', actual: '0' },
    ]);
  });

  it('reads Jest’s failures and totals', () => {
    const r = parseJest(fixture('jest.txt'))!;
    expect(r.totals).toEqual({ total: 3, failed: 1 });
    expect(r.cases).toEqual([
      { classname: 'test/a.test.js', file: 'test/a.test.js', line: 2, name: 'fees > charges at 23 hours', suite: 'fees', outcome: 'failed', message: 'expect(received).toBe(expected) // Object.is equality', expected: '20', actual: '0' },
    ]);
  });

  it('knows none of them in other output, and says when code would not build', () => {
    expect(readOutput('all good\n')).toBeUndefined();
    expect(buildError('> node --check src/greet.js\n/w/src/greet.js:3\n}\nSyntaxError: Unexpected token \'}\'\n')).toBe("SyntaxError: Unexpected token '}'");
    expect(buildError('src/a.ts(3,1): error TS2304: Cannot find name \'x\'.')).toBe("error TS2304: Cannot find name 'x'.");
    expect(buildError('3 tests passed')).toBeUndefined();
    expect(logTail(`${'line\n'.repeat(200)}\x1b[31mred\x1b[39m`).split('\n')).toHaveLength(80);
    expect(logTail('\x1b[31mred\x1b[39m')).toBe('red');
    expect(relativeFile('file:///workspace/test/a.test.js:4:1')).toEqual({ file: 'test/a.test.js', line: 4 });
  });
});

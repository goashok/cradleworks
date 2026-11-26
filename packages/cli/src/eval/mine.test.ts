import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBareRepo, git } from '@cradleworks/contracts/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSuite, loadTask } from './suite.ts';
import { changeType, mine, pullNumber, rank, unmentionedNames, type Candidate, type PullSource } from './mine.ts';

// Each test script under test/ checks one thing; the project's test command runs them all.
const FACTORY_YAML = `project: demo
adapters: { scm: github, ci: github-actions, tracker: github-issues, sandbox: process, runtime: scripted }
runtime: { agent: scripted, model: none }
stack: { image: unused, build: "true", test: "for f in test/*.sh; do sh $f || exit 1; done" }
gates: { change_approval: human }
`;

let root: string;
let repo: string;
let work: string;

async function merge(subject: string, files: Record<string, string>, body = '') {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), text);
  }
  await git(['-C', work, 'add', '-A']);
  await git(['-C', work, 'commit', '--quiet', '-m', subject, ...(body ? ['-m', body] : [])]);
  await git(['-C', work, 'push', '--quiet', 'origin', 'HEAD:main']);
  return (await git(['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-mine-'));
  repo = join(root, 'project.git');
  await createBareRepo(repo, { 'README.md': '# Demo\n', '.factory/factory.yaml': FACTORY_YAML, 'test/readme.sh': 'grep -q Demo README.md\n' });
  work = join(root, 'work');
  await git(['clone', '--quiet', repo, work]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pulls = (map: Record<number, Awaited<ReturnType<PullSource['pull']>>>): PullSource => ({ pull: async (n) => map[n] });

describe('factory eval mine', () => {
  it('turns merges that changed tests into checked tasks, with the issue as the request and nothing of the answer leaking', async () => {
    const greetBase = (await git(['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
    await merge('Add a greeting (#1)', { 'greeting.txt': 'hello\n', 'test/greeting.sh': 'grep -qx hello greeting.txt\n', '.factory/specs/issue-1.md': 'spec\n' });
    await merge('Tidy the readme (#2)', { 'README.md': '# Demo\n\nA demo.\n' });
    await merge('Start tests faster (#3)', { 'tools.txt': 'fast\n', 'test/readme.sh': 'grep -q Demo README.md\n# faster\n' });
    const later = await merge('Add a farewell (#4)', { 'farewell.txt': 'bye\n', 'test/farewell.sh': 'grep -qx bye farewell.txt\n' });

    const out = join(root, 'suite');
    const r = await mine({
      repo,
      out,
      pulls: pulls({
        1: { title: 'Add a greeting', body: 'Part of the greeting work.\n\n## Agent summary\nI wrote hello.', issue: { number: 7, title: 'Greet people', body: 'Write greeting.txt saying hello.' }, reviewRounds: 1 },
        4: { title: 'Add a farewell', body: 'Write farewell.txt saying bye.\n\nCo-authored-by: someone' },
      }),
      log: () => {},
    });

    // #2 changed no tests; #3's tests already pass before it, so it is dropped.
    expect(r.withoutTests).toBe(1);
    const by = Object.fromEntries(r.candidates.map((c) => [c.pr, c]));
    expect(by[3]?.status).toBe('dropped');
    expect(by[3]?.note).toMatch(/base: expected fail, got pass/);
    expect(r.proposed.sort()).toEqual([by[1]!.id, by[4]!.id].sort());
    expect(r.smoke.length).toBe(2);

    const suite = loadSuite(out);
    expect(suite.settingsFrom).toBe(later);
    expect(suite.sets.proposed?.sort()).toEqual(r.proposed.sort());
    const greet = loadTask(suite, by[1]!.id);
    expect(greet.baseCommit).toBe(greetBase);
    // The issue is the request; the pull request's own account of the answer is not.
    expect(greet.issue).toBe('# Greet people\n\nWrite greeting.txt saying hello.\n');
    expect(readFileSync(join(greet.dir, 'hidden', 'test', 'greeting.sh'), 'utf8')).toBe('grep -qx hello greeting.txt\n');
    const patch = readFileSync(greet.solution!, 'utf8');
    expect(patch).toContain('greeting.txt');
    expect(patch).not.toMatch(/test\/greeting\.sh|\.factory\//);
    expect(by[1]).toMatchObject({ requestFrom: 'issue', issue: 7, reviewRounds: 1, type: 'feature', size: 'small', hiddenFiles: ['test/greeting.sh'] });
    expect(loadTask(suite, by[4]!.id).issue).toBe('# Add a farewell\n\nWrite farewell.txt saying bye.\n');
    expect(readFileSync(join(out, 'candidates.md'), 'utf8')).toMatch(/\| dropped \| pr-3-/);
    // The working copy mine made is gone.
    expect(existsSync(join(out, '.mine'))).toBe(false);
  });

  it('falls back to the commit message, and refuses a suite inside the repository or over an existing one', async () => {
    await merge('Add a greeting', { 'greeting.txt': 'hello\n', 'test/greeting.sh': 'grep -qx hello greeting.txt\n' }, 'Write greeting.txt saying hello.\n\nSigned-off-by: someone');
    const out = join(root, 'suite');
    const r = await mine({ repo, out, noCheck: true, log: () => {} });
    expect(r.candidates[0]).toMatchObject({ requestFrom: 'commit', status: 'proposed' });
    expect(readFileSync(join(out, 'tasks', r.candidates[0]!.id, 'issue.md'), 'utf8')).toBe('# Add a greeting\n\nWrite greeting.txt saying hello.\n');
    await expect(mine({ repo, out, noCheck: true, log: () => {} })).rejects.toThrow(/not empty/);
    await expect(mine({ repo: work, out: join(work, 'suite'), noCheck: true, log: () => {} })).rejects.toThrow(/outside the repository/);
  });

  it('flags tests that use a name the change added and the request never mentions', () => {
    const solution = 'export function printJson(value) {\n  return JSON.stringify(value);\n}\napp.get("/bookings/:id", handler)\n';
    const tests = "import { printJson } from '../src/print.js';\ntest('x', () => printJson(1));\nawait request(app).get('/bookings/:id');\n";
    expect(unmentionedNames(solution, tests, 'Print a value as JSON.')).toEqual(['/bookings/:id', 'printJson']);
    expect(unmentionedNames(solution, tests, 'Add printJson(value), and GET /bookings/:id.')).toEqual([]);
  });

  it('reads pull request numbers, guesses the kind of change, and spreads the proposal over areas', () => {
    expect(pullNumber('Merge pull request #7 from acme/branch')).toBe(7);
    expect(pullNumber('Add howdy (#17)')).toBe(17);
    expect(pullNumber('Add howdy')).toBeUndefined();
    expect(changeType('Fix rounding in totals')).toBe('bug fix');
    expect(changeType('Bump express to 5')).toBe('dependency');
    expect(changeType('Refactor the booking store')).toBe('refactor');
    expect(changeType('Add a search endpoint')).toBe('feature');

    const c = (id: string, area: string, day: number): Candidate => ({ id, commit: id, base: id, mergedAt: `2026-11-${String(day).padStart(2, '0')}`, title: id, requestFrom: 'commit', type: 'feature', size: 'small', area, linesChanged: 10, filesChanged: 2, hiddenFiles: [], testCases: 1, unmentioned: [], status: 'spare' });
    const order = rank([c('a1', 'api', 10), c('a2', 'api', 9), c('a3', 'api', 8), c('w1', 'web', 1)]).map((x) => x.id);
    // One per area each round, newest first; a third like change in the same area goes last.
    expect(order).toEqual(['a1', 'w1', 'a2', 'a3']);
  });
});

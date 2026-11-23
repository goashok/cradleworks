import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareRepo, git, ScriptedAgentRuntime } from '@cradleworks/contracts/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRegistry, run, type Registry } from '../index.ts';
import { compare } from './report.ts';
import { readResults } from './run.ts';
import { loadVariant } from './variant.ts';

const FACTORY_YAML = `project: demo
adapters: { scm: github, ci: github-actions, tracker: github-issues, sandbox: process, runtime: scripted }
runtime: { agent: scripted, model: none }
stack: { image: unused, build: "true", test: "true" }
gates: { change_approval: human }
`;

let root: string;
let suite: string;
let base: string;

// The implementer writes the fix, or a broken one when its prompt says so; the reviewer passes it.
function registry(): Registry {
  return {
    ...defaultRegistry(),
    runtime: {
      scripted: () =>
        new ScriptedAgentRuntime((req) =>
          req.profile.role === 'reviewer'
            ? [{ kind: 'message', text: '{"verdict":"pass","risk":"low","reasons":[]}' }]
            : [
                { kind: 'message', text: 'Done.' },
                { kind: 'write', path: 'greeting.txt', content: req.rolePrompt.includes('Write it in shouting capitals.') ? 'HELLO\n' : 'hello\n' },
              ],
        ),
    },
  };
}

async function factory(args: string[], cwd = root) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, { cwd, env: { CRADLEWORKS_HOME: join(root, 'home'), USER: 'tester' }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), registry: registry() });
  return { code, stdout, stderr };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-eval-'));
  const repo = join(root, 'project.git');
  await createBareRepo(repo, { 'README.md': '# Demo\n', '.factory/factory.yaml': FACTORY_YAML, '.factory/rules/style.md': 'Keep it short.\n' });
  base = (await git(['--git-dir', repo, 'rev-parse', 'main'])).stdout.trim();
  suite = join(root, 'suite');
  const task = join(suite, 'tasks', 'greet');
  mkdirSync(join(task, 'hidden'), { recursive: true });
  mkdirSync(join(task, 'wrong'), { recursive: true });
  writeFileSync(join(suite, 'suite.yaml'), `repo: ../project.git\nsets:\n  smoke: [greet]\ngrade:\n  command: sh hidden-check.sh\n`);
  writeFileSync(join(task, 'task.yaml'), `base_commit: ${base}\ntype: feature\nsize: small\n`);
  writeFileSync(join(task, 'issue.md'), '# Add a greeting\n\nCreate greeting.txt saying hello.\n');
  writeFileSync(join(task, 'hidden', 'hidden-check.sh'), 'grep -qx hello greeting.txt\n');
  const patch = (text: string) => `diff --git a/greeting.txt b/greeting.txt\nnew file mode 100644\n--- /dev/null\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+${text}\n`;
  writeFileSync(join(task, 'solution.patch'), patch('hello'));
  writeFileSync(join(task, 'wrong', 'shouting.patch'), patch('HELLO'));
  writeFileSync(join(root, 'shout.yaml'), 'name: shout\ndescription: Shouting implementer\nfiles:\n  .factory/prompts/implementer.md: "Write it in shouting capitals."\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('factory eval', () => {
  it('checks a task: its hidden tests fail at the base, pass with the solution and fail with each wrong one', async () => {
    const r = await factory(['eval', 'check', suite]);
    expect(r.stdout).toContain('greet base: ok  expected fail, got fail');
    expect(r.stdout).toContain('greet solution: ok  expected pass, got pass');
    expect(r.stdout).toContain('greet wrong/shouting.patch: ok  expected fail, got fail');
    expect(r.code).toBe(0);
  });

  it('runs the factory on a scratch copy, grades what it merged, and compares a variant against the noise band', async () => {
    const out = (label: string) => join(root, 'results', `${label}.jsonl`);
    for (const label of ['base-1', 'base-2']) {
      const r = await factory(['eval', 'run', suite, '@smoke', '--label', label, '--out', out(label)]);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('greet: PASS  factory merged');
      expect(r.code).toBe(0);
    }
    const v = await factory(['eval', 'run', suite, 'greet', '--variant', join(root, 'shout.yaml'), '--out', out('shout')]);
    expect(v.stdout).toContain('greet: FAIL  factory merged');
    expect(v.stdout).toContain('hidden tests fail');

    const [first] = readResults(out('base-1'));
    expect(first).toMatchObject({ task: 'greet', label: 'base-1', variant: null, merged: true, graded: 'merged', passed: true });
    const [shout] = readResults(out('shout'));
    expect(shout!.variant).toEqual({ name: 'shout', hash: loadVariant(join(root, 'shout.yaml')).hash });

    // The project itself is untouched: the factory worked on a copy.
    const branches = (await git(['--git-dir', join(root, 'project.git'), 'branch', '--list'])).stdout;
    expect(branches.trim()).toBe('* main');

    const c = await factory(['eval', 'compare', '--base', out('base-1'), '--base', out('base-2'), '--variant', out('shout')]);
    expect(c.stdout).toContain('Noise band: the factory as configured scored 1 of 1.');
    expect(c.stdout).toContain('Verdict: worse.');
    expect(c.stdout).toContain('greet  2/2 as configured, 0/1 with the variant  ← worse');

    const one = compare([{ file: 'a', results: readResults(out('base-1')) }], [{ file: 'b', results: readResults(out('shout')) }]);
    expect(one.verdict).toBe('unknown');
  });

  it('reports what the factory did on real work', async () => {
    await factory(['eval', 'run', suite, 'greet', '--label', 'base', '--out', join(root, 'r.jsonl')]);
    // Each task's factory state is kept beside the results, so stats can read it.
    let stats = '';
    const r = await run(['stats', '--days', '1'], { cwd: root, env: { CRADLEWORKS_HOME: join(root, 'base.d', 'greet', 'home') }, stdout: (t) => (stats += t), stderr: () => undefined, registry: registry() });
    expect(r).toBe(0);
    expect(stats).toContain('tasks            1: 1 merged');
    expect(stats).toContain('first time       1 of 1 merged tasks (100%)');
    expect(stats).toContain('Verify           1 runs: 1 passed (100%)');
    expect(stats).toContain('gate change_approval: 1 decided, 1 approved, 0 sent back, 0 by a person');
    expect(readFileSync(join(root, 'r.jsonl'), 'utf8')).toContain('"passed":true');
  });
});


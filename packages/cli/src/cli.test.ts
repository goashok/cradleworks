import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareRepo, git, ScriptedAgentRuntime } from '@cradleworks/contracts/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRegistry, parseTaskFile, run, type Registry } from './index.ts';

const FACTORY_YAML = `project: demo
adapters: { scm: local-git, ci: none, tracker: none, sandbox: process, runtime: scripted }
runtime: { agent: scripted, model: none }
stack: { image: unused, build: "true", test: "true" }
`;

let root: string;
let checkout: string;
let home: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-cli-'));
  home = join(root, 'home');
  const bare = join(root, 'remote.git');
  await createBareRepo(bare, {
    'README.md': '# Demo\n',
    '.factory/factory.yaml': FACTORY_YAML,
    '.factory/rules/style.md': 'Keep it short.\n',
    'src/app.txt': 'app\n',
  });
  checkout = join(root, 'checkout');
  await git(['clone', '--quiet', bare, checkout]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function registry(): Registry {
  const base = defaultRegistry();
  return {
    ...base,
    runtime: {
      scripted: () =>
        new ScriptedAgentRuntime(() => [
          { kind: 'message', text: 'Adding a changelog.' },
          { kind: 'write', path: 'CHANGELOG.md', content: '# Changelog\n' },
        ]),
    },
  };
}

async function factory(args: string[], cwd = checkout, reg: Registry = registry()) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    cwd,
    env: { CRADLEWORKS_HOME: home, USER: 'tester' },
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    registry: reg,
  });
  return { code, stdout, stderr };
}

describe('factory submit', () => {
  it('builds a task file and opens a pull request, from a subfolder of the project', async () => {
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Add a changelog\n\nCreate CHANGELOG.md with a heading.\n');

    const result = await factory(['submit', taskFile], join(checkout, 'src'));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Submitted "Add a changelog" as wi_/);
    expect(result.stdout).toMatch(/Opened file:\/\/.*remote\.git#pull-1/);
    expect(result.stderr).toMatch(/for testing only/);

    const list = await factory(['status']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/WORK ITEM\s+STATE\s+TASKS\s+PROJECT\s+TITLE/);
    expect(list.stdout).toMatch(/wi_\S+\s+in_progress\s+0\/1\s+demo\s+Add a changelog/);

    const id = /(wi_\S+)/.exec(list.stdout.split('\n')[1]!)![1]!;
    const detail = await factory(['status', id]);
    expect(detail.stdout).toContain('verifying  Add a changelog');
    expect(detail.stdout).toMatch(/pr\s+file:\/\/.*#pull-1/);
    expect(detail.stdout).toMatch(/spec_approval\s+approved \(skipped\) by /);
  });

  it('reports a failed build with exit code 1', async () => {
    const reg = registry();
    reg.runtime.scripted = () => new ScriptedAgentRuntime(() => [{ kind: 'message', text: 'No changes.' }]);
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Do nothing\n');
    const result = await factory(['submit', taskFile], checkout, reg);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Build failed: commit: the agent finished without changing any files/);
  });

  it('explains setup problems with exit code 2', async () => {
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# T\n');

    const outside = mkdtempSync(join(tmpdir(), 'cw-cli-outside-'));
    try {
      expect(await factory(['submit', taskFile], outside)).toMatchObject({ code: 2, stderr: expect.stringMatching(/no \.factory\/factory\.yaml/) });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    writeFileSync(join(checkout, '.factory', 'factory.yaml'), FACTORY_YAML.replace('runtime: scripted', 'runtime: nope'));
    expect((await factory(['submit', taskFile])).stderr).toMatch(/unknown runtime adapter "nope" \(known: scripted\)/);

    const noAuth = registry();
    noAuth.runtime.scripted = () => {
      throw new Error('No Claude Code credentials found.');
    };
    writeFileSync(join(checkout, '.factory', 'factory.yaml'), FACTORY_YAML);
    expect(await factory(['submit', taskFile], checkout, noAuth)).toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/cannot set up runtime "scripted": No Claude Code credentials found/),
    });

    writeFileSync(join(checkout, '.factory', 'factory.yaml'), `${FACTORY_YAML}concurrency: 0\n`);
    const bad = await factory(['submit', taskFile]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/\.factory\/factory\.yaml:5:14 {2}concurrency must be at least 1/);

    expect(await factory(['submit', join(root, 'missing.md')])).toMatchObject({ code: 2, stderr: expect.stringMatching(/no task file/) });
    expect(await factory(['submit'])).toMatchObject({ code: 2 });
    expect(await factory(['launch'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/unknown command "launch"/) });
  });
});

describe('factory status', () => {
  it('says when there is nothing yet, and refuses unknown ids', async () => {
    mkdirSync(home, { recursive: true });
    expect((await factory(['status'])).stdout).toBe('No work items yet.\n');
    expect(await factory(['status', 'wi_nope'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/no work item wi_nope/) });
  });
});

describe('parseTaskFile', () => {
  it('takes the first heading as the title and the rest as the body', () => {
    expect(parseTaskFile('\n# Fix the bug\n\nSteps:\n- one\n', 't.md')).toEqual({ title: 'Fix the bug', body: 'Steps:\n- one' });
  });
  it('needs a heading first', () => {
    expect(() => parseTaskFile('Some text\n# Late heading\n', 't.md')).toThrow(/must start with a "# Title" heading/);
    expect(() => parseTaskFile('no heading at all', 't.md')).toThrow(/heading/);
  });
});

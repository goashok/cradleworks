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

describe('factory log', () => {
  it('replays a run from its event log, by run or by work item', async () => {
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Add a changelog\n\nCreate CHANGELOG.md with a heading.\n');
    const submitted = await factory(['submit', taskFile]);
    const runId = /run\s+(run_\S+)/.exec(submitted.stdout)![1]!;
    const wiId = /as (wi_\S+)/.exec(submitted.stdout)![1]!;

    const byRun = await factory(['log', runId]);
    expect(byRun.code).toBe(0);
    const lines = byRun.stdout.trim().split('\n');
    const steps = lines.map((l) => l.slice(10).split(/\s+/)[0]);
    expect(steps).toEqual(expect.arrayContaining(['checkout', 'sandbox', 'context', 'agent', 'says', 'file', 'commit', 'push', 'pr']));
    expect(byRun.stdout).toContain('Adding a changelog.');
    expect(byRun.stdout).toMatch(/file\s+added CHANGELOG\.md/);
    expect(steps.indexOf('commit')).toBeLessThan(steps.indexOf('pr'));

    const byWorkItem = await factory(['log', wiId]);
    expect(byWorkItem.stdout).toContain(runId);
    expect(byWorkItem.stdout).toContain('Adding a changelog.');

    const json = await factory(['log', runId, '--json']);
    const events = json.stdout.trim().split('\n').map((l) => JSON.parse(l) as { streamId: string; seq: number });
    expect(events.every((e) => e.streamId === runId)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    expect(await factory(['log', 'run_nope'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/no events for run_nope/) });
    expect(await factory(['log'])).toMatchObject({ code: 2 });
  });
});

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

describe('factory validate', () => {
  it('checks a project without running anything', async () => {
    const r = await factory(['validate']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('project demo, 1 rule file(s), image unused');
    expect(r.stdout).toMatch(/ok\n$/);
  });

  it('reports rules that match nothing, missing include paths and unknown adapters', async () => {
    writeFileSync(
      join(checkout, '.factory/factory.yaml'),
      FACTORY_YAML.replace('sandbox: process', 'sandbox: podman') + 'context: { include: [src/, nope/], rules: [.factory/rules/*.txt] }\n',
    );
    const r = await factory(['validate', join(checkout, 'src')], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown sandbox adapter "podman"');
    expect(r.stderr).toContain('context.rules: .factory/rules/*.txt matches no files');
    expect(r.stderr).toContain('context.include: nope/ does not exist');
    expect(r.stderr).not.toContain('src/');
  });

  it('names a planned adapter without failing', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), FACTORY_YAML.replace('ci: none', 'ci: github-actions'));
    const r = await factory(['validate']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"github-actions" is not built yet');
  });

  it('shows config errors with line numbers', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), FACTORY_YAML + 'concurrency: 0\n');
    const r = await factory(['validate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(".factory/factory.yaml:5:14  concurrency must be at least 1 (got 0)");
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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareRepo, FakeTracker, git, ScriptedAgentRuntime, type ScriptStep } from '@cradleworks/contracts/fakes';
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
let bare: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-cli-'));
  home = join(root, 'home');
  bare = join(root, 'remote.git');
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
      scripted: () => {
        let builds = 0;
        return new ScriptedAgentRuntime((req) =>
          req.profile.role === 'reviewer'
            ? [{ kind: 'message', text: 'Fine.\n{"verdict":"pass","risk":"low","reasons":[]}' }]
            : [
                { kind: 'message', text: 'Adding a changelog.' },
                { kind: 'write', path: 'CHANGELOG.md', content: `# Changelog ${++builds} ${Math.random()}\n` },
              ],
        );
      },
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
    expect(list.stdout).toMatch(/wi_\S+\s+awaiting_change_approval\s+0\/1\s+demo\s+Add a changelog/);
    expect(result.stdout).toMatch(/Passed: checks passed, CI not configured, reviewer passed \(low risk\)/);
    expect(result.stdout).toMatch(/approve with {2}factory approve task_\S+/);

    const id = /(wi_\S+)/.exec(list.stdout.split('\n')[1]!)![1]!;
    const detail = await factory(['status', id]);
    expect(detail.stdout).toContain('ready  Add a changelog');
    expect(detail.stdout).toMatch(/verify {2}pass at [0-9a-f]{12}/);
    expect(detail.stdout).toContain('checks: build ✓, test ✓   CI: not configured   reviewer: pass (low risk)');
    expect(detail.stdout).toMatch(/pr\s+file:\/\/.*#pull-1/);
    expect(detail.stdout).toMatch(/spec_approval\s+approved \(skipped\) by /);
  });

  it('escalates with exit code 1 when the agent changes nothing', async () => {
    const reg = registry();
    reg.runtime.scripted = () => new ScriptedAgentRuntime(() => [{ kind: 'message', text: 'No changes needed.' }]);
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Do nothing\n');
    const result = await factory(['submit', taskFile], checkout, reg);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/The agent changed nothing and said why:\n {2}No changes needed\./);
    expect(result.stdout).toMatch(/try again {3}factory retry task_\S+/);
  });

  it('approves and merges, rejects into rework, and builds only on request', async () => {
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Add a changelog\n');
    const first = await factory(['submit', taskFile]);
    const taskId = /factory approve (task_\S+)/.exec(first.stdout)![1]!;

    const rejected = await factory(['reject', taskId, '--reason', 'Say what changed.']);
    expect(rejected.code).toBe(0);
    expect(rejected.stdout).toMatch(/Sent task_\S+ back for rework\nPushed rework 1 to file:/);
    expect(rejected.stdout).toContain('Ready for review');

    expect(await factory(['approve', taskId])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Approved task_/) });
    const merged = await factory(['approve', taskId, '--merge']);
    expect(merged.code).toBe(0);
    expect(merged.stdout).toMatch(/merged [0-9a-f]{12}/);
    const list = await factory(['status']);
    expect(list.stdout).toMatch(/merged\s+1\/1/);

    expect(await factory(['approve', 'task_nope'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/no task or work item task_nope/) });
    const buildOnly = await factory(['submit', taskFile, '--build-only']);
    expect(buildOnly.code).toBe(0);
    expect(buildOnly.stdout).not.toContain('Passed:');
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

describe('factory budget', () => {
  it('shows what a requester spent against the caps, and refuses to extend a task that is not paused', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), `${FACTORY_YAML}budgets: { per_user_daily_usd: 20 }\n`);
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Add a changelog\n');
    const submitted = await factory(['submit', taskFile]);
    const taskId = /factory approve (task_\S+)/.exec(submitted.stdout)![1]!;

    const shown = await factory(['budget']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/^tester\n {2}today \(\d{4}-\d{2}-\d{2}\) +\$0\.00 of \$20\.00\n {2}month \(\d{4}-\d{2}\) +\$0\.00 {2}\(no cap\)\n {2}per task +\$5\.00 over all attempts\n$/);
    expect(await factory(['budget', 'extend', taskId, '--usd', '2'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/is ready, not paused for budget/) });
    expect(await factory(['budget', 'extend', '--user', 'tester', '--usd', '5'])).toMatchObject({ code: 0, stdout: expect.stringContaining("Raised tester's daily cap by $5.00") });
    expect((await factory(['budget'])).stdout).toContain('$0.00 of $25.00 ($20.00 + $5.00 granted)');
    expect(await factory(['budget', 'extend', '--user', 'tester'])).toMatchObject({ code: 2 });
  });
});

describe('factory validate', () => {
  it('checks a project without running anything', async () => {
    const r = await factory(['validate']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('project demo, 1 rule file(s), 0 prompt addition(s), 0 skill(s), image unused');
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

  it('checks that the tracker suits the source control', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), FACTORY_YAML.replace('tracker: none', 'tracker: github-issues').replace('ci: none', 'ci: github-actions'));
    const r = await factory(['validate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('tracker "github-issues" does not track local-git repositories');
    expect(r.stdout).toContain('ci "github-actions" does not build local-git repositories');
    writeFileSync(join(checkout, '.factory/factory.yaml'), FACTORY_YAML);
    expect((await factory(['validate'])).stdout).toContain('no tracker: submit works, factory watch does not');
  });

  it('checks prompt additions are named for a role', async () => {
    mkdirSync(join(checkout, '.factory/prompts'), { recursive: true });
    writeFileSync(join(checkout, '.factory/prompts/reviewer.md'), 'Check migrations are reversible.\n');
    writeFileSync(join(checkout, '.factory/prompts/tester.md'), '\n');
    const ok = await factory(['validate']);
    expect(ok).toMatchObject({ code: 0, stderr: '' });
    expect(ok.stdout).toContain('2 prompt addition(s)');
    expect(ok.stdout).toContain('.factory/prompts/tester.md is empty');
    writeFileSync(join(checkout, '.factory/prompts/reveiwer.md'), 'Typo.\n');
    const bad = await factory(['validate']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('.factory/prompts/reveiwer.md: "reveiwer" is not a role');
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

describe('factory config get', () => {
  it("prints the project's value, or the default, and nothing else", async () => {
    expect(await factory(['config', 'get', 'adapters.scm'])).toMatchObject({ code: 0, stdout: 'local-git\n' });
    expect(await factory(['config', 'get', 'gates.change_approval'])).toMatchObject({ code: 0, stdout: 'human\n' });
    expect(await factory(['config', 'get', 'gates.nope'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/not a factory.yaml key/) });
  });
});

describe('factory watch', () => {
  const WATCH_YAML = FACTORY_YAML.replace('tracker: none', 'tracker: fake') + 'gates: { spec_approval: human, plan_check: ai, change_approval: ai, auto_merge: true }\n';
  const json = (v: unknown): ScriptStep => ({ kind: 'message', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });

  function watchRegistry(tracker: FakeTracker): Registry {
    const base = registry();
    return {
      ...base,
      tracker: { fake: { create: () => tracker, scm: ['local-git'] } },
      runtime: {
        scripted: () =>
          new ScriptedAgentRuntime((req) => {
            switch (req.profile.role) {
              case 'specifier':
                return [json({ title: 'Add a changelog', problem: 'No changelog.', acceptance_criteria: ['CHANGELOG.md exists'], out_of_scope: [], assumptions: [] })];
              case 'planner':
                return [json({ tasks: [{ key: 't1', title: 'Write the changelog', description: 'Create CHANGELOG.md.', size: 'small', depends_on: [], criteria: [1] }] })];
              case 'tester':
                return [{ kind: 'message', text: 'Done.' }, { kind: 'write', path: 'changelog.acceptance.sh', content: 'test -f CHANGELOG.md\n' }];
              case 'reviewer':
                return [req.input.startsWith('# Spec check') || req.input.startsWith('# Plan check') ? json({ verdict: 'approved', reasons: [] }) : json({ verdict: 'pass', risk: 'low', reasons: [] })];
              default:
                return [{ kind: 'message', text: 'Added it.' }, { kind: 'write', path: 'CHANGELOG.md', content: '# Changelog\n' }];
            }
          }),
      },
    };
  }

  it('takes an issue through the spec gate to a merged pull request', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), WATCH_YAML);
    const tracker = new FakeTracker();
    const reg = watchRegistry(tracker);
    const issue = tracker.addItem({ project: bare, title: 'Add a changelog', body: 'We need a changelog.', author: 'alex', labels: ['factory'] });
    tracker.addItem({ project: bare, title: 'Not for the factory', body: '', author: 'alex' });

    const first = await factory(['watch', '--once'], checkout, reg);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/#1 picked up as wi_\S+/);
    expect(first.stdout).toContain('#1 spec v1: Add a changelog (1 acceptance criteria)');
    expect(first.stdout).toContain('#1 awaiting_spec_approval, waiting for spec approval');
    expect(first.stdout).not.toContain('#2');
    const wiId = /picked up as (wi_\S+)/.exec(first.stdout)![1]!;

    const detail = await factory(['status', wiId], checkout, reg);
    expect(detail.stdout).toContain(`issue      ${issue.url}`);
    expect(detail.stdout).toMatch(/Spec\n {2}spec_\S+ version 1, not approved yet/);
    expect(detail.stdout).toMatch(/ specify {2}succeeded {2}\S+ {2}scripted\/none\n/);

    expect(await factory(['approve', wiId], checkout, reg)).toMatchObject({ code: 0, stdout: expect.stringContaining('Approved the spec v1 of') });
    expect(tracker.factoryComments(issue).at(-1)).toContain('**Spec approved** by');

    const second = await factory(['watch', '--once'], checkout, reg);
    expect(second.stdout).toContain('#1 plan_check approved (ai)');
    expect(second.stdout).toMatch(/#1 \[Write the changelog\] merged/);
    expect(second.stdout).toContain('#1 merged');
    expect((await git(['--git-dir', bare, 'show', 'main:CHANGELOG.md'])).stdout).toBe('# Changelog\n');
    expect((await git(['--git-dir', bare, 'show', 'main:.factory/specs/issue-1-add-a-changelog.md'])).stdout).toContain('Approved by');

    // A third pass has nothing to do.
    const third = await factory(['watch', '--once'], checkout, reg);
    expect(third.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('cancels the work when the issue is closed', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), WATCH_YAML);
    const tracker = new FakeTracker();
    const reg = watchRegistry(tracker);
    const issue = tracker.addItem({ project: bare, title: 'Add a changelog', body: 'Please.', author: 'alex', labels: ['factory'] });
    await factory(['watch', '--once'], checkout, reg);
    tracker.close(issue);
    expect((await factory(['watch', '--once'], checkout, reg)).stdout).toContain('#1 cancelled: the issue was closed');
  });

  it('needs a tracker, and refuses a second watch', async () => {
    expect(await factory(['watch', '--once'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/factory watch needs a tracker/) });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'watch.pid'), `${process.ppid}\n`);
    writeFileSync(join(checkout, '.factory/factory.yaml'), WATCH_YAML);
    expect(await factory(['watch', '--once'], checkout, watchRegistry(new FakeTracker()))).toMatchObject({ code: 2, stderr: expect.stringMatching(/another factory watch is running/) });
  });
});

describe('factory skills', () => {
  const SKILL = (d: string) => `---\nname: migrations\ndescription: ${d}\n---\nCheck down() undoes up().\n`;
  const withRole = FACTORY_YAML + 'runtime: { agent: scripted, model: none, roles: { reviewer: { skills: [migrations] } } }\n';

  it('vendors a skill from a folder, pins it, and validate keeps it honest', async () => {
    const src = join(root, 'my-skill');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), SKILL('Rollback checks'));
    writeFileSync(join(src, 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n');
    writeFileSync(join(checkout, '.factory/factory.yaml'), withRole.replace('runtime: { agent: scripted, model: none }\n', ''));

    const added = await factory(['skills', 'add', src]);
    expect(added).toMatchObject({ code: 0, stderr: '' });
    expect(added.stdout).toContain('Check down() undoes up().');
    expect(added.stdout).toContain('1 script(s) an agent may run inside the sandbox: scripts/check.sh');
    expect(existsSync(join(checkout, '.factory/skills/migrations/scripts/check.sh'))).toBe(true);
    expect(JSON.parse(readFileSync(join(checkout, '.factory/skills.lock'), 'utf8')).migrations).toMatchObject({ source: 'local', hash: expect.stringMatching(/^sha256:/) });
    expect((await factory(['skills', 'list'])).stdout).toBe('migrations  locked, from your own; used by reviewer\n');
    expect(await factory(['validate'])).toMatchObject({ code: 0, stdout: expect.stringContaining('1 skill(s)') });
    expect((await factory(['skills', 'add', src])).stderr).toContain('already exists; use factory skills update migrations');

    // A hand edit fails validation until it is locked as the team's own.
    writeFileSync(join(checkout, '.factory/skills/migrations/SKILL.md'), SKILL('Rollback checks, edited'));
    const edited = await factory(['validate']);
    expect(edited.code).toBe(2);
    expect(edited.stderr).toContain("doesn't match .factory/skills.lock");
    expect(await factory(['skills', 'lock', 'migrations'])).toMatchObject({ code: 0 });
    expect((await factory(['validate'])).code).toBe(0);
  });

  it('vendors from a git repository at a ref, records the commit, and updates to a newer one', async () => {
    const upstream = join(root, 'skills.git');
    await createBareRepo(upstream, { 'skills/migrations/SKILL.md': SKILL('v1'), 'README.md': 'many skills\n' });
    const v1 = (await git(['--git-dir', upstream, 'rev-parse', 'main'])).stdout.trim();
    writeFileSync(join(checkout, '.factory/factory.yaml'), withRole.replace('runtime: { agent: scripted, model: none }\n', ''));

    expect(await factory(['skills', 'add', upstream, '--path', 'skills/migrations', '--ref', 'main'])).toMatchObject({ code: 0 });
    const lock = JSON.parse(readFileSync(join(checkout, '.factory/skills.lock'), 'utf8'));
    expect(lock.migrations).toMatchObject({ source: upstream, path: 'skills/migrations', ref: 'main', commit: v1 });
    expect(existsSync(join(checkout, '.factory/skills/migrations/README.md'))).toBe(false);

    // A newer upstream version, then update.
    const work = join(root, 'upstream-work');
    await git(['clone', '--quiet', upstream, work]);
    writeFileSync(join(work, 'skills/migrations/SKILL.md'), SKILL('v2'));
    await git(['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'v2']);
    await git(['-C', work, 'push', '--quiet', 'origin', 'main']);
    const updated = await factory(['skills', 'update', 'migrations']);
    expect(updated).toMatchObject({ code: 0 });
    expect(readFileSync(join(checkout, '.factory/skills/migrations/SKILL.md'), 'utf8')).toContain('description: v2');
    expect((await factory(['validate'])).code).toBe(0);

    // Changing a vendored copy and locking it makes it the team's own, saying where it came from.
    writeFileSync(join(checkout, '.factory/skills/migrations/SKILL.md'), SKILL('ours'));
    expect((await factory(['skills', 'lock', 'migrations'])).stdout).toContain('now your own, forked from');
    expect((await factory(['skills', 'update', 'migrations'])).stderr).toContain('is your own skill');
  });

  it("guesses what a skill needs from its scripts, and validate checks it in the image", async () => {
    const src = join(root, 'web-skill');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), SKILL('Browser checks'));
    writeFileSync(join(src, 'scripts', 'shot.py'), 'from playwright.sync_api import sync_playwright\n');
    writeFileSync(join(checkout, '.factory/factory.yaml'), withRole.replace('runtime: { agent: scripted, model: none }\n', ''));

    const added = await factory(['skills', 'add', src]);
    expect(added.stdout).toContain('it looks like it needs');
    const lock = () => JSON.parse(readFileSync(join(checkout, '.factory/skills.lock'), 'utf8')).migrations;
    expect(lock().requires).toEqual(['python3 --version', expect.stringContaining('chromium.launch()')]);

    // The process sandbox runs on this machine, so the check runs here.
    expect(await factory(['skills', 'require', 'migrations', 'true', 'echo missing-tool >&2; exit 3'])).toMatchObject({ code: 0 });
    const failing = await factory(['validate']);
    expect(failing.code).toBe(2);
    expect(failing.stderr).toContain('skill migrations needs `echo missing-tool >&2; exit 3` to work, and it fails in unused: missing-tool');
    expect(failing.stderr).not.toContain('needs `true`');

    // Hash and requirements are separate: locking a hand edit keeps them.
    writeFileSync(join(checkout, '.factory/skills/migrations/notes.md'), 'ours\n');
    await factory(['skills', 'lock', 'migrations']);
    expect(lock().requires).toEqual(['true', 'echo missing-tool >&2; exit 3']);

    expect((await factory(['skills', 'require', 'migrations'])).stdout).toContain('needs nothing checked');
    expect(lock().requires).toBeUndefined();
    expect((await factory(['validate'])).code).toBe(0);
  });

  it('reports a role naming a missing skill, and a folder without a SKILL.md', async () => {
    writeFileSync(join(checkout, '.factory/factory.yaml'), withRole.replace('runtime: { agent: scripted, model: none }\n', ''));
    mkdirSync(join(checkout, '.factory/skills/empty'), { recursive: true });
    writeFileSync(join(checkout, '.factory/skills/empty/notes.md'), 'x\n');
    const r = await factory(['validate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('the skill "migrations" is given to reviewer, but .factory/skills/migrations/ is missing');
    expect(r.stderr).toContain('.factory/skills/empty: needs a SKILL.md');
    expect(r.stdout).toContain('.factory/skills/empty is vendored but no role uses it');
  });
});

describe('agent checks and factory drill', () => {
  const SEC = '---\nname: sec\ndescription: Security review\n---\nSend back anything unsafe.\n';
  const yaml = FACTORY_YAML + 'verify: { tester: false, agent_checks: { security: { skill: sec, blocks: true } } }\n';
  const patch = (file: string) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+hello\n`;

  // The security check sends back changes titled "unsafe"; the reviewer passes everything.
  function judging(): Registry {
    const base = defaultRegistry();
    return {
      ...base,
      runtime: {
        scripted: () =>
          new ScriptedAgentRuntime((req) => {
            const unsafe = req.rolePrompt.includes('"security" check') && /unsafe/i.test(req.input);
            return [{ kind: 'message', text: unsafe ? '{"verdict":"rework","risk":"high","reasons":["unsafe query"]}' : '{"verdict":"pass","risk":"low","reasons":[]}' }];
          }),
      },
    };
  }

  async function setUp(files: Record<string, string>) {
    mkdirSync(join(checkout, '.factory/skills/sec'), { recursive: true });
    writeFileSync(join(checkout, '.factory/skills/sec/SKILL.md'), SEC);
    writeFileSync(join(checkout, '.factory/factory.yaml'), yaml);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(checkout, path, '..'), { recursive: true });
      writeFileSync(join(checkout, path), content);
    }
    await factory(['skills', 'lock', 'sec']);
    await git(['-C', checkout, 'add', '-A']);
    await git(['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'checks']);
    await git(['-C', checkout, 'push', '--quiet', 'origin', 'HEAD']);
  }

  it('says a blocking check without known-bad cases runs advisory, and refuses a drill folder for no check', async () => {
    await setUp({ '.factory/drill/secuirty/x.patch': patch('x.txt') });
    const r = await factory(['validate']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('verify.agent_checks.security is set to block, but has no known-bad drill cases in .factory/drill/security/, so it runs as advisory');
    expect(r.stderr).toContain('.factory/drill/secuirty/ is not for the reviewer, the controls or an agent check');
  });

  it('drills each check on its known-bad cases and the controls, confirming a pass before calling it a miss', async () => {
    await setUp({
      '.factory/drill/security/raw-sql.patch': patch('raw.txt'),
      '.factory/drill/security/raw-sql.md': '# Add an unsafe query\n\nBuild the query from the request.\n',
      '.factory/drill/controls/readme.patch': patch('readme2.txt'),
      '.factory/drill/controls/readme.md': '# Add a second readme\n',
    });
    expect((await factory(['validate'])).code).toBe(0);
    const ok = await factory(['drill'], checkout, judging());
    expect(ok.stdout).toContain('security on security/raw-sql: right  rework');
    expect(ok.stdout).toContain('security on controls/readme: right  pass');
    expect(ok.stdout).toContain('security: sent back 1 of 1 known-bad, passed 1 of 1 controls');
    expect(ok.code).toBe(0);

    // A case the check can't catch: it passes twice, so the drill flags it, unless it's a known miss.
    writeFileSync(join(checkout, '.factory/drill/security/subtle.patch'), patch('subtle.txt'));
    writeFileSync(join(checkout, '.factory/drill/security/subtle.md'), '# Tidy the query builder\n');
    const missed = await factory(['drill', '--check', 'security'], checkout, judging());
    expect(missed.stdout).toContain('security on security/subtle: WRONG  pass, then pass');
    expect(missed.stdout).toContain('Flagged: security missed security/subtle.');
    expect(missed.code).toBe(1);
    writeFileSync(join(checkout, '.factory/drill/known-misses.txt'), 'security/subtle  needs data-flow analysis\n');
    expect((await factory(['drill', '--check', 'security'], checkout, judging())).code).toBe(0);

    const reviewed = await factory(['review', join(checkout, '.factory/drill/security/raw-sql.patch'), '--title', 'Add an unsafe query', '--check', 'security'], checkout, judging());
    expect(reviewed.code).toBe(1);
    expect(reviewed.stdout).toContain('rework, high risk');
  });
});

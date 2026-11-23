import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareRepo, git, ScriptedAgentRuntime } from '@cradleworks/contracts/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandFor, esc, sameOrigin, startConsole, workItemPage } from './console.ts';
import { defaultRegistry, run, type Registry } from './index.ts';

const FACTORY_YAML = `project: demo
adapters: { scm: local-git, ci: none, tracker: none, sandbox: process, runtime: scripted }
runtime: { agent: scripted, model: none }
stack: { image: unused, build: "true", test: "true" }
`;

let root: string;
let checkout: string;
let home: string;
let server: Server | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-console-'));
  home = join(root, 'home');
  const bare = join(root, 'remote.git');
  await createBareRepo(bare, { 'README.md': '# Demo\n', '.factory/factory.yaml': FACTORY_YAML, 'src/app.txt': 'app\n' });
  checkout = join(root, 'checkout');
  await git(['clone', '--quiet', bare, checkout]);
});
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

const registry = (): Registry => ({
  ...defaultRegistry(),
  runtime: {
    scripted: () =>
      new ScriptedAgentRuntime((req) =>
        req.profile.role === 'reviewer'
          ? [{ kind: 'message', text: 'Fine.\n{"verdict":"pass","risk":"low","reasons":[]}' }]
          : [{ kind: 'message', text: 'Adding a changelog.' }, { kind: 'write', path: 'CHANGELOG.md', content: `# Changelog ${Math.random()}\n` }],
      ),
  },
});

async function factory(args: string[]) {
  let output = '';
  const code = await run(args, { cwd: checkout, env: { CRADLEWORKS_HOME: home, USER: 'tester' }, stdout: (t) => (output += t), stderr: (t) => (output += t), registry: registry() });
  return { code, output };
}

async function open() {
  const started = await startConsole({ home, port: 0, runCommand: factory }, (wi) => `described ${wi.id}`);
  server = started.server;
  return started;
}

describe('factory console', () => {
  it('shows the work, what waits on a person, and a run log, with titles escaped', async () => {
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Add a <b>changelog</b>\n\nCreate CHANGELOG.md.\n');
    const submitted = await factory(['submit', taskFile]);
    const wiId = /as (wi_\S+)/.exec(submitted.output)![1]!;
    const runId = /run\s+(run_\S+)/.exec(submitted.output)![1]!;
    const { url } = await open();

    const list = await (await fetch(url)).text();
    expect(list).toContain('Add a &lt;b&gt;changelog&lt;/b&gt;');
    expect(list).not.toContain('<b>changelog</b>');
    expect(await (await fetch(`${url}waiting`)).text()).toContain(`/wi/${wiId}`);
    expect(list).toContain('<h1>Dashboard</h1>');
    expect(await (await fetch(`${url}work`)).text()).toContain(`/wi/${wiId}`);
    expect(await (await fetch(`${url}work?show=finished`)).text()).not.toContain(`/wi/${wiId}`);
    expect(await (await fetch(`${url}runs`)).text()).toContain(`/run/${runId}`);

    const detail = await (await fetch(`${url}wi/${wiId}`)).text();
    expect(detail).toContain('Approve change');
    expect(detail).toContain(`described ${wiId}`);
    expect(await (await fetch(`${url}run/${runId}`)).text()).toContain('Adding a changelog.');
    expect((await fetch(`${url}wi/wi_nope`)).status).toBe(404);
  });

  it('runs a button as the CLI command, only with its token and from its own page', async () => {
    const taskFile = join(root, 'task.md');
    writeFileSync(taskFile, '# Add a changelog\n\nCreate CHANGELOG.md.\n');
    const submitted = await factory(['submit', taskFile]);
    const wiId = /as (wi_\S+)/.exec(submitted.output)![1]!;
    const { url, token } = await open();
    const taskId = /name="id" value="(task_[^"]+)"/.exec(await (await fetch(`${url}wi/${wiId}`)).text())![1]!;
    const post = (form: Record<string, string>, origin = url.slice(0, -1)) =>
      fetch(`${url}action`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(form) });

    expect((await factory(['status', wiId])).output).toContain(`factory approve ${taskId} [--merge]`);
    expect((await post({ action: 'approve', id: taskId, token: 'wrong' })).status).toBe(403);
    expect((await post({ action: 'approve', id: taskId, token }, 'http://evil.example')).status).toBe(403);
    expect((await post({ action: 'reject', id: taskId, token })).status).toBe(400);

    const done = await post({ action: 'approve', id: taskId, token });
    expect(done.status).toBe(303);
    expect(decodeURIComponent(done.headers.get('location')!)).toContain(`/wi/${wiId}?notice=Done: factory approve ${taskId}`);
    const after = (await factory(['status', wiId])).output;
    expect(after).not.toContain(`factory approve ${taskId} [--merge]`);
    expect(after).toContain('merge on the pull request');
  });
});

describe('console helpers', () => {
  it('puts every choice open on a work item in one panel under its headline', () => {
    const base = { id: 'wi_1', source: { id: 'o/r#1' }, requester: 'sam', projectId: 'demo', title: 'T', maxReworkLoops: 3, proposedTasks: [], spentUsd: 0, gateDecisions: [], runs: [], createdAt: '2026-11-23T10:00:00Z', updatedAt: '2026-11-23T10:00:00Z', version: 1 };
    const task = { id: 'task_1', specId: 's', title: 'Fix dates', dependsOn: [], size: 'small', state: 'failed', reworkLoops: 0, gateReworks: 0, extraLoops: 0, changeApproved: false, spentUsd: 0, lastReason: 'agent failed' };
    const html = workItemPage({ ...base, state: 'in_progress', tasks: [task] } as never, '', 'tok');
    const panel = /<div class="actions panel">.*?<\/div><\/div><\/div>/s.exec(html)?.[0] ?? '';
    expect(panel).toContain('<button class="primary">Retry</button>');
    expect(panel).toContain('<button class="danger">Cancel this work</button>');
    expect(html.match(/name="action" value="retry"/g)).toHaveLength(1);
    const two = workItemPage({ ...base, state: 'in_progress', tasks: [task, { ...task, id: 'task_2', title: 'Fix totals', state: 'escalated' }] } as never, '', 'tok');
    expect(two).toContain('Retry “Fix dates”');
    expect(two).toContain('Retry “Fix totals”');
    const done = workItemPage({ ...base, state: 'cancelled', tasks: [task] } as never, '', 'tok');
    expect(done).not.toContain('<form');
  });

  it('maps only known actions with what they need', () => {
    expect(commandFor({ action: 'retry', id: 'task_1' })).toEqual(['retry', 'task_1', '--no-run']);
    expect(commandFor({ action: 'extend', id: 'task_1', usd: '2.5' })).toEqual(['budget', 'extend', 'task_1', '--usd', '2.5', '--no-run']);
    expect(commandFor({ action: 'cancel', id: 'wi_1' })).toBeUndefined();
    expect(commandFor({ action: 'approve', id: '--merge' })).toBeUndefined();
    expect(commandFor({ action: 'delete', id: 'wi_1' })).toBeUndefined();
  });

  it('accepts a form only from this console', () => {
    const req = (origin: string, host = '127.0.0.1:4747') => ({ headers: { origin, host } });
    expect(sameOrigin(req('http://127.0.0.1:4747'), 4747)).toBe(true);
    expect(sameOrigin(req('http://localhost:4747'), 4747)).toBe(true);
    expect(sameOrigin(req('http://127.0.0.1:4747.evil.example'), 4747)).toBe(false);
    expect(sameOrigin(req('http://127.0.0.1:4747', 'evil.example'), 4747)).toBe(false);
    expect(esc(`"<'&>`)).toBe('&quot;&lt;&#39;&amp;&gt;');
  });
});

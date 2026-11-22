// The issue flow end to end on the fakes: a tracker item becomes a spec (with a question
// round), passes the spec gate, is planned into dependent tasks that run in parallel, is
// verified with the tester's acceptance tests, and merges.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBareRepo,
  FakeTracker,
  git,
  InMemoryStateStore,
  LocalGitSourceControl,
  localRepoRef,
  ProcessSandbox,
  ScriptedAgentRuntime,
  type ScriptStep,
} from '@cradleworks/contracts/fakes';
import type { AgentRunRequest } from '@cradleworks/interfaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/types.ts';
import { checkPlan, commandsAfter, parsePlan, parseSpecAnswer } from './issue-flow.ts';
import { Orchestrator, WorkItemRepository, type Project, type WorkProgress } from './index.ts';

// Tests are the `*acceptance*.sh` scripts plus the checks in `checks/`; each must exit 0.
const TEST = 'for f in $(ls *acceptance*.sh checks/*.sh 2>/dev/null); do sh "$f" || exit 1; done';

const baseConfig: ProjectConfig = {
  project: 'shop',
  adapters: { scm: 'local-git', ci: 'none', tracker: 'fake', sandbox: 'process', runtime: 'scripted' },
  runtime: { agent: 'scripted', model: 'm', roles: {} },
  stack: { image: 'unused', commands: { build: 'test -f README.md', test: TEST } },
  context: { include: ['.'], rules: ['.factory/rules/*.md'] },
  gates: { specApproval: 'human', planCheck: 'ai', changeApproval: 'ai', autoMerge: true },
  budgets: { perTaskUsd: 5, maxReworkLoops: 2 },
  specs: 'repo',
  concurrency: 2,
  verify: { tester: true },
  relatedRepos: [],
  network: { mode: 'none', allow: [] },
};

const SPEC = {
  title: 'Export orders',
  problem: 'Shop owners want their orders as a file.',
  acceptance_criteria: ['An export file exists', 'A summary file exists', 'The README mentions the export'],
  out_of_scope: ['Scheduling'],
  assumptions: ['CSV is fine'],
};
const PLAN = {
  tasks: [
    { key: 't1', title: 'Write export', description: 'Add export.txt and a check for it.', size: 'small', depends_on: [], criteria: [1] },
    { key: 't2', title: 'Write summary', description: 'Add summary.txt.', size: 'small', depends_on: [], criteria: [2] },
    { key: 't3', title: 'Document export', description: 'Add docs.txt.', size: 'small', depends_on: ['t1', 't2'], criteria: [3] },
  ],
};
const json = (v: unknown): ScriptStep => ({ kind: 'message', text: `Here it is.\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });
const write = (path: string, content = `${path}\n`): ScriptStep => ({ kind: 'write', path, content });
const APPROVED = json({ verdict: 'approved', reasons: [] });
const PASS = json({ verdict: 'pass', risk: 'low', reasons: [] });
const FILE: Record<string, string> = { 'Write export': 'export.txt', 'Write summary': 'summary.txt', 'Document export': 'docs.txt' };

let root: string;
let bare: string;
let tracker: FakeTracker;
let project: Project;
let requests: AgentRunRequest[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-issue-'));
  bare = join(root, 'shop.git');
  await createBareRepo(bare, { 'README.md': '# Shop\n', '.factory/rules/style.md': 'Keep it short.\n' });
  tracker = new FakeTracker();
  tracker.allowApprover('sam');
  project = { repo: localRepoRef(bare), config: baseConfig };
  requests = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Role = AgentRunRequest['profile']['role'];
type Scripts = Partial<Record<Role | 'spec_check' | 'plan_check', (req: AgentRunRequest, n: number) => ScriptStep[]>>;

function orchestrator(scripts: Scripts = {}, store = new InMemoryStateStore()) {
  const counts = new Map<string, number>();
  const defaults: Required<Scripts> = {
    specifier: () => [json(SPEC)],
    planner: () => [json(PLAN)],
    spec_check: () => [APPROVED],
    plan_check: () => [APPROVED],
    reviewer: () => [PASS],
    tester: (req) => {
      const file = Object.entries(FILE).find(([title]) => req.input.includes(`# Task: ${title}`))?.[1] ?? 'none.txt';
      return [{ kind: 'message', text: 'Tests written.' }, write(`${file.replace('.txt', '')}.acceptance.sh`, `test -f ${file}\n`)];
    },
    implementer: (req) => {
      const title = /^# (.*)$/m.exec(req.input)?.[1] ?? '';
      return [{ kind: 'message', text: `Did ${title}.` }, write(FILE[title] ?? 'other.txt')];
    },
  };
  const runtime = new ScriptedAgentRuntime((req) => {
    requests.push(req);
    const key: keyof Scripts = req.profile.role === 'reviewer' && req.input.startsWith('# Spec check') ? 'spec_check' : req.profile.role === 'reviewer' && req.input.startsWith('# Plan check') ? 'plan_check' : req.profile.role;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return (scripts[key] ?? defaults[key])(req, n);
  });
  let tick = 0;
  let ids = 0;
  return new Orchestrator({
    store,
    sourceControl: new LocalGitSourceControl(),
    sandbox: new ProcessSandbox(join(root, 'sandboxes')),
    runtime,
    tracker,
    workRoot: join(root, 'work'),
    clock: () => new Date(Date.UTC(2026, 10, 22, 12, 0, 0, tick++)).toISOString(),
    newId: (kind) => `${kind}_${String(++ids).padStart(8, '0')}`,
    ciWait: { appearSeconds: 0, finishSeconds: 1, pollSeconds: 0 },
  });
}

const file = async (repo: string, ref: string, path: string) => (await git(['--git-dir', repo, 'show', `${ref}:${path}`])).stdout;
const issue = (body = 'Please let me export my orders.') => tracker.addItem({ project: 'acme/shop', title: 'Export orders', body, author: 'alex', labels: ['factory'] });
const roles = () => requests.map((r) => (r.profile.role === 'reviewer' && /^# (Spec|Plan) check/.test(r.input) ? `${r.input.startsWith('# Spec') ? 'spec' : 'plan'}_check` : r.profile.role));

describe('issue flow', () => {
  it('goes from an issue to merged pull requests, waiting for the spec approval', async () => {
    const o = orchestrator();
    const ref = issue();
    const { workItemId } = await o.receiveItem(project, ref);
    expect((await o.receiveItem(project, ref)).created).toBe(false);

    const progress: WorkProgress[] = [];
    const first = await o.runWorkItem(project, workItemId, (p) => progress.push(p));
    expect(first).toMatchObject({ state: 'awaiting_spec_approval', waitingFor: expect.stringContaining('/approve') });
    expect(tracker.factoryComments(ref).at(-1)).toContain('## Spec, version 1: Export orders');

    // Only someone with write access decides; a stranger's /approve is ignored.
    tracker.addComment(ref, 'mallory', '/approve');
    expect((await o.runWorkItem(project, workItemId)).state).toBe('awaiting_spec_approval');
    tracker.addComment(ref, 'sam', 'Looks good.\n/approve');

    const done = await o.runWorkItem(project, workItemId, (p) => progress.push(p));
    expect(done.state).toBe('merged');
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.tasks.map((t) => [t.title, t.state])).toEqual([
      ['Write export', 'merged'],
      ['Write summary', 'merged'],
      ['Document export', 'merged'],
    ]);
    expect(wi.gateDecisions.map((d) => [d.gate, d.mode, d.decidedBy])).toEqual([
      ['spec_approval', 'human', 'sam'],
      ['plan_check', 'ai', 'plan checker (m)'],
      ['change_approval', 'ai', 'reviewer (m)'],
      ['change_approval', 'ai', 'reviewer (m)'],
      ['change_approval', 'ai', 'reviewer (m)'],
    ]);

    // Everything is on main: the three files, and the approved spec from the first task.
    for (const f of ['export.txt', 'summary.txt', 'docs.txt']) expect(await file(bare, 'main', f)).toBe(`${f}\n`);
    const spec = await file(bare, 'main', '.factory/specs/issue-1-export-orders.md');
    expect(spec).toContain('Approved by sam');
    expect(spec).toContain('1. An export file exists');

    // The dependent task was built only after both of its dependencies merged.
    const builds = requests.filter((r) => r.profile.role === 'implementer').map((r) => /^# (.*)$/m.exec(r.input)![1]);
    expect(builds.at(-1)).toBe('Document export');
    // Each task had acceptance tests written once and run in Verify.
    expect(roles().filter((r) => r === 'tester')).toHaveLength(3);
    expect(wi.tasks.every((t) => t.evidence?.checks.some((c) => c.name === 'acceptance' && c.outcome === 'passed'))).toBe(true);
    // The implementer saw the spec.
    expect(requests.find((r) => r.profile.role === 'implementer')!.input).toContain('## The spec this task is part of');

    // The issue tells the story: statuses, links to each PR, and a closing note.
    expect(tracker.statusesOf(ref)).toEqual(['received', 'awaiting_spec_approval', 'planning', 'in_progress', 'merged']);
    const links = tracker.linksOf(ref).map((l) => l.title);
    expect(links.slice(0, 2).sort()).toEqual(['Write export', 'Write summary']);
    expect(links[2]).toBe('Document export');
    expect(tracker.factoryComments(ref).at(-1)).toMatch(/^<!-- cradleworks:done:done -->\nDone: 3 pull requests merged/);
    expect(progress.some((p) => p.kind === 'planned' && p.tasks.length === 3)).toBe(true);
  });

  it('asks its questions once, waits for the answer, then writes the spec', async () => {
    const o = orchestrator({ specifier: (_r, n) => (n === 1 ? [json({ questions: ['CSV or JSON?', 'All orders or one month?'] })] : [json(SPEC)]) });
    const ref = issue();
    const { workItemId } = await o.receiveItem(project, ref);
    const asked = await o.runWorkItem(project, workItemId);
    expect(asked).toMatchObject({ state: 'blocked', waitingFor: expect.stringContaining('@alex') });
    expect(tracker.factoryComments(ref).at(-1)).toContain('1. CSV or JSON?');
    expect((await o.runWorkItem(project, workItemId)).state).toBe('blocked');

    tracker.addComment(ref, 'alex', 'CSV, and all orders.');
    expect((await o.runWorkItem(project, workItemId)).state).toBe('awaiting_spec_approval');
    const second = requests.filter((r) => r.profile.role === 'specifier')[1]!;
    expect(second.input).toContain('CSV, and all orders.');
    expect(second.input).toContain('## You already asked');
  });

  it('writes a new version when a person rejects the spec', async () => {
    const o = orchestrator({ specifier: (_r, n) => [json({ ...SPEC, title: `Export orders v${n}` })] });
    const ref = issue();
    const { workItemId } = await o.receiveItem(project, ref);
    await o.runWorkItem(project, workItemId);
    tracker.addComment(ref, 'sam', '/reject Exports must include refunds.');
    const out = await o.runWorkItem(project, workItemId);
    expect(out.state).toBe('awaiting_spec_approval');
    expect(requests.filter((r) => r.profile.role === 'specifier')[1]!.input).toContain('Exports must include refunds. (sam)');
    expect(tracker.factoryComments(ref).at(-1)).toContain('## Spec, version 2: Export orders v2');
    expect((await o.getWorkItem(workItemId))!.spec).toMatchObject({ version: 2, approved: false });
  });

  it('sends a plan that breaks the rules back to the planner once, then accepts the fixed one', async () => {
    const big = { tasks: [{ ...PLAN.tasks[0], size: 'large', criteria: [1, 2] }] };
    const o = orchestrator({ planner: (_r, n) => [json(n === 1 ? big : PLAN)] });
    const skip = { ...project, config: { ...baseConfig, gates: { ...baseConfig.gates, specApproval: 'skipped' as const } } };
    const { workItemId } = await o.receiveItem(skip, issue());
    await o.runWorkItem(skip, workItemId);
    const second = requests.filter((r) => r.profile.role === 'planner')[1]!;
    expect(second.input).toContain('task t1 is large; split it');
    expect(second.input).toContain('no task covers criterion 3');
    expect((await o.getWorkItem(workItemId))!.tasks).toHaveLength(3);
  });

  it('fails a change against the tester\'s acceptance tests and passes the fix', async () => {
    const o = orchestrator({
      planner: () => [json({ tasks: [{ ...PLAN.tasks[0], criteria: [1, 2, 3] }] })],
      implementer: (_r, n) => (n === 1 ? [{ kind: 'message', text: 'Wrote it elsewhere.' }, write('exports/out.txt')] : [{ kind: 'message', text: 'Fixed.' }, write('export.txt')]),
    });
    const skip = { ...project, config: { ...baseConfig, gates: { ...baseConfig.gates, specApproval: 'skipped' as const } } };
    const { workItemId } = await o.receiveItem(skip, issue());
    expect((await o.runWorkItem(skip, workItemId)).state).toBe('merged');
    const task = (await o.getWorkItem(workItemId))!.tasks[0]!;
    expect(task.reworkLoops).toBe(1);
    expect(task.acceptanceTests?.files).toEqual(['export.acceptance.sh']);
    const second = requests.filter((r) => r.profile.role === 'implementer')[1]!;
    expect(second.input).toContain('### Check `acceptance` failed');
    expect(second.input).toContain('### The acceptance tests');
    expect(second.input).toContain('+test -f export.txt');
    expect(roles().filter((r) => r === 'tester')).toHaveLength(1);
  });

  it('gives a task to a related repository', async () => {
    const clientBare = join(root, 'client.git');
    await createBareRepo(clientBare, { 'README.md': '# Client\n' });
    const client: Project = { repo: localRepoRef(clientBare), config: { ...baseConfig, project: 'client' } };
    const withClient = { ...project, config: { ...baseConfig, gates: { ...baseConfig.gates, specApproval: 'skipped' as const } }, related: { client } };
    const o = orchestrator({
      specifier: (req) => {
        expect(req.input).toContain('## Repositories this work can change');
        expect(req.input).toContain('`client`: a related repository the factory can also change');
        return [json(SPEC)];
      },
      planner: (req) => {
        expect(req.input).toContain('`client`: a related repository');
        return [json({ tasks: [{ ...PLAN.tasks[0], criteria: [1, 2] }, { ...PLAN.tasks[1], key: 't2', repo: 'client', criteria: [3] }] })];
      },
    });
    const { workItemId } = await o.receiveItem(withClient, issue());
    expect((await o.runWorkItem(withClient, workItemId)).state).toBe('merged');
    expect(await file(bare, 'main', 'export.txt')).toBe('export.txt\n');
    expect(await file(clientBare, 'main', 'summary.txt')).toBe('summary.txt\n');
  });

  it('builds on the branch the issue names', async () => {
    await git(['--git-dir', bare, 'branch', 'release/2', 'main']);
    const o = orchestrator({ planner: () => [json({ tasks: [{ ...PLAN.tasks[0], criteria: [1, 2, 3] }] })] });
    const skip = { ...project, config: { ...baseConfig, gates: { ...baseConfig.gates, specApproval: 'skipped' as const } } };
    const { workItemId } = await o.receiveItem(skip, issue('Export, please.\n<!-- cradleworks: base=release/2 -->'));
    expect((await o.runWorkItem(skip, workItemId)).state).toBe('merged');
    expect(await file(bare, 'release/2', 'export.txt')).toBe('export.txt\n');
    await expect(file(bare, 'main', 'export.txt')).rejects.toThrow();
  });

  it('builds again after the factory stopped mid-build, replacing what that build pushed', async () => {
    const store = new InMemoryStateStore();
    const o = orchestrator({}, store);
    const { workItemId, taskId } = await o.submitTask({ project, title: 'Write export', body: 'Add export.txt.', requester: 'alex' });
    const branch = `factory/task-${taskId.slice(5)}`;
    // A build that was cut off: started, pushed half its work, and never ended.
    const repo = new WorkItemRepository(store);
    await repo.append((await repo.load(workItemId))!, [
      { type: 'task_started', at: '2026-11-22T11:00:00.000Z', taskId, branch },
      { type: 'run_started', at: '2026-11-22T11:00:00.000Z', runId: 'run_cutoff', subjectId: taskId, station: 'build' },
    ]);
    const half = join(root, 'half');
    await git(['clone', '--quiet', bare, half]);
    await git(['-C', half, 'checkout', '-q', '-b', branch]);
    await git(['-C', half, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-qm', 'half done']);
    await git(['-C', half, 'push', '-q', 'origin', 'HEAD']);

    expect(await o.recoverWorkItem(workItemId)).toEqual(['run_cutoff (build) was cut off', `${taskId} builds again`]);
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.tasks[0]).toMatchObject({ state: 'rework', reworkLoops: 0 });
    expect(wi.runs.find((r) => r.id === 'run_cutoff')).toMatchObject({ outcome: 'stopped' });

    expect((await o.runTask(project, workItemId, taskId)).state).toBe('merged');
    expect(await file(bare, 'main', 'export.txt')).toBe('export.txt\n');
    expect(await o.recoverWorkItem(workItemId)).toEqual([]);
  });
});

describe('usage limits', () => {
  it('escalates a task whose agent hit a usage limit, and builds it on retry', async () => {
    const o = orchestrator({
      implementer: (_r, n) => (n === 1 ? [{ kind: 'fail', error: "You've hit your 5-hour limit · resets 7pm (UTC)" }] : [{ kind: 'message', text: 'Done.' }, write('export.txt')]),
    });
    const { workItemId, taskId } = await o.submitTask({ project, title: 'Write export', body: 'Add export.txt.', requester: 'alex' });
    const first = await o.runTask(project, workItemId, taskId);
    expect(first.state).toBe('escalated');
    expect(first.reason).toMatch(/^paused: the agent hit a usage or credit limit/);
    await o.retryTask(workItemId, taskId, { by: 'alex' });
    expect((await o.runTask(project, workItemId, taskId)).state).toBe('merged');
  });
});

describe('issue flow parsing', () => {
  it('reads specs and questions, and refuses a second round of questions', () => {
    expect(parseSpecAnswer('```json\n{"questions":["a","b","c","d","e","f"]}\n```', true)).toEqual({ kind: 'questions', questions: ['a', 'b', 'c', 'd', 'e'] });
    expect(parseSpecAnswer('{"questions":["a"]}', false).kind).toBe('unreadable');
    expect(parseSpecAnswer(JSON.stringify(SPEC), false)).toMatchObject({ kind: 'spec', spec: { acceptanceCriteria: SPEC.acceptance_criteria, assumptions: ['CSV is fine'] } });
    expect(parseSpecAnswer('{"problem":"x","acceptance_criteria":[]}', true).kind).toBe('unreadable');
  });

  it('checks plans against the rules', () => {
    const plan = parsePlan(JSON.stringify(PLAN))!;
    expect(checkPlan(plan, 3, { main: 'shop', related: [] })).toEqual([]);
    const cyclic = plan.map((t) => (t.key === 't1' ? { ...t, dependsOn: ['t3'] } : t));
    expect(checkPlan(cyclic, 3, { main: 'shop', related: [] })).toContain('the dependencies form a cycle');
    expect(checkPlan([{ ...plan[0]!, repo: 'nope' }], 1, { main: 'shop', related: [] })).toContain('task t1 names repo "nope", which is not offered');
  });

  it('finds gate commands after the factory\'s prompt only', () => {
    const c = (body: string, byFactory = false, who = 'sam') => ({ ref: { id: body, url: '' }, author: { name: who, handle: who }, body, at: '', ...(byFactory ? { byFactory } : {}) });
    const comments = [c('/approve'), c('<!-- cradleworks:spec:2 --> spec v2', true), c('nice'), c('/reject\nAdd refunds.'), c('/approve ship it', false, 'kim')];
    expect(commandsAfter(comments, '<!-- cradleworks:spec:2 -->')).toEqual([
      { kind: 'reject', by: 'sam', reason: 'Add refunds.' },
      { kind: 'approve', by: 'kim', note: 'ship it' },
    ]);
    expect(commandsAfter(comments, '<!-- cradleworks:spec:3 -->')).toEqual([]);
  });
});

// End-to-end tests of submit + Build on the fakes: real git, real files, scripted agent.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBareRepo,
  git,
  InMemoryStateStore,
  LocalGitSourceControl,
  localRepoRef,
  ProcessSandbox,
  ScriptedAgentRuntime,
  type ScriptStep,
} from '@cradleworks/contracts/fakes';
import type { AgentRunRequest, SourceControl } from '@cradleworks/interfaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/types.ts';
import { IllegalTransitionError } from '../domain/errors.ts';
import { Orchestrator, type OrchestratorDeps, type Project } from './index.ts';

const config: ProjectConfig = {
  project: 'demo',
  adapters: { scm: 'local-git', ci: 'none', tracker: 'none', sandbox: 'process', runtime: 'scripted' },
  runtime: { agent: 'scripted', model: 'none', roles: {} },
  stack: { image: 'unused', commands: { build: 'true', test: 'true' } },
  context: { include: ['.'], rules: ['.factory/rules/*.md'] },
  gates: { specApproval: 'human', planCheck: 'ai', changeApproval: 'human', autoMerge: false },
  budgets: { perTaskUsd: 5, maxReworkLoops: 3 },
  specs: 'repo',
  concurrency: 1,
  verify: { tester: true },
  relatedRepos: [],
  network: { mode: 'none', allow: [] },
};

let root: string;
let bare: string;
let store: InMemoryStateStore;
let scm: LocalGitSourceControl;
let sandbox: ProcessSandbox;
let project: Project;
let seenRequests: AgentRunRequest[];
let ids: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-orch-'));
  bare = join(root, 'remote.git');
  await createBareRepo(bare, {
    'README.md': '# Demo\n',
    '.factory/rules/style.md': 'Use two-space indentation.\n',
    '.factory/rules/security.md': 'Never log secrets.\n',
  });
  store = new InMemoryStateStore();
  scm = new LocalGitSourceControl();
  sandbox = new ProcessSandbox(join(root, 'sandboxes'));
  project = { repo: localRepoRef(bare), config };
  seenRequests = [];
  ids = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function orchestrator(steps: ScriptStep[], overrides: Partial<OrchestratorDeps> = {}) {
  const runtime = new ScriptedAgentRuntime((req) => {
    seenRequests.push(req);
    return steps;
  });
  let tick = 0;
  return new Orchestrator({
    store,
    sourceControl: scm,
    sandbox,
    runtime,
    workRoot: join(root, 'work'),
    clock: () => new Date(Date.UTC(2026, 10, 21, 12, 0, tick++)).toISOString(),
    newId: (kind) => `${kind}_${String(++ids).padStart(8, '0')}`,
    ...overrides,
  });
}

const writesHello: ScriptStep[] = [
  { kind: 'message', text: 'Adding the greeting.' },
  { kind: 'usage', inputTokens: 1000, outputTokens: 50, costUsd: 0.01 },
  { kind: 'write', path: 'hello.txt', content: 'hello\n' },
];

async function submit(o: Orchestrator) {
  return o.submitTask({ project, title: 'Add hello.txt', body: 'Create `hello.txt` containing "hello".', requester: 'alex' });
}

describe('submitTask', () => {
  it('records an approved one-task plan with skipped gates', async () => {
    const o = orchestrator([]);
    const { workItemId, taskId } = await submit(o);
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.state).toBe('in_progress');
    expect(wi.tasks).toMatchObject([{ id: taskId, state: 'queued', description: 'Create `hello.txt` containing "hello".' }]);
    expect(wi.gateDecisions.map((g) => [g.gate, g.mode, g.verdict])).toEqual([
      ['spec_approval', 'skipped', 'approved'],
      ['plan_check', 'skipped', 'approved'],
    ]);
    expect(wi.maxReworkLoops).toBe(3);
  });

  it('refuses an empty title', async () => {
    await expect(orchestrator([]).submitTask({ project, title: ' ', body: '', requester: 'alex' })).rejects.toThrow(/title/);
  });
});

describe('Build station', () => {
  it('opens a pull request with the agent work and logs every step', async () => {
    const o = orchestrator(writesHello);
    const { workItemId, taskId } = await submit(o);
    const result = await o.runBuild(project, workItemId, taskId);
    expect(result.outcome).toBe('pr_opened');
    if (result.outcome !== 'pr_opened') return;

    // The work item: task is verifying, with its PR, and the run has ended.
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.tasks[0]).toMatchObject({ state: 'verifying', branch: result.branch, pr: result.pr });
    expect(wi.runs).toMatchObject([{ id: result.runId, station: 'build', outcome: 'succeeded' }]);

    // The run log: every step, in order, with the agent events in between.
    const steps = (await store.readStream(result.runId)).map((e) => e.type);
    expect(steps.filter((t) => t !== 'agent_event')).toEqual([
      'run_context',
      'checkout_cloned',
      'sandbox_created',
      'context_pack_built',
      'agent_started',
      'changes_committed',
      'branch_pushed',
      'pr_opened',
      'sandbox_destroyed',
    ]);
    const agentEvents = (await store.readStream(result.runId)).filter((e) => e.type === 'agent_event').map((e) => (e.payload as { event: { type: string } }).event.type);
    expect(agentEvents).toEqual(['message', 'usage', 'file_change', 'done']);

    // The context pack: the rule files, and the agent was told to read them.
    const pack = (await store.readStream(result.runId)).find((e) => e.type === 'context_pack_built')!.payload as { files: Array<{ path: string }> };
    expect(pack.files.map((f) => f.path)).toEqual(['.factory/rules/security.md', '.factory/rules/style.md']);
    expect(seenRequests[0]!.contextFiles).toEqual(['.factory/rules/security.md', '.factory/rules/style.md']);
    expect(seenRequests[0]!.rolePrompt).toContain('.factory/rules/style.md');
    expect(seenRequests[0]!.input).toContain('Create `hello.txt`');
    expect(seenRequests[0]!.limits).toEqual({ maxWallSeconds: 1800, maxSpendUsd: 5 });

    // The remote: the branch holds the change, and the PR targets main.
    const status = await scm.getPRStatus(result.pr);
    expect(status).toMatchObject({ state: 'open', baseBranch: 'main', mergeable: true });
    const show = await git(['--git-dir', bare, 'show', `refs/heads/${result.branch}:hello.txt`]);
    expect(show.stdout).toBe('hello\n');

    // Nothing left behind locally.
    expect(readdirSync(join(root, 'sandboxes'))).toEqual([]);
    expect(existsSync(join(root, 'work', 'wi-00000001'))).toBe(true);
    expect(readdirSync(join(root, 'work', 'wi-00000001'))).toEqual([]);
  });

  it('escalates with the agent\'s reason when it changes nothing', async () => {
    const o = orchestrator([{ kind: 'message', text: 'Nothing to do.' }]);
    const { workItemId, taskId } = await submit(o);
    const result = await o.runBuild(project, workItemId, taskId);
    expect(result).toMatchObject({ outcome: 'declined', reason: 'Nothing to do.' });
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.tasks[0]).toMatchObject({ state: 'escalated', lastReason: 'Nothing to do.' });
    expect(wi.runs[0]).toMatchObject({ outcome: 'succeeded' });
  });

  it('fails the task when the agent fails, keeping its error', async () => {
    const o = orchestrator([{ kind: 'fail', error: 'model refused' }]);
    const { workItemId, taskId } = await submit(o);
    const result = await o.runBuild(project, workItemId, taskId);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'agent: agent run failed: model refused' });
    expect((await o.getWorkItem(workItemId))!.tasks[0]?.lastReason).toBe('agent: agent run failed: model refused');
  });

  it('records which step broke when an adapter throws, and still cleans up', async () => {
    const failingPush: SourceControl = {
      id: scm.id,
      clone: (...a) => scm.clone(...a),
      createBranch: (...a) => scm.createBranch(...a),
      commit: (...a) => scm.commit(...a),
      push: async () => {
        throw new Error('remote hung up');
      },
      openPR: (...a) => scm.openPR(...a),
      getPRStatus: (...a) => scm.getPRStatus(...a),
      merge: (...a) => scm.merge(...a),
      comment: (...a) => scm.comment(...a),
    };
    const o = orchestrator(writesHello, { sourceControl: failingPush });
    const { workItemId, taskId } = await submit(o);
    const result = await o.runBuild(project, workItemId, taskId);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'push: remote hung up' });
    const steps = (await store.readStream(result.runId)).map((e) => e.type);
    expect(steps.slice(-2)).toEqual(['step_failed', 'sandbox_destroyed']);
    expect(readdirSync(join(root, 'sandboxes'))).toEqual([]);
  });

  it('refuses to build a task that is not queued, before touching anything', async () => {
    const o = orchestrator(writesHello);
    const { workItemId, taskId } = await submit(o);
    await o.runBuild(project, workItemId, taskId);
    await expect(o.runBuild(project, workItemId, taskId)).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(readdirSync(join(root, 'sandboxes'))).toEqual([]);
  });

  it('adds the hosts the agent needs to the sandbox network policy', async () => {
    const withAllow = { ...project, config: { ...config, network: { mode: 'allowlist' as const, allow: ['registry.npmjs.org'] } } };
    const runtime = new ScriptedAgentRuntime(() => writesHello, { hosts: ['api.example.test'] });
    const o = orchestrator([], { runtime });
    const policies = [];
    for (const p of [project, withAllow]) {
      const { workItemId, taskId } = await o.submitTask({ project: p, title: 'Add hello.txt', body: '', requester: 'alex' });
      const { runId } = await o.runBuild(p, workItemId, taskId);
      policies.push((await store.readStream(runId)).find((e) => e.type === 'sandbox_created')!.payload);
    }
    expect(policies).toMatchObject([
      { network: { mode: 'allowlist', allow: ['api.example.test'] } },
      { network: { mode: 'allowlist', allow: ['registry.npmjs.org', 'api.example.test'] } },
    ]);
  });

  it('rebuilds the same state from the log after a restart', async () => {
    const o = orchestrator(writesHello);
    const { workItemId, taskId } = await submit(o);
    await o.runBuild(project, workItemId, taskId);
    const before = await o.getWorkItem(workItemId);
    const fresh = orchestrator([]);
    expect(await fresh.getWorkItem(workItemId)).toEqual(before);
  });
});

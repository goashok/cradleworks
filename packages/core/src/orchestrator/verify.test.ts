// End-to-end tests of Verify, the rework loop and the change gate on the fakes: real git,
// real files, commands run as processes, scripted implementer and reviewer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBareRepo,
  FakeCI,
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
import { Orchestrator, type OrchestratorDeps, type Progress, type Project } from './index.ts';
import { combine, parseReview } from './verify.ts';

const baseConfig: ProjectConfig = {
  project: 'demo',
  adapters: { scm: 'local-git', ci: 'none', tracker: 'none', sandbox: 'process', runtime: 'scripted' },
  runtime: { agent: 'scripted', model: 'impl-model', roles: { reviewer: { model: 'review-model' } } },
  // The task is done when fixed.txt exists; the build only needs a file to exist.
  stack: { image: 'unused', commands: { build: 'test -f README.md', test: 'test -f fixed.txt' } },
  context: { include: ['.'], rules: ['.factory/rules/*.md'] },
  gates: { specApproval: 'human', planCheck: 'ai', changeApproval: 'human', autoMerge: false },
  budgets: { perTaskUsd: 5, maxReworkLoops: 2 },
  specs: 'repo',
  concurrency: 1,
  network: { mode: 'none', allow: [] },
};

const PASS = '{"verdict": "pass", "risk": "low", "reasons": []}';
const write = (path: string): ScriptStep => ({ kind: 'write', path, content: `${path}\n` });
const say = (text: string): ScriptStep => ({ kind: 'message', text });

let root: string;
let bare: string;
let store: InMemoryStateStore;
let scm: LocalGitSourceControl;
let project: Project;
let requests: AgentRunRequest[];
let ids: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-verify-'));
  bare = join(root, 'remote.git');
  await createBareRepo(bare, { 'README.md': '# Demo\n', '.factory/rules/style.md': 'Keep it short.\n' });
  store = new InMemoryStateStore();
  scm = new LocalGitSourceControl();
  project = { repo: localRepoRef(bare), config: baseConfig };
  requests = [];
  ids = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Scripts {
  implement: (req: AgentRunRequest, attempt: number) => ScriptStep[];
  review?: (req: AgentRunRequest, attempt: number) => ScriptStep[];
}

function orchestrator(scripts: Scripts, overrides: Partial<OrchestratorDeps> = {}) {
  let builds = 0;
  let reviews = 0;
  const runtime = new ScriptedAgentRuntime((req) => {
    requests.push(req);
    if (req.profile.role === 'reviewer') return (scripts.review ?? (() => [say(`Looks right.\n${PASS}`)]))(req, ++reviews);
    return scripts.implement(req, ++builds);
  });
  let tick = 0;
  return new Orchestrator({
    store,
    sourceControl: scm,
    sandbox: new ProcessSandbox(join(root, 'sandboxes')),
    runtime,
    workRoot: join(root, 'work'),
    clock: () => new Date(Date.UTC(2026, 10, 22, 12, 0, tick++)).toISOString(),
    newId: (kind) => `${kind}_${String(++ids).padStart(8, '0')}`,
    ciWait: { appearSeconds: 0, finishSeconds: 1, pollSeconds: 0 },
    ...overrides,
  });
}

async function start(o: Orchestrator, p: Project = project) {
  return o.submitTask({ project: p, title: 'Add fixed.txt', body: 'Create `fixed.txt`.', requester: 'alex' });
}

function withConfig(change: Partial<ProjectConfig>): Project {
  return { ...project, config: { ...baseConfig, ...change } };
}

describe('Verify station', () => {
  it('passes a correct change, records evidence, posts it and waits at the human gate', async () => {
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o);
    const progress: Progress[] = [];
    const out = await o.runTask(project, workItemId, taskId, (p) => progress.push(p));

    expect(out).toMatchObject({ state: 'ready', awaitingApproval: true });
    expect(progress.map((p) => p.kind)).toEqual(['built', 'verified', 'gate']);
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.state).toBe('awaiting_change_approval');
    const ev = wi.tasks[0]!.evidence!;
    expect(ev.verdict).toBe('pass');
    expect(ev.checks.map((c) => [c.name, c.outcome])).toEqual([
      ['build', 'passed'],
      ['test', 'passed'],
    ]);
    expect(ev.review).toMatchObject({ verdict: 'pass', risk: 'low', model: 'review-model' });
    expect(ev.ci.state).toBe('not_configured');
    // The verified commit is the branch head, and the evidence is on the PR.
    const head = (await git(['--git-dir', bare, 'rev-parse', `refs/heads/${wi.tasks[0]!.branch}`])).stdout.trim();
    expect(ev.sha).toBe(head);
    const comments = scm.commentsOn(wi.tasks[0]!.pr!);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('Cradleworks verification: ✅ Passed');
    // The reviewer may not edit and sees the check results.
    const reviewer = requests.find((r) => r.profile.role === 'reviewer')!;
    expect(reviewer.tools.deny).toContain('Edit');
    expect(reviewer.input).toContain('`test` (`test -f fixed.txt`): passed');
    expect(wi.runs.map((r) => [r.station, r.outcome])).toEqual([
      ['build', 'succeeded'],
      ['verify', 'succeeded'],
    ]);
  });

  it('sends a failing change back with the check output, then passes the fix on the same PR', async () => {
    const o = orchestrator({ implement: (_req, n) => (n === 1 ? [say('First go.'), write('wrong.txt')] : [say('Fixed.'), write('fixed.txt')]) });
    const { workItemId, taskId } = await start(o);
    const progress: Progress[] = [];
    const out = await o.runTask(project, workItemId, taskId, (p) => progress.push(p));

    expect(out.state).toBe('ready');
    expect(progress.map((p) => (p.kind === 'verified' ? `verified:${p.outcome.verdict}` : p.kind))).toEqual(['built', 'verified:rework', 'built', 'verified:pass', 'gate']);
    const second = requests.filter((r) => r.profile.role === 'implementer')[1]!;
    expect(second.input).toContain('## Rework (attempt 2)');
    expect(second.input).toContain('### Check `test` failed (exit 1)');
    // Only one reviewer run: a failing check skips the review.
    expect(requests.filter((r) => r.profile.role === 'reviewer')).toHaveLength(1);

    const wi = (await o.getWorkItem(workItemId))!;
    const task = wi.tasks[0]!;
    expect(task.reworkLoops).toBe(1);
    // Every run clones into a folder of its own (Docker Desktop can't remount a recreated one).
    const clonedAt: string[] = [];
    for (const run of wi.runs) for (const e of await store.readStream(run.id)) if (e.type === 'checkout_cloned') clonedAt.push((e.payload as { path: string }).path);
    expect(clonedAt).toHaveLength(4);
    expect(new Set(clonedAt).size).toBe(4);
    const log = (await git(['--git-dir', bare, 'log', '--format=%s', `refs/heads/${task.branch}`])).stdout;
    expect(log.trim().split('\n').slice(0, 2)).toEqual(['Add fixed.txt (rework 1)', 'Add fixed.txt']);
    expect(scm.commentsOn(task.pr!).map((c) => c.split('\n')[0])).toEqual([
      '## Cradleworks verification: 🔁 Sent back for rework',
      '## Cradleworks verification: ✅ Passed',
    ]);
  });

  it('escalates after max_rework_loops', async () => {
    const o = orchestrator({ implement: (_r, n) => [say(`Try ${n}.`), write(`wrong-${n}.txt`)] });
    const { workItemId, taskId } = await start(o);
    const out = await o.runTask(project, workItemId, taskId);
    expect(out.state).toBe('escalated');
    expect(requests.filter((r) => r.profile.role === 'implementer')).toHaveLength(3); // first try + 2 reworks
  });

  it('treats a test that fails once and then passes as flaky, not as a failure', async () => {
    const flaky = withConfig({ stack: { image: 'unused', commands: { build: 'true', test: 'if [ -f .ran ]; then exit 0; else touch .ran; exit 1; fi' } } });
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o, flaky);
    const out = await o.runTask(flaky, workItemId, taskId);
    expect(out.state).toBe('ready');
    expect(out.evidence!.checks.find((c) => c.name === 'test')).toMatchObject({ outcome: 'passed', flaky: true });
  });

  it('skips the other checks when the build fails', async () => {
    const broken = withConfig({ stack: { image: 'unused', commands: { build: 'exit 3', lint: 'true', test: 'true' } } });
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o, broken);
    await o.runBuild(broken, workItemId, taskId);
    const v = await o.runVerify(broken, workItemId, taskId);
    expect(v.verdict).toBe('rework');
    expect(v.evidence!.checks.map((c) => [c.name, c.outcome])).toEqual([
      ['build', 'failed'],
      ['lint', 'skipped'],
      ['test', 'skipped'],
    ]);
  });

  it('follows the reviewer: rework with its reasons, then pass', async () => {
    const o = orchestrator({
      implement: (_r, n) => [say('Done.'), write('fixed.txt'), write(`v${n}.txt`)],
      review: (_r, n) => [say(n === 1 ? '```json\n{"verdict":"rework","risk":"medium","reasons":["fixed.txt has no test"]}\n```' : PASS)],
    });
    const { workItemId, taskId } = await start(o);
    const out = await o.runTask(project, workItemId, taskId);
    expect(out.state).toBe('ready');
    expect(requests.filter((r) => r.profile.role === 'implementer')[1]!.input).toContain('- fixed.txt has no test');
  });

  it('escalates when the reviewer output cannot be read, or it passes a high-risk change', async () => {
    for (const text of ['I think it is fine.', '{"verdict":"pass","risk":"high","reasons":[]}']) {
      const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')], review: () => [say(text)] });
      const { workItemId, taskId } = await start(o);
      expect((await o.runTask(project, workItemId, taskId)).state).toBe('escalated');
    }
  });

  it('waits for CI on the pushed commit and sends a failure back with the job log', async () => {
    const ci = new FakeCI();
    let pushes = 0;
    const seen = new Set<string>();
    ci.onFind = (repo, sha) => {
      if (seen.has(sha)) return;
      seen.add(sha);
      pushes++;
      ci.addRun(repo, sha, pushes === 1 ? { state: 'failed', jobs: [{ name: 'e2e', failed: true, log: 'boot\nE2E: checkout page broken' }] } : { state: 'passed', pendingPolls: 1 });
    };
    // The second build has to change something: write a new file each time.
    const o2 = orchestrator({ implement: (_r, n) => [say('Done.'), write('fixed.txt'), write(`note-${n}.txt`)] }, { ci });
    const { workItemId, taskId } = await start(o2);
    const progress: Progress[] = [];
    const out = await o2.runTask(project, workItemId, taskId, (p) => progress.push(p));
    expect(out.state).toBe('ready');
    const verdicts = progress.flatMap((p) => (p.kind === 'verified' ? [p.outcome] : []));
    expect(verdicts.map((v) => v.verdict)).toEqual(['rework', 'pass']);
    expect(verdicts[0]!.evidence!.ci.failureLogs).toContain('E2E: checkout page broken');
    expect(requests.filter((r) => r.profile.role === 'implementer')[1]!.input).toContain('### CI failed');
    expect(out.evidence!.ci.state).toBe('passed');
  });

  it('passes with a note when the project has CI but no run starts for the commit', async () => {
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] }, { ci: new FakeCI() });
    const { workItemId, taskId } = await start(o);
    const out = await o.runTask(project, workItemId, taskId);
    expect(out.state).toBe('ready');
    expect(out.evidence!.ci).toMatchObject({ state: 'none' });
  });

  it('escalates when verify itself cannot run', async () => {
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o);
    await o.runBuild(project, workItemId, taskId);
    const gone = { ...project, config: { ...baseConfig } };
    // Remove the branch so the verify sandbox has nothing to check out.
    const wi = (await o.getWorkItem(workItemId))!;
    await git(['--git-dir', bare, 'update-ref', '-d', `refs/heads/${wi.tasks[0]!.branch}`]);
    const v = await o.runVerify(gone, workItemId, taskId);
    expect(v.verdict).toBe('escalate');
    expect(v.reason).toMatch(/^verify could not run \(sandbox\)/);
  });
});

describe('change gate', () => {
  it('approves with ai and merges with auto_merge', async () => {
    const auto = withConfig({ gates: { ...baseConfig.gates, changeApproval: 'ai', autoMerge: true } });
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o, auto);
    const out = await o.runTask(auto, workItemId, taskId);
    expect(out.state).toBe('merged');
    const wi = (await o.getWorkItem(workItemId))!;
    expect(wi.state).toBe('merged');
    expect(wi.gateDecisions.at(-1)).toMatchObject({ gate: 'change_approval', mode: 'ai', decidedBy: 'reviewer (review-model)' });
    expect((await git(['--git-dir', bare, 'show', 'refs/heads/main:fixed.txt'])).stdout).toBe('fixed.txt\n');
  });

  it('records skip and stops before merging without auto_merge', async () => {
    const skip = withConfig({ gates: { ...baseConfig.gates, changeApproval: 'skipped' } });
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o, skip);
    const out = await o.runTask(skip, workItemId, taskId);
    expect(out).toMatchObject({ state: 'ready', awaitingApproval: false });
    expect((await o.getWorkItem(workItemId))!.gateDecisions.at(-1)).toMatchObject({ mode: 'skipped', verdict: 'approved' });
  });

  it('lets a person approve and merge, and refuses to merge a head that moved', async () => {
    const o = orchestrator({ implement: (_r, n) => [say('Done.'), write('fixed.txt'), write(`task-${n}.txt`)] });
    const a = await start(o);
    await o.runTask(project, a.workItemId, a.taskId);
    const merged = await o.approveTask(project, a.workItemId, a.taskId, { by: 'sam', merge: true });
    expect(merged.merged).toMatch(/^[0-9a-f]{40}$/);
    expect((await o.getWorkItem(a.workItemId))!.gateDecisions.at(-1)).toMatchObject({ mode: 'human', decidedBy: 'sam', verdict: 'approved' });

    // A second task whose branch gets a commit after Verify passed it.
    const b = await o.submitTask({ project, title: 'Add other.txt', body: '', requester: 'alex' });
    await o.runTask(project, b.workItemId, b.taskId);
    const branch = (await o.getWorkItem(b.workItemId))!.tasks[0]!.branch!;
    const clone = join(root, 'late');
    await git(['clone', '--quiet', '--branch', branch, bare, clone]);
    await git(['-C', clone, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-qm', 'late push']);
    await git(['-C', clone, 'push', '--quiet', 'origin', branch]);
    await expect(o.approveTask(project, b.workItemId, b.taskId, { by: 'sam', merge: true })).rejects.toThrow(/head moved since it was verified/);
  });

  it('sends a rejected change back with the reason as feedback', async () => {
    const o = orchestrator({ implement: (_r, n) => [say('Done.'), write('fixed.txt'), write(`v${n}.txt`)] });
    const { workItemId, taskId } = await start(o);
    await o.runTask(project, workItemId, taskId);
    await o.rejectTask(workItemId, taskId, { by: 'sam', reason: 'Name the file FIXED.txt.' });
    const out = await o.runTask(project, workItemId, taskId);
    expect(out.state).toBe('ready');
    const second = requests.filter((r) => r.profile.role === 'implementer')[1]!;
    expect(second.input).toContain('Name the file FIXED.txt.');
  });

  it('syncs an approving review, and a merge done on the pull request', async () => {
    const o = orchestrator({ implement: () => [say('Done.'), write('fixed.txt')] });
    const { workItemId, taskId } = await start(o);
    await o.runTask(project, workItemId, taskId);
    const pr = (await o.getWorkItem(workItemId))!.tasks[0]!.pr!;
    scm.addReview(pr, { author: { name: 'Sam', handle: 'sam' }, verdict: 'approved', body: 'LGTM', at: '2026-11-22T13:00:00.000Z' });
    expect(await o.syncWorkItem(project, workItemId)).toEqual([`${taskId}: approved by sam`]);
    const head = (await scm.getPRStatus(pr)).headSha;
    await scm.merge(pr, { method: 'merge', expectedHeadSha: head });
    expect(await o.syncWorkItem(project, workItemId)).toEqual([`${taskId}: merged on the pull request`]);
    expect((await o.getWorkItem(workItemId))!.state).toBe('merged');
  });
});

describe('declining and retrying', () => {
  it('escalates when the implementer changes nothing, and builds after a retry', async () => {
    const o = orchestrator({ implement: (_r, n) => (n === 1 ? [say('No change needed: the code is already minimal.')] : [say('Done.'), write('fixed.txt')]) });
    const { workItemId, taskId } = await start(o);
    const first = await o.runTask(project, workItemId, taskId);
    expect(first).toMatchObject({ state: 'escalated', reason: 'No change needed: the code is already minimal.' });
    expect(first.pr).toBeUndefined();

    await o.retryTask(workItemId, taskId, { by: 'sam', note: 'Add fixed.txt anyway.' });
    const second = await o.runTask(project, workItemId, taskId);
    expect(second.state).toBe('ready');
    expect(second.pr).toBeDefined();
    expect(requests.filter((r) => r.profile.role === 'implementer')[1]!.input).toContain('Add fixed.txt anyway.');
  });
});

describe('verdict rules', () => {
  const passed = [{ name: 'test', command: 'x', outcome: 'passed' as const, durationMs: 1 }];
  it('reads the last JSON verdict and never passes unreadable output', () => {
    expect(parseReview('first {"verdict":"rework","reasons":["a"]} then\n{"verdict":"pass","risk":"low"}', 'm')).toMatchObject({ verdict: 'pass', risk: 'low' });
    expect(parseReview('{"verdict":"maybe"}', 'm').verdict).toBe('escalate');
    expect(parseReview(undefined, 'm').verdict).toBe('escalate');
    expect(parseReview('{"verdict":"rework"}', 'm').reasons).toEqual(['The reviewer gave no reason.']);
  });
  it('lets checks and CI decide before the reviewer', () => {
    const review = { verdict: 'pass' as const, risk: 'low' as const, reasons: [], model: 'm' };
    expect(combine([{ ...passed[0]!, outcome: 'failed' }], { state: 'passed', runs: [] }, review).verdict).toBe('rework');
    expect(combine(passed, { state: 'failed', runs: [] }, review).verdict).toBe('rework');
    expect(combine(passed, { state: 'timed_out', runs: [] }, review).verdict).toBe('escalate');
    expect(combine(passed, { state: 'none', runs: [] }, review).verdict).toBe('pass');
  });
});

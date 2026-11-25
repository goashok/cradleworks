// A watch pass on the fakes, without the CLI: what a hosted service sees when it calls the runner.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type Project, type ProjectConfig } from '@cradleworks/core';
import { createBareRepo, FakeTracker, git, InMemoryStateStore, LocalGitSourceControl, localRepoRef, ProcessSandbox, ScriptedAgentRuntime, type ScriptStep } from '@cradleworks/contracts/fakes';
import type { ItemRef } from '@cradleworks/interfaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWork, recoverOpenWork, runPass, type PassEvent, type PassTarget } from './watch-pass.ts';

const config: ProjectConfig = {
  project: 'shop',
  adapters: { scm: 'local-git', ci: 'none', tracker: 'fake', sandbox: 'process', runtime: 'scripted' },
  runtime: { agent: 'scripted', model: 'm', roles: {} },
  stack: { image: 'unused', commands: { build: 'test -f README.md', test: 'test -f CHANGELOG.md' } },
  context: { include: ['.'], rules: [] },
  gates: { specApproval: 'human', planCheck: 'ai', changeApproval: 'ai', autoMerge: true },
  budgets: { perTaskUsd: 5, maxReworkLoops: 2 },
  specs: 'repo',
  concurrency: 2,
  verify: { tester: false },
  relatedRepos: [],
  network: { mode: 'none', allow: [] },
};

const json = (v: unknown): ScriptStep => ({ kind: 'message', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });

let root: string;
let bare: string;
let tracker: FakeTracker;
let target: PassTarget;
let events: PassEvent[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-runner-'));
  bare = join(root, 'shop.git');
  await createBareRepo(bare, { 'README.md': '# Shop\n' });
  tracker = new FakeTracker();
  tracker.allowApprover('sam');
  const project: Project = { repo: localRepoRef(bare), config };
  const runtime = new ScriptedAgentRuntime((req) => {
    switch (req.profile.role) {
      case 'specifier':
        return [json({ title: 'Add a changelog', problem: 'No changelog.', acceptance_criteria: ['CHANGELOG.md exists'], out_of_scope: [], assumptions: [] })];
      case 'planner':
        return [json({ tasks: [{ key: 't1', title: 'Write the changelog', description: 'Create CHANGELOG.md.', size: 'small', depends_on: [], criteria: [1] }] })];
      case 'reviewer':
        return [/^# (Spec|Plan) check/.test(req.input) ? json({ verdict: 'approved', reasons: [] }) : json({ verdict: 'pass', risk: 'low', reasons: [] })];
      default:
        return [{ kind: 'message', text: 'Added it.' }, { kind: 'write', path: 'CHANGELOG.md', content: '# Changelog\n' }];
    }
  });
  const orchestrator = new Orchestrator({
    store: new InMemoryStateStore(),
    sourceControl: new LocalGitSourceControl(),
    sandbox: new ProcessSandbox(join(root, 'sandboxes')),
    runtime,
    tracker,
    workRoot: join(root, 'work'),
    ciWait: { appearSeconds: 0, finishSeconds: 1, pollSeconds: 0 },
  });
  target = { project, orchestrator, tracker };
  events = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const issue = (labels = ['factory']): ItemRef => tracker.addItem({ project: target.project.repo.id, title: 'Add a changelog', body: 'We need one.', author: 'alex', labels });
const pass = (lastState?: Map<string, string>) => runPass(target, { label: 'factory', report: (e) => events.push(e), ...(lastState ? { lastState } : {}) });
const kinds = () => events.map((e) => e.kind);
const states = () => events.flatMap((e) => (e.kind === 'state' ? [{ state: e.state, waitingFor: e.waitingFor, changed: e.changed }] : []));

describe('runPass', () => {
  it('takes a labelled issue to the spec gate, then to a merge once a person approves', async () => {
    const ref = issue();
    issue([]); // not the factory's
    const lastState = new Map<string, string>();

    await pass(lastState);
    expect(events.filter((e) => e.kind === 'picked_up')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'picked_up')).toMatchObject({ item: ref });
    expect(events.some((e) => e.kind === 'progress' && e.progress.kind === 'spec')).toBe(true);
    expect(states()).toEqual([{ state: 'awaiting_spec_approval', waitingFor: expect.stringMatching(/^spec approval/), changed: true }]);

    // Nothing new: same state, reported as unchanged.
    events = [];
    await pass(lastState);
    expect(kinds()).not.toContain('picked_up');
    expect(states()).toEqual([{ state: 'awaiting_spec_approval', waitingFor: expect.stringMatching(/^spec approval/), changed: false }]);

    events = [];
    tracker.addComment(ref, 'sam', '/approve');
    await pass(lastState);
    expect(events.some((e) => e.kind === 'progress' && e.progress.kind === 'decided' && e.progress.gate === 'spec_approval' && e.progress.verdict === 'approved')).toBe(true);
    expect(states().at(-1)).toMatchObject({ state: 'merged', changed: true });
    expect((await git(['--git-dir', bare, 'show', 'main:CHANGELOG.md'])).stdout).toBe('# Changelog\n');
    expect(await openWork(target)).toEqual([]);
  });

  it('cancels the work when the issue is closed, and leaves it alone when the label is only taken off', async () => {
    const closed = issue();
    const paused = issue();
    await pass();
    const before = await openWork(target);
    expect(before).toHaveLength(2);

    events = [];
    await tracker.close(closed);
    tracker.removeLabel(paused, 'factory');
    await pass();
    expect(events.filter((e) => e.kind === 'cancelled').map((e) => (e.kind === 'cancelled' ? e.workItem.source.id : ''))).toEqual([closed.id]);
    expect((await openWork(target)).map((wi) => wi.source.id)).toEqual([paused.id]);
  });

  it('reports a tracker it cannot list, and does nothing else', async () => {
    issue();
    tracker.listOpen = async () => {
      throw new Error('rate limited');
    };
    await pass();
    expect(events).toEqual([{ kind: 'list_failed', error: 'rate limited' }]);
  });

  it('reports an error on one work item without stopping the pass', async () => {
    issue();
    const orchestrator = target.orchestrator;
    orchestrator.runWorkItem = async () => {
      throw new Error('boom');
    };
    await pass();
    expect(events.filter((e) => e.kind === 'error').map((e) => (e.kind === 'error' ? e.error : ''))).toEqual(['boom']);
  });
});

describe('recoverOpenWork', () => {
  it('has nothing to recover when nothing was cut off', async () => {
    issue();
    await pass();
    expect(await recoverOpenWork(target)).toEqual([]);
  });
});

// Spend caps: the per-task cap covers every attempt, the requester's daily and monthly caps
// cover everything they asked for, and a stopped task resumes once a cap is raised.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBareRepo,
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
import type { Task } from '../domain/types.ts';
import { checkBudget, type UserSpend } from './budget.ts';
import { Orchestrator, type Project } from './index.ts';

const config: ProjectConfig = {
  project: 'shop',
  adapters: { scm: 'local-git', ci: 'none', tracker: 'none', sandbox: 'process', runtime: 'scripted' },
  runtime: { agent: 'scripted', model: 'm', roles: {} },
  stack: { image: 'unused', commands: { build: 'test -f README.md', test: 'true' } },
  context: { include: ['.'], rules: [] },
  gates: { specApproval: 'skipped', planCheck: 'skipped', changeApproval: 'ai', autoMerge: true },
  budgets: { perTaskUsd: 1, maxReworkLoops: 3 },
  specs: 'factory',
  concurrency: 1,
  verify: { tester: false },
  relatedRepos: [],
  network: { mode: 'none', allow: [] },
};

const usage = (costUsd: number): ScriptStep => ({ kind: 'usage', inputTokens: 100, outputTokens: 100, costUsd });
const verdict = (v: 'pass' | 'rework'): ScriptStep => ({ kind: 'message', text: `\`\`\`json\n{"verdict":"${v}","risk":"low","reasons":["${v === 'rework' ? 'Add a heading.' : 'Fine.'}"]}\n\`\`\`` });

describe('checkBudget', () => {
  const user = (day = 0, month = 0, extraDay = 0): UserSpend => ({ requester: 'alex', day: { key: '2026-11-22', spentUsd: day, extraUsd: extraDay }, month: { key: '2026-11', spentUsd: month, extraUsd: 0 } });
  const task = (spentUsd: number, budgetUsd?: number) => ({ spentUsd, ...(budgetUsd ? { budgetUsd } : {}) }) as Task;

  it('gives a task what is left of its cap over all attempts', () => {
    expect(checkBudget(config, task(0.25), user())).toEqual({ allowedUsd: 0.75 });
    expect(checkBudget(config, task(1.2), user()).stop).toBe("budget: the task's $1.00 cap is used up ($1.20 spent over all its attempts)");
    expect(checkBudget(config, task(1.2, 3), user())).toEqual({ allowedUsd: 1.8 });
  });

  it('takes the tightest of the task, daily and monthly caps, with extensions', () => {
    const capped = { ...config, budgets: { ...config.budgets, perUserDailyUsd: 2, perUserMonthlyUsd: 10 } };
    expect(checkBudget(capped, task(0), user(1.6, 3))).toEqual({ allowedUsd: 0.4 });
    expect(checkBudget(capped, task(0), user(2, 3)).stop).toBe("budget: @alex's daily cap of $2.00 is used up ($2.00 on 2026-11-22 UTC)");
    expect(checkBudget(capped, task(0), user(2, 3, 5))).toEqual({ allowedUsd: 1 });
    expect(checkBudget(capped, task(0), user(0, 9.99)).stop).toMatch(/monthly cap of \$10\.00 is used up/);
    expect(checkBudget(capped, undefined, user(0.5, 0))).toEqual({ allowedUsd: 1 });
  });
});

describe('budget stops', () => {
  let root: string;
  let project: Project;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cw-budget-'));
    const bare = join(root, 'shop.git');
    await createBareRepo(bare, { 'README.md': '# Shop\n' });
    project = { repo: localRepoRef(bare), config };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function orchestrator(implementer: (n: number) => ScriptStep[], reviewer: (n: number) => ScriptStep[] = () => [verdict('pass')]) {
    const counts = { implementer: 0, reviewer: 0 };
    const runtime = new ScriptedAgentRuntime((req: AgentRunRequest) => {
      const role = req.profile.role === 'reviewer' ? 'reviewer' : 'implementer';
      const n = ++counts[role];
      return role === 'reviewer' ? reviewer(n) : implementer(n);
    });
    let ids = 0;
    let tick = 0;
    return new Orchestrator({
      store: new InMemoryStateStore(),
      sourceControl: new LocalGitSourceControl(),
      sandbox: new ProcessSandbox(join(root, 'sandboxes')),
      runtime,
      workRoot: join(root, 'work'),
      clock: () => new Date(Date.UTC(2026, 10, 22, 12, 0, 0, tick++)).toISOString(),
      newId: (kind) => `${kind}_${String(++ids).padStart(8, '0')}`,
      ciWait: { appearSeconds: 0, finishSeconds: 1, pollSeconds: 0 },
    });
  }
  const write = (n: number): ScriptStep => ({ kind: 'write', path: 'CHANGELOG.md', content: `# Changelog ${n}\n` });

  it('stops a task whose attempts together reach its cap, and carries on when the cap is raised', async () => {
    const o = orchestrator(
      (n) => [usage(n === 2 ? 0.9 : 0.4), { kind: 'message', text: 'Done.' }, write(n)],
      (n) => [usage(0.1), verdict(n === 1 ? 'rework' : 'pass')],
    );
    const { workItemId, taskId } = await o.submitTask({ project, title: 'Add a changelog', body: 'Create CHANGELOG.md.', requester: 'alex' });
    const paused = await o.runTask(project, workItemId, taskId);
    // Build 0.40 + review 0.10, then the rework run had $0.50 left and was stopped there.
    expect(paused.state).toBe('budget_exceeded');
    expect(paused.reason).toMatch(/^budget: the task's \$1\.00 cap is used up/);
    let wi = (await o.getWorkItem(workItemId))!;
    expect(wi.tasks[0]!.spentUsd).toBeCloseTo(1.4);
    expect(wi.spentUsd).toBeCloseTo(1.4);

    // Nothing more runs while it's paused.
    expect((await o.runTask(project, workItemId, taskId)).state).toBe('budget_exceeded');

    expect(await o.extendTaskBudget(project, workItemId, taskId, { by: 'sam', extraUsd: 2 })).toBe(3);
    expect((await o.runTask(project, workItemId, taskId)).state).toBe('merged');
    wi = (await o.getWorkItem(workItemId))!;
    expect(wi.tasks[0]!.budgetUsd).toBe(3);
  });

  it("stops at the requester's daily cap and resumes when it is raised", async () => {
    const daily = { ...project, config: { ...config, budgets: { ...config.budgets, perUserDailyUsd: 0.3 } } };
    const o = orchestrator((n) => [usage(n === 1 ? 0.5 : 0.1), { kind: 'message', text: 'Done.' }, write(n)]);
    const { workItemId, taskId } = await o.submitTask({ project: daily, title: 'Add a changelog', body: 'Create CHANGELOG.md.', requester: 'alex' });
    const paused = await o.runTask(daily, workItemId, taskId);
    expect(paused.state).toBe('budget_exceeded');
    expect(paused.reason).toBe("budget: @alex's daily cap of $0.30 is used up ($0.50 on 2026-11-22 UTC)");
    expect((await o.spendOf('alex')).day.spentUsd).toBeCloseTo(0.5);

    // Raising only the task's cap doesn't help: the daily cap still binds.
    await o.extendTaskBudget(daily, workItemId, taskId, { by: 'sam', extraUsd: 0 });
    expect((await o.runTask(daily, workItemId, taskId)).state).toBe('budget_exceeded');

    await o.extendUserBudget({ requester: 'alex', period: 'day', extraUsd: 1, by: 'sam' });
    await o.extendTaskBudget(daily, workItemId, taskId, { by: 'sam', extraUsd: 0 });
    expect((await o.runTask(daily, workItemId, taskId)).state).toBe('merged');
  });
});

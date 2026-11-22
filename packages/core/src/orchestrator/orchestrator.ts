// The orchestrator drives a work item through the stations. In M1 it has two jobs:
// accept a hand-written task (spec and plan stations are M3), and run the Build station.
// Every decision lands in the work item's stream; every step lands in the run's stream.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterError,
  type AgentEvent,
  type AgentOutcome,
  type AgentRuntime,
  type ExternalRef,
  type NetworkPolicy,
  type PullRequestRef,
  type RepoRef,
  type Sandbox,
  type SandboxHandle,
  type SourceControl,
  type StateStore,
} from '@cradleworks/interfaces';
import { resolveAgent, type ProjectConfig } from '../config/types.ts';
import type { WorkItemEvent } from '../domain/events.ts';
import { newId, type IdKind } from '../domain/ids.ts';
import type { Task, WorkItem } from '../domain/types.ts';
import { buildContextPack, DEFAULT_CONTEXT_BUDGET_BYTES } from './context-pack.ts';
import { implementerPrompt } from './prompts.ts';
import { RunLog } from './run-log.ts';
import { WorkItemRepository } from './work-item-repository.ts';

export interface OrchestratorDeps {
  store: StateStore;
  sourceControl: SourceControl;
  sandbox: Sandbox;
  runtime: AgentRuntime;
  /** Scratch space for checkouts; one folder per task, removed afterwards. */
  workRoot: string;
  clock?: () => string;
  newId?: (kind: IdKind) => string;
  contextBudgetBytes?: number;
  /** Wall-clock limit for one Build run. Default 30 minutes. */
  buildWallSeconds?: number;
}

export interface Project {
  repo: RepoRef;
  config: ProjectConfig;
  /** Branch PRs target. Default "main". */
  baseBranch?: string;
}

export interface SubmitTaskInput {
  project: Project;
  title: string;
  /** Markdown: what to change and how to tell it is done. */
  body: string;
  requester: string;
  /** Where the request came from; defaults to a reference to the submitted task itself. */
  source?: ExternalRef;
}

export type BuildOutcome =
  | { outcome: 'pr_opened'; pr: PullRequestRef; runId: string; branch: string }
  | { outcome: 'failed'; reason: string; runId: string };

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #repo: WorkItemRepository;
  readonly #clock: () => string;
  readonly #id: (kind: IdKind) => string;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#repo = new WorkItemRepository(deps.store);
    this.#clock = deps.clock ?? (() => new Date().toISOString());
    this.#id = deps.newId ?? newId;
  }

  getWorkItem(workItemId: string): Promise<WorkItem | undefined> {
    return this.#repo.load(workItemId);
  }

  /**
   * Records a hand-written task as a work item with an approved one-task plan.
   * The submitter wrote the spec, so the spec and plan gates are recorded as skipped.
   */
  async submitTask(input: SubmitTaskInput): Promise<{ workItemId: string; taskId: string }> {
    if (input.title.trim() === '') throw new Error('a task needs a title');
    const workItemId = this.#id('wi');
    const specId = this.#id('spec');
    const taskId = this.#id('task');
    const at = this.#clock();
    const skipped = (gate: 'spec_approval' | 'plan_check', subjectId: string): WorkItemEvent => ({
      type: 'gate_decided',
      at,
      decisionId: this.#id('gate'),
      gate,
      subjectId,
      mode: 'skipped',
      decidedBy: input.requester,
      verdict: 'approved',
      reason: 'Hand-written task submitted directly; the Specify and Plan stations arrive in M3.',
    });

    await this.#repo.append(undefined, [
      {
        type: 'work_item_received',
        at,
        workItemId,
        source: input.source ?? { id: `submitted:${workItemId}`, url: input.project.repo.url },
        requester: input.requester,
        projectId: input.project.config.project,
        title: input.title,
        maxReworkLoops: input.project.config.budgets.maxReworkLoops,
      },
      { type: 'specifying_started', at },
      { type: 'spec_drafted', at, specId, version: 1 },
      skipped('spec_approval', specId),
      { type: 'tasks_planned', at, tasks: [{ taskId, title: input.title, dependsOn: [], size: 'small', description: input.body }] },
      skipped('plan_check', workItemId),
    ]);
    return { workItemId, taskId };
  }

  /**
   * Build station: checkout → sandbox → context pack → agent → commit → push → PR.
   * Leaves the task in `verifying` with a PR on success, `failed` otherwise.
   */
  async runBuild(project: Project, workItemId: string, taskId: string): Promise<BuildOutcome> {
    let wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    const taskBody = task.description ?? '';
    const runId = this.#id('run');
    const branch = `factory/${shortId(taskId)}`;
    const base = project.baseBranch ?? 'main';
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile = { role: 'implementer' as const, ...resolveAgent(project.config, 'implementer') };

    wi = await this.#repo.append(wi, [
      { type: 'run_started', at: this.#clock(), runId, subjectId: taskId, station: 'build', agentProfile: profile },
      { type: 'task_started', at: this.#clock(), taskId, branch },
    ]);
    await log.write({ type: 'run_context', workItemId, taskId, station: 'build' });

    const checkoutDir = join(this.#deps.workRoot, shortId(workItemId), shortId(taskId));
    let sandbox: SandboxHandle | undefined;
    let step = 'clone';
    try {
      rmSync(checkoutDir, { recursive: true, force: true });
      mkdirSync(checkoutDir, { recursive: true });
      const checkout = await this.#deps.sourceControl.clone(project.repo, join(checkoutDir, 'source'), { ref: base });
      await log.write({ type: 'checkout_cloned', path: checkout.path, repo: project.repo.id });

      step = 'sandbox';
      const network = withHosts(project.config.network, this.#deps.runtime.requiredHosts(profile));
      sandbox = await this.#deps.sandbox.create({
        taskId: shortId(taskId),
        source: checkout,
        baseRef: base,
        branch,
        image: project.config.stack.image,
        network,
      });
      await log.write({ type: 'sandbox_created', sandboxId: sandbox.id, branch, baseRef: base, network });

      step = 'context';
      const pack = buildContextPack(sandbox.workspacePath, project.config.context.rules, this.#deps.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES);
      await log.write({ type: 'context_pack_built', ...pack });
      const contextFiles = pack.files.map((f) => f.path);

      step = 'agent';
      const limits = { maxWallSeconds: this.#deps.buildWallSeconds ?? 1800, maxSpendUsd: project.config.budgets.perTaskUsd };
      await log.write({ type: 'agent_started', agent: profile.agent, model: profile.model, limits });
      const run = await this.#deps.runtime.start({
        runId,
        profile,
        sandbox,
        rolePrompt: implementerPrompt(project.config, contextFiles),
        input: `# ${task.title}\n\n${taskBody}`.trim(),
        contextFiles,
        tools: { allow: [], deny: [] },
        limits,
      });
      let done: Extract<AgentEvent, { type: 'done' }> | undefined;
      for await (const event of run.events) {
        await log.write({ type: 'agent_event', event });
        if (event.type === 'done') done = event;
      }
      const outcome: AgentOutcome = done?.outcome ?? 'failed';
      if (outcome !== 'succeeded') {
        return await this.#fail(wi, log, runId, taskId, 'agent', `agent run ${outcome}${done?.error ? `: ${done.error}` : ''}`, outcome);
      }

      step = 'commit';
      const copy = { repo: project.repo, path: sandbox.workspacePath };
      let sha: string;
      try {
        sha = (await this.#deps.sourceControl.commit(copy, commitMessage(task, workItemId, runId))).sha;
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'invalid_input') {
          return await this.#fail(wi, log, runId, taskId, 'commit', 'the agent finished without changing any files', 'succeeded');
        }
        throw error;
      }
      await log.write({ type: 'changes_committed', sha });

      step = 'push';
      await this.#deps.sourceControl.push(copy, branch);
      await log.write({ type: 'branch_pushed', branch });

      step = 'pr';
      const pr = await this.#deps.sourceControl.openPR({
        repo: project.repo,
        head: branch,
        base,
        title: task.title,
        body: prBody(taskBody, done?.summary, workItemId, taskId, runId, contextFiles),
        labels: [],
      });
      await log.write({ type: 'pr_opened', id: pr.id, url: pr.url });

      await this.#repo.append(wi, [
        { type: 'task_pr_opened', at: this.#clock(), taskId, pr },
        { type: 'task_built', at: this.#clock(), taskId },
        { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
      ]);
      return { outcome: 'pr_opened', pr, runId, branch };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await this.#fail(wi, log, runId, taskId, step, message, 'failed');
    } finally {
      if (sandbox) {
        await this.#deps.sandbox.destroy(sandbox).catch(() => undefined);
        await log.write({ type: 'sandbox_destroyed', sandboxId: sandbox.id }).catch(() => undefined);
      }
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  }

  async #fail(wi: WorkItem, log: RunLog, runId: string, taskId: string, step: string, reason: string, outcome: AgentOutcome): Promise<BuildOutcome> {
    await log.write({ type: 'step_failed', step, error: reason });
    const latest = (await this.#repo.load(wi.id)) ?? wi;
    await this.#repo.append(latest, [
      { type: 'task_failed', at: this.#clock(), taskId, reason: `${step}: ${reason}` },
      { type: 'run_ended', at: this.#clock(), runId, outcome: outcome === 'succeeded' ? 'failed' : outcome },
    ]);
    return { outcome: 'failed', reason: `${step}: ${reason}`, runId };
  }

  async #mustLoad(workItemId: string): Promise<WorkItem> {
    const wi = await this.#repo.load(workItemId);
    if (!wi) throw new Error(`no work item ${workItemId}`);
    return wi;
  }
}

/** The project's network policy plus the hosts the agent itself must reach. */
function withHosts(policy: NetworkPolicy, hosts: string[]): NetworkPolicy {
  if (hosts.length === 0) return policy;
  const base = policy.mode === 'allowlist' ? policy.allow : [];
  return { mode: 'allowlist', allow: [...new Set([...base, ...hosts])] };
}

function findTask(wi: WorkItem, taskId: string): Task {
  const task = wi.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`work item ${wi.id} has no task ${taskId}`);
  return task;
}

/** "task_1b9d6bcd-…" → "task-1b9d6bcd": short enough for branch and folder names. */
function shortId(id: string): string {
  const [kind, rest] = id.split('_', 2);
  return rest ? `${kind}-${rest.slice(0, 8)}` : id;
}

function commitMessage(task: Task, workItemId: string, runId: string): string {
  return `${task.title}\n\nFactory task ${task.id} (work item ${workItemId}), run ${runId}.`;
}

function prBody(taskBody: string, summary: string | undefined, workItemId: string, taskId: string, runId: string, contextFiles: string[]): string {
  return [
    '## Task',
    taskBody.trim() || '_(no description)_',
    '',
    '## Agent summary',
    summary?.trim() || '_(the agent gave no summary)_',
    '',
    '## Factory',
    `- Work item: \`${workItemId}\``,
    `- Task: \`${taskId}\``,
    `- Run: \`${runId}\` (replay with \`factory replay ${runId}\`)`,
    `- Context files: ${contextFiles.length > 0 ? contextFiles.map((f) => `\`${f}\``).join(', ') : 'none'}`,
    '',
    '_Opened by Cradleworks. Verification (station 6) arrives in M2._',
  ].join('\n');
}

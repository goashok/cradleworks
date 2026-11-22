// The orchestrator drives a work item through the stations. Through M2 it accepts a
// hand-written task (the spec and plan stations are M3), runs Build and Verify in a loop
// until the change passes or needs a human, and applies the change gate.
// Every decision lands in the work item's stream; every step lands in the run's stream.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterError,
  type AgentEvent,
  type AgentOutcome,
  type AgentProfile,
  type AgentRole,
  type AgentRuntime,
  type FactoryStatus,
  type GateName,
  type ItemRef,
  type CI,
  type ExternalRef,
  type NetworkPolicy,
  type PullRequestRef,
  type RepoRef,
  type Sandbox,
  type SandboxHandle,
  type SourceControl,
  type SpecDocument,
  type SpecStore,
  type StateStore,
  type Tracker,
  type TrackerItem,
  type WorkingCopy,
} from '@cradleworks/interfaces';
import { resolveAgent, type ProjectConfig } from '../config/types.ts';
import type { WorkItemEvent } from '../domain/events.ts';
import { newId, type IdKind } from '../domain/ids.ts';
import { TERMINAL_WORK_ITEM_STATES, type CheckResult, type CiResult, type Evidence, type GateMode, type ReviewResult, type Station, type Task, type TaskState, type VerifyVerdict, type WorkItem, type WorkItemState } from '../domain/types.ts';
import { buildContextPack, DEFAULT_CONTEXT_BUDGET_BYTES } from './context-pack.ts';
import { implementerPrompt, reviewerPrompt } from './prompts.ts';
import {
  baseDirective,
  checkerPrompt,
  checkPlan,
  commandsAfter,
  gateTag,
  parseCheck,
  parsePlan,
  parseSpecAnswer,
  planComment,
  plannerInput,
  plannerPrompt,
  questionsComment,
  repliesAfter,
  reposSection,
  slug,
  specBody,
  specComment,
  specFile,
  specifierInput,
  specifierPrompt,
  testerInput,
  testerPrompt,
  type PlanDraftTask,
} from './issue-flow.ts';
import { RunLog } from './run-log.ts';
import { EventSpecStore } from './spec-store.ts';
import { combine, evidenceMarkdown, parseReview, reworkFeedback, runChecks, waitForCi, type CiWaitOptions } from './verify.ts';
import { WorkItemRepository } from './work-item-repository.ts';

export interface OrchestratorDeps {
  store: StateStore;
  sourceControl: SourceControl;
  sandbox: Sandbox;
  runtime: AgentRuntime;
  /** CI for the Verify station; absent = the project has none. */
  ci?: CI;
  /** Where requests come from and where the factory reports back; absent = CLI only. */
  tracker?: Tracker;
  /** Default: specs in the factory's event log. */
  specStore?: SpecStore;
  /** Wall-clock limit for the spec, plan, check and tester agents. Default 15 minutes. */
  stationWallSeconds?: number;
  /** Scratch space for checkouts; one folder per task, removed afterwards. */
  workRoot: string;
  clock?: () => string;
  newId?: (kind: IdKind) => string;
  contextBudgetBytes?: number;
  /** Wall-clock limit for one Build run. Default 30 minutes. */
  buildWallSeconds?: number;
  /** Wall-clock limit for the reviewer. Default 15 minutes. */
  reviewWallSeconds?: number;
  /** Per stack command in Verify. Default 20 minutes. */
  checkTimeoutSeconds?: number;
  ciWait?: CiWaitOptions;
}

export interface Project {
  repo: RepoRef;
  config: ProjectConfig;
  /** Branch PRs target. Default "main". */
  baseBranch?: string;
  /** Related projects, by project name, that the planner may give tasks to. */
  related?: Record<string, Project>;
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
  | { outcome: 'pr_opened'; pr: PullRequestRef; runId: string; branch: string; reworked: boolean }
  | { outcome: 'declined'; reason: string; runId: string }
  | { outcome: 'failed'; reason: string; runId: string };

export type VerifyOutcome = { verdict: VerifyVerdict; reason: string; runId: string; evidence?: Evidence };

/** Where a task stands after `runTask` returns: waiting on a person, done, or ended. */
export interface TaskOutcome {
  state: TaskState;
  /** True when the task is ready and the change gate waits on a person. */
  awaitingApproval: boolean;
  pr?: PullRequestRef;
  branch?: string;
  reason?: string;
  evidence?: Evidence;
}

/** Progress reports from `runTask`, for a CLI to print as they happen. */
export type Progress =
  | { kind: 'built'; outcome: BuildOutcome; attempt: number }
  | { kind: 'verified'; outcome: VerifyOutcome; attempt: number }
  | { kind: 'gate'; verdict: 'approved' | 'waiting'; mode: 'human' | 'ai' | 'skipped' }
  | { kind: 'merged'; sha: string };

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #repo: WorkItemRepository;
  readonly #clock: () => string;
  readonly #id: (kind: IdKind) => string;
  readonly #locks = new Map<string, Promise<WorkItem>>();
  readonly #specs: SpecStore;
  readonly #slots = new Map<string, { free: number; waiting: Array<() => void> }>();
  readonly #statusShown = new Map<string, FactoryStatus>();
  readonly #announced = new Set<string>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#repo = new WorkItemRepository(deps.store);
    this.#clock = deps.clock ?? (() => new Date().toISOString());
    this.#id = deps.newId ?? newId;
    this.#specs = deps.specStore ?? new EventSpecStore(deps.store, this.#clock);
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
        ...(input.project.baseBranch ? { baseBranch: input.project.baseBranch } : {}),
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
   * Moves a task as far as it can go without a person: Build, Verify, back to Build on
   * rework, until it is ready (then the change gate), escalated, failed or merged.
   */
  async runTask(project: Project, workItemId: string, taskId: string, onProgress: (p: Progress) => void = () => undefined): Promise<TaskOutcome> {
    for (;;) {
      const wi = await this.#mustLoad(workItemId);
      const task = findTask(wi, taskId);
      const attempt = task.reworkLoops + task.gateReworks + 1;
      switch (task.state) {
        case 'queued':
        case 'rework': {
          const outcome = await this.runBuild(project, workItemId, taskId);
          onProgress({ kind: 'built', outcome, attempt });
          break;
        }
        case 'verifying': {
          const outcome = await this.runVerify(project, workItemId, taskId);
          onProgress({ kind: 'verified', outcome, attempt });
          break;
        }
        case 'ready': {
          if (!task.changeApproved) {
            const mode = project.config.gates.changeApproval;
            if (mode === 'human') {
              onProgress({ kind: 'gate', verdict: 'waiting', mode });
              return outcomeOf(task, true);
            }
            await this.#decideChange(wi, task, {
              mode,
              verdict: 'approved',
              decidedBy: mode === 'ai' ? `reviewer (${task.evidence?.review?.model ?? 'unknown'})` : 'factory',
              reason: mode === 'ai' ? (task.evidence?.reason ?? 'verify passed') : 'change_approval is "skip" in factory.yaml',
            });
            onProgress({ kind: 'gate', verdict: 'approved', mode });
            continue;
          }
          if (!project.config.gates.autoMerge) return outcomeOf(task, false);
          const sha = await this.mergeTask(project, workItemId, taskId);
          onProgress({ kind: 'merged', sha });
          continue;
        }
        default:
          return outcomeOf(task, false);
      }
    }
  }

  /**
   * Build station: checkout → sandbox → context pack → agent → commit → push → PR.
   * A task coming back for rework is built on its own branch, with the reasons it came
   * back, and pushed to the same PR. Leaves the task `verifying` on success, `escalated`
   * when the agent declines to change anything, `failed` otherwise.
   */
  async runBuild(project: Project, workItemId: string, taskId: string): Promise<BuildOutcome> {
    let wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    const rework = task.state === 'rework';
    const onBranch = rework && task.pr !== undefined;
    const runId = this.#id('run');
    const branch = task.branch ?? `factory/${shortId(taskId)}`;
    const base = baseFor(project, wi, task);
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile = { role: 'implementer' as const, ...resolveAgent(project.config, 'implementer') };
    const attempt = task.reworkLoops + task.gateReworks + 1;

    wi = await this.#emit(wi.id, [
      { type: 'run_started', at: this.#clock(), runId, subjectId: taskId, station: 'build', agentProfile: profile },
      rework ? { type: 'task_rework_started', at: this.#clock(), taskId } : { type: 'task_started', at: this.#clock(), taskId, branch },
    ]);
    await log.write({ type: 'run_context', workItemId, taskId, station: 'build', attempt });

    // A new folder per run, never a reused or recreated one: some sandboxes' file sharing can
    // keep a stale view of a deleted folder (and everything under it) that a container mounted,
    // so a rework at the old path fails with "bind source path does not exist".
    const checkoutDir = join(this.#deps.workRoot, shortId(workItemId), `${shortId(taskId)}-${shortId(runId)}`);
    let sandbox: SandboxHandle | undefined;
    let step = 'clone';
    try {
      mkdirSync(checkoutDir, { recursive: true });
      const checkout = await this.#deps.sourceControl.clone(project.repo, join(checkoutDir, 'source'), { ref: base });
      await log.write({ type: 'checkout_cloned', path: checkout.path, repo: project.repo.id });

      step = 'sandbox';
      const network = withHosts(project.config.network, this.#deps.runtime.requiredHosts(profile));
      const baseRef = onBranch ? `origin/${branch}` : base;
      sandbox = await this.#deps.sandbox.create({ taskId: shortId(taskId), source: checkout, baseRef, branch, image: project.config.stack.image, network });
      await log.write({ type: 'sandbox_created', sandboxId: sandbox.id, branch, baseRef, network });

      step = 'context';
      const pack = buildContextPack(sandbox.workspacePath, project.config.context.rules, this.#deps.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES);
      await log.write({ type: 'context_pack_built', ...pack });
      const contextFiles = pack.files.map((f) => f.path);

      const spec = await this.#specFor(task);
      if (spec && !rework && project.config.specs === 'repo' && !task.repo && wi.tasks[0]?.id === task.id) {
        step = 'spec';
        const file = `.factory/specs/${specFileName(wi, spec)}`;
        mkdirSync(join(sandbox.workspacePath, '.factory', 'specs'), { recursive: true });
        writeFileSync(join(sandbox.workspacePath, file), specFile(spec, wi.source));
        await log.write({ type: 'spec_written', path: file });
      }

      step = 'agent';
      const taskText = `# ${task.title}\n\n${task.description ?? ''}`.trim() + (spec ? `\n\n## The spec this task is part of\n\n${specBody(spec)}\n\nOther tasks may cover the rest of the spec; do only this task.` : '');
      const humanNote = task.lastReason && task.lastReason !== task.evidence?.reason ? task.lastReason : undefined;
      const input = rework ? `${taskText}\n\n${reworkFeedback(task.evidence, humanNote, attempt, task.acceptanceTests)}` : taskText;
      const limits = { maxWallSeconds: this.#deps.buildWallSeconds ?? 1800, maxSpendUsd: project.config.budgets.perTaskUsd };
      await log.write({ type: 'agent_started', agent: profile.agent, model: profile.model, limits });
      const done = await this.#runAgent(log, {
        runId,
        profile,
        sandbox,
        rolePrompt: implementerPrompt(project.config, contextFiles),
        input,
        contextFiles,
        tools: { allow: [], deny: [] },
        limits,
      });
      const outcome: AgentOutcome = done?.outcome ?? 'failed';
      if (outcome !== 'succeeded') {
        return await this.#fail(wi, log, runId, taskId, 'agent', `agent run ${outcome}${done?.error ? `: ${done.error}` : ''}`, outcome);
      }

      step = 'commit';
      const copy = { repo: project.repo, path: sandbox.workspacePath };
      let sha: string;
      try {
        sha = (await this.#deps.sourceControl.commit(copy, commitMessage(task, workItemId, runId, rework ? attempt : undefined))).sha;
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'invalid_input') {
          const reason = done?.summary?.trim() || 'the agent finished without changing any files';
          await log.write({ type: 'task_declined', reason });
          await this.#emit(wi.id, [
            { type: 'task_declined', at: this.#clock(), taskId, reason },
            { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
          ]);
          return { outcome: 'declined', reason, runId };
        }
        throw error;
      }
      await log.write({ type: 'changes_committed', sha });

      step = 'push';
      // A rebuild after an interrupted run, with no PR yet, replaces whatever that run pushed.
      await this.#deps.sourceControl.push(copy, branch, { replace: rework && !task.pr });
      await log.write({ type: 'branch_pushed', branch });

      let pr = task.pr;
      const events: WorkItemEvent[] = [];
      if (!pr) {
        step = 'pr';
        pr = await this.#deps.sourceControl.openPR({
          repo: project.repo,
          head: branch,
          base,
          title: task.title,
          body: prBody(task.description ?? '', done?.summary, workItemId, taskId, runId, contextFiles, fromTracker(wi) ? wi.source.url : undefined),
          labels: [],
        });
        await log.write({ type: 'pr_opened', id: pr.id, url: pr.url });
        events.push({ type: 'task_pr_opened', at: this.#clock(), taskId, pr });
      }

      await this.#emit(wi.id, [
        ...events,
        { type: 'task_built', at: this.#clock(), taskId },
        { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
      ]);
      return { outcome: 'pr_opened', pr, runId, branch, reworked: onBranch };
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

  /**
   * Verify station: the task's branch in a fresh sandbox (never the implementer's), then
   * the project's checks, CI on the pushed commit, and the reviewer agent. Records the
   * evidence, posts it on the PR, and moves the task to ready, rework or escalated.
   */
  async runVerify(project: Project, workItemId: string, taskId: string): Promise<VerifyOutcome> {
    let wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    if (task.state !== 'verifying') throw new Error(`task ${taskId} is ${task.state}, not verifying`);
    const branch = task.branch ?? `factory/${shortId(taskId)}`;
    const base = baseFor(project, wi, task);
    const runId = this.#id('run');
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile: AgentProfile = { role: 'reviewer', ...resolveAgent(project.config, 'reviewer') };
    const attempt = task.reworkLoops + task.gateReworks + 1;

    wi = await this.#emit(wi.id, [{ type: 'run_started', at: this.#clock(), runId, subjectId: taskId, station: 'verify', agentProfile: profile }]);
    await log.write({ type: 'run_context', workItemId, taskId, station: 'verify', attempt });

    // A new folder per run, never a reused or recreated one: some sandboxes' file sharing can
    // keep a stale view of a deleted folder (and everything under it) that a container mounted,
    // so a rework at the old path fails with "bind source path does not exist".
    const checkoutDir = join(this.#deps.workRoot, shortId(workItemId), `${shortId(taskId)}-${shortId(runId)}`);
    const ciAbort = new AbortController();
    let sandbox: SandboxHandle | undefined;
    let step = 'clone';
    let cost = 0;
    try {
      mkdirSync(checkoutDir, { recursive: true });
      const checkout = await this.#deps.sourceControl.clone(project.repo, join(checkoutDir, 'source'), { ref: base });
      await log.write({ type: 'checkout_cloned', path: checkout.path, repo: project.repo.id });

      step = 'sandbox';
      const network = withHosts(project.config.network, this.#deps.runtime.requiredHosts(profile));
      const baseRef = `origin/${branch}`;
      sandbox = await this.#deps.sandbox.create({ taskId: `${shortId(taskId)}-verify`, source: checkout, baseRef, branch, image: project.config.stack.image, network });
      await log.write({ type: 'sandbox_created', sandboxId: sandbox.id, branch, baseRef, network });
      const head = await this.#deps.sandbox.exec(sandbox, ['git', 'rev-parse', 'HEAD']);
      const sha = head.stdout.trim();
      if (head.exitCode !== 0 || !/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`cannot read the branch head: ${head.stderr.trim() || sha}`);

      // CI runs on its own clock; wait for it while the checks and the review run here.
      const ciPromise = waitForCi(this.#deps.ci, project.repo, sha, { ...this.#deps.ciWait, signal: ciAbort.signal });

      step = 'checks';
      const checks = await runChecks(this.#deps.sandbox, sandbox, project.config, { timeoutSeconds: this.#deps.checkTimeoutSeconds ?? 1200 });
      for (const c of checks) await log.write({ type: 'check_ran', ...c });
      let checksPassed = checks.every((c) => c.outcome === 'passed' || c.outcome === 'skipped');

      // The tester's acceptance tests: written once per task from the spec, without the diff.
      const spec = await this.#specFor(task);
      if (checksPassed && spec && project.config.verify.tester) {
        step = 'acceptance';
        let tests = findTask(await this.#mustLoad(workItemId), taskId).acceptanceTests;
        if (!tests) {
          const written = await this.#writeAcceptanceTests(project, workItemId, task, spec, checkout, base, runId, log);
          cost += written.cost;
          tests = written.tests;
        }
        if (tests && tests.files.length > 0) {
          const result = await runAcceptance(this.#deps.sandbox, sandbox, tests, project.config.stack.commands.test, this.#deps.checkTimeoutSeconds ?? 1200);
          checks.push(result);
          await log.write({ type: 'check_ran', ...result });
          checksPassed = result.outcome !== 'failed' && result.outcome !== 'timed_out';
        }
      }

      let review: ReviewResult | undefined;
      if (checksPassed) {
        step = 'review';
        const pack = buildContextPack(sandbox.workspacePath, project.config.context.rules, this.#deps.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES);
        const contextFiles = pack.files.map((f) => f.path);
        const limits = { maxWallSeconds: this.#deps.reviewWallSeconds ?? 900, maxSpendUsd: project.config.budgets.perTaskUsd };
        await log.write({ type: 'agent_started', agent: profile.agent, model: profile.model, limits });
        const done = await this.#runAgent(log, {
          runId,
          profile,
          sandbox,
          rolePrompt: reviewerPrompt(project.config, contextFiles, base),
          input: reviewInput(task, checks, spec),
          contextFiles,
          tools: { allow: [], deny: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'] },
          limits,
        });
        cost += done?.total.costUsd ?? 0;
        review =
          done?.outcome === 'succeeded'
            ? parseReview(done.summary, profile.model)
            : { verdict: 'escalate', risk: 'high', reasons: [`The reviewer run ended ${done?.outcome ?? 'without a result'}${done?.error ? `: ${done.error}` : ''}.`], model: profile.model };
        await log.write({ type: 'review_decided', ...review });
      }

      step = 'ci';
      let ci: CiResult;
      if (checksPassed) {
        ci = await ciPromise;
      } else {
        ciAbort.abort();
        ci = { state: 'skipped', runs: [], note: 'not waited for: the checks failed' };
      }
      await log.write({ type: 'ci_checked', ...ci });

      const { verdict, reason } = combine(checks, ci, review);
      const evidence: Evidence = { runId, sha, checks, ci, ...(review ? { review } : {}), verdict, reason, costUsd: cost, verifiedAt: this.#clock() };
      await log.write({ type: 'evidence', verdict, reason, sha });
      wi = await this.#emit(wi.id, [
        { type: 'task_evidence_recorded', at: this.#clock(), taskId, evidence },
        { type: 'task_verified', at: this.#clock(), taskId, verdict, reason },
        { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
      ]);

      if (task.pr) {
        await this.#deps.sourceControl
          .comment(task.pr, evidenceMarkdown(evidence, attempt))
          .then((c) => log.write({ type: 'evidence_posted', url: c.url }))
          .catch((e: unknown) => log.write({ type: 'evidence_not_posted', error: (e as Error).message }));
      }
      return { verdict, reason, runId, evidence };
    } catch (error) {
      // Verify itself broke: a person decides whether to retry, so the task escalates.
      ciAbort.abort();
      const message = error instanceof Error ? error.message : String(error);
      const reason = `verify could not run (${step}): ${message}`;
      await log.write({ type: 'step_failed', step, error: message });
      await this.#emit(wi.id, [
        { type: 'task_verified', at: this.#clock(), taskId, verdict: 'escalate', reason },
        { type: 'run_ended', at: this.#clock(), runId, outcome: 'failed' },
      ]);
      return { verdict: 'escalate', reason, runId };
    } finally {
      ciAbort.abort();
      if (sandbox) {
        await this.#deps.sandbox.destroy(sandbox).catch(() => undefined);
        await log.write({ type: 'sandbox_destroyed', sandboxId: sandbox.id }).catch(() => undefined);
      }
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  }

  // --- the issue flow (M3): intake → Specify → spec gate → Plan → plan check → tasks -----

  /** Work items, newest first, optionally of one project. */
  async listWorkItems(projectId?: string): Promise<WorkItem[]> {
    const out: WorkItem[] = [];
    for (const e of await this.#deps.store.query({ types: ['work_item_received'] })) {
      const wi = await this.#repo.load(e.streamId);
      if (wi && (!projectId || wi.projectId === projectId)) out.push(wi);
    }
    return out.reverse();
  }

  async findWorkItemBySource(sourceId: string): Promise<WorkItem | undefined> {
    for (const e of await this.#deps.store.query({ types: ['work_item_received'] })) {
      if ((e.payload as { source?: { id?: string } }).source?.id === sourceId) return this.#repo.load(e.streamId);
    }
    return undefined;
  }

  /** Records a tracker item as a work item, once: a second call returns the first one. */
  async receiveItem(project: Project, ref: ItemRef): Promise<{ workItemId: string; created: boolean }> {
    const existing = await this.findWorkItemBySource(ref.id);
    if (existing) return { workItemId: existing.id, created: false };
    const tracker = this.#tracker();
    const item = await tracker.getItem(ref);
    const workItemId = this.#id('wi');
    const base = baseDirective(item.body);
    await this.#repo.append(undefined, [
      {
        type: 'work_item_received',
        at: this.#clock(),
        workItemId,
        source: item.ref,
        requester: item.author.handle ?? item.author.name,
        projectId: project.config.project,
        title: item.title,
        maxReworkLoops: project.config.budgets.maxReworkLoops,
        ...(base ? { baseBranch: base } : {}),
      },
    ]);
    await this.#say(item.ref, `Picked up as \`${workItemId}\`${base ? `, working from \`${base}\`` : ''}. Next: a spec with acceptance criteria.`);
    return { workItemId, created: true };
  }

  /**
   * Takes a work item from an issue as far as it can go without a person: spec, plan,
   * then every task through Build, Verify and the change gate, in dependency order and in
   * parallel up to `concurrency`. Returns when it ends or waits on someone.
   */
  async runWorkItem(project: Project, workItemId: string, onProgress: (p: WorkProgress) => void = () => undefined): Promise<WorkItemOutcome> {
    for (let step = 0; step < 100; step++) {
      const wi = await this.#mustLoad(workItemId);
      await this.#showStatus(wi);
      if (TERMINAL_WORK_ITEM_STATES.has(wi.state)) {
        await this.#announceEnd(wi);
        onProgress({ kind: 'done', state: wi.state });
        return { state: wi.state };
      }
      switch (wi.state) {
        case 'blocked': {
          const by = await this.#unblockFromIssue(wi);
          if (!by) return { state: 'blocked', waitingFor: wi.blockedReason ?? 'a person' };
          onProgress({ kind: 'unblocked', by });
          continue;
        }
        case 'received':
        case 'specifying':
          await this.runSpecify(project, workItemId, onProgress);
          continue;
        case 'awaiting_spec_approval':
          if (!(await this.#specGate(project, wi, onProgress))) return { state: wi.state, waitingFor: 'spec approval: /approve or /reject on the issue' };
          continue;
        case 'planning':
          if (wi.proposedTasks.length === 0) {
            await this.runPlan(project, workItemId, onProgress);
            continue;
          }
          if (!(await this.#planGate(project, wi, onProgress))) return { state: wi.state, waitingFor: 'plan approval: /approve or /reject on the issue' };
          continue;
        default: {
          const waitingFor = await this.#runTasks(project, workItemId, onProgress);
          const after = await this.#mustLoad(workItemId);
          if (TERMINAL_WORK_ITEM_STATES.has(after.state)) continue;
          await this.#showStatus(after);
          return { state: after.state, waitingFor };
        }
      }
    }
    throw new Error(`work item ${workItemId} is not making progress`);
  }

  /** Specify station: the spec agent writes a spec from the issue, or asks its one round of questions. */
  async runSpecify(project: Project, workItemId: string, onProgress: (p: WorkProgress) => void = () => undefined): Promise<void> {
    let wi = await this.#mustLoad(workItemId);
    if (wi.state === 'received') wi = await this.#emit(workItemId, [{ type: 'specifying_started', at: this.#clock() }]);
    if (wi.state !== 'specifying') throw new Error(`work item ${workItemId} is ${wi.state}, not specifying`);
    const item = await this.#tracker().getItem(wi.source);
    const previous = wi.spec ? await this.#specs.get(wi.spec.specId) : undefined;
    const rejection = lastRejection(wi, 'spec_approval');
    const runId = this.#id('run');
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile: AgentProfile = { role: 'specifier', ...resolveAgent(project.config, 'specifier') };
    await this.#emit(workItemId, [{ type: 'run_started', at: this.#clock(), runId, subjectId: workItemId, station: 'specify', agentProfile: profile }]);
    await log.write({ type: 'run_context', workItemId, taskId: workItemId, station: 'specify' });

    const done = await this.#inspect(project, wi, runId, log, {
      role: 'specifier',
      station: 'specify',
      rolePrompt: (files) => specifierPrompt(files),
      input: specifierInput(item, { repos: { main: project.config.project, related: Object.keys(project.related ?? {}) }, ...(previous ? { previous } : {}), ...(rejection ? { rejection } : {}), ...(wi.specQuestions ? { questionsAsked: wi.specQuestions } : {}) }),
    });
    const answer = done.ok ? parseSpecAnswer(done.summary, !wi.specQuestions) : { kind: 'unreadable' as const, reason: done.error };
    await log.write({ type: 'spec_answer', kind: answer.kind });

    if (answer.kind === 'questions') {
      await this.#emit(workItemId, [
        { type: 'spec_questions_asked', at: this.#clock(), questions: answer.questions },
        { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
        { type: 'work_item_blocked', at: this.#clock(), reason: `waiting for @${wi.requester} to answer the spec agent's questions on the issue` },
      ]);
      await this.#say(wi.source, questionsComment(answer.questions, wi.requester), true);
      onProgress({ kind: 'questions', questions: answer.questions });
      return;
    }
    if (answer.kind === 'unreadable') {
      await this.#emit(workItemId, [{ type: 'run_ended', at: this.#clock(), runId, outcome: 'failed' }]);
      await this.#block(wi, `the spec agent could not write a spec: ${answer.reason}`, onProgress);
      return;
    }
    const spec = await this.#specs.save({
      id: wi.spec?.specId ?? this.#id('spec'),
      workItemId,
      title: answer.spec.title || wi.title,
      problem: answer.spec.problem,
      acceptanceCriteria: answer.spec.acceptanceCriteria,
      outOfScope: answer.spec.outOfScope,
      assumptions: answer.spec.assumptions,
    });
    const stored = spec;
    await this.#emit(workItemId, [
      { type: 'spec_drafted', at: this.#clock(), specId: stored.id, version: stored.version },
      { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
    ]);
    const mode = this.#gateMode(await this.#mustLoad(workItemId), 'spec_approval', project.config.gates.specApproval);
    await this.#say(wi.source, specComment(stored, mode), true);
    onProgress({ kind: 'spec', version: stored.version, title: stored.title, criteria: stored.acceptanceCriteria.length });
  }

  /** Plan station: the planner splits the approved spec into tasks; the plan must keep the rules. */
  async runPlan(project: Project, workItemId: string, onProgress: (p: WorkProgress) => void = () => undefined): Promise<void> {
    const wi = await this.#mustLoad(workItemId);
    if (wi.state !== 'planning' || wi.proposedTasks.length > 0) throw new Error(`work item ${workItemId} is not waiting for a plan`);
    const spec = (await this.#specFor({ specId: wi.spec?.specId ?? '' })) ?? fail(`work item ${workItemId} has no spec`);
    const repos = { main: project.config.project, related: Object.keys(project.related ?? {}) };
    const rejection = lastRejection(wi, 'plan_check');
    const runId = this.#id('run');
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile: AgentProfile = { role: 'planner', ...resolveAgent(project.config, 'planner') };
    await this.#emit(workItemId, [{ type: 'run_started', at: this.#clock(), runId, subjectId: workItemId, station: 'plan', agentProfile: profile }]);
    await log.write({ type: 'run_context', workItemId, taskId: workItemId, station: 'plan' });

    let draft: PlanDraftTask[] | undefined;
    let problems: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const done = await this.#inspect(project, wi, runId, log, {
        role: 'planner',
        station: 'plan',
        rolePrompt: (files) => plannerPrompt(files),
        input: plannerInput(spec, repos, { ...(rejection ? { rejection } : {}), ...(problems.length ? { problems } : {}) }),
        ...(attempt > 1 ? { agentRunId: `${runId}-${attempt}` } : {}),
      });
      if (!done.ok) {
        problems = [done.error];
        break;
      }
      draft = parsePlan(done.summary);
      problems = draft ? checkPlan(draft, spec.acceptanceCriteria.length, repos) : ['the answer had no JSON plan'];
      await log.write({ type: 'plan_checked', attempt, problems });
      if (problems.length === 0) break;
    }
    if (!draft || problems.length > 0) {
      await this.#emit(workItemId, [{ type: 'run_ended', at: this.#clock(), runId, outcome: 'failed' }]);
      await this.#block(wi, `the planner's plan breaks the rules: ${problems.join('; ')}`, onProgress);
      return;
    }
    const ids = new Map(draft.map((t) => [t.key, this.#id('task')]));
    const tasks = draft.map((t) => ({
      taskId: ids.get(t.key)!,
      title: t.title,
      dependsOn: t.dependsOn.map((d) => ids.get(d)!),
      size: t.size,
      description: `${t.description}\n\nCovers acceptance criteri${t.criteria.length > 1 ? 'a' : 'on'} ${t.criteria.join(', ')} of the spec.`,
      ...(t.repo && t.repo !== repos.main ? { repo: t.repo } : {}),
    }));
    await this.#emit(workItemId, [
      { type: 'tasks_planned', at: this.#clock(), tasks },
      { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
    ]);
    const after = await this.#mustLoad(workItemId);
    const mode = this.#gateMode(after, 'plan_check', project.config.gates.planCheck);
    const attempt = after.gateDecisions.filter((d) => d.gate === 'plan_check').length + 1;
    await this.#say(wi.source, planComment(after.proposedTasks, mode, attempt), true);
    onProgress({ kind: 'planned', tasks: after.proposedTasks.map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn })) });
  }

  /** A person decides the spec gate or the plan check from the CLI. */
  async decideWorkItemGate(workItemId: string, input: { by: string; verdict: 'approved' | 'rejected'; reason?: string }): Promise<GateName> {
    const wi = await this.#mustLoad(workItemId);
    const reason = input.reason?.trim() || (input.verdict === 'approved' ? 'approved from the CLI' : '');
    if (input.verdict === 'rejected' && !reason) throw new Error('a rejection needs a reason');
    const said = `**${wi.state === 'awaiting_spec_approval' ? 'Spec' : 'Plan'} ${input.verdict}** by ${input.by} from the CLI${input.verdict === 'rejected' ? `: ${reason}` : '.'}`;
    if (wi.state === 'awaiting_spec_approval') {
      await this.#decideSpec(wi, { mode: 'human', verdict: input.verdict, decidedBy: input.by, reason });
      if (fromTracker(wi)) await this.#say(wi.source, said);
      return 'spec_approval';
    }
    if (wi.state === 'planning' && wi.proposedTasks.length > 0) {
      await this.#decidePlan(wi, { mode: 'human', verdict: input.verdict, decidedBy: input.by, reason });
      if (fromTracker(wi)) await this.#say(wi.source, said);
      return 'plan_check';
    }
    throw new Error(`work item ${workItemId} is ${wi.state}; no spec or plan is waiting for a decision`);
  }

  /** A person lets a blocked work item continue. */
  async resumeWorkItem(workItemId: string, by: string): Promise<void> {
    const wi = await this.#mustLoad(workItemId);
    if (wi.state !== 'blocked') throw new Error(`work item ${workItemId} is ${wi.state}, not blocked`);
    await this.#emit(workItemId, [{ type: 'work_item_unblocked', at: this.#clock() }]);
    if (fromTracker(wi)) await this.#say(wi.source, `Continuing, at @${by}'s request.`);
  }

  /**
   * After the factory was stopped: closes runs that never ended and sends builds that were
   * cut off back to build again. Only for work the caller knows is not running elsewhere.
   */
  async recoverWorkItem(workItemId: string): Promise<string[]> {
    const wi = await this.#mustLoad(workItemId);
    const notes: string[] = [];
    const events: WorkItemEvent[] = [];
    for (const run of wi.runs) {
      if (run.endedAt === undefined) {
        events.push({ type: 'run_ended', at: this.#clock(), runId: run.id, outcome: 'stopped' });
        notes.push(`${run.id} (${run.station}) was cut off`);
      }
    }
    if (!TERMINAL_WORK_ITEM_STATES.has(wi.state) && wi.state !== 'blocked') {
      for (const task of wi.tasks) {
        if (task.state === 'building') {
          events.push({ type: 'task_interrupted', at: this.#clock(), taskId: task.id, reason: 'the factory stopped during the build; building again' });
          notes.push(`${task.id} builds again`);
        }
      }
    }
    if (events.length) await this.#emit(workItemId, events);
    return notes;
  }

  async #specGate(project: Project, wi: WorkItem, onProgress: (p: WorkProgress) => void): Promise<boolean> {
    const spec = wi.spec ?? fail('no spec');
    const mode = this.#gateMode(wi, 'spec_approval', project.config.gates.specApproval);
    if (mode === 'skipped') {
      await this.#decideSpec(wi, { mode, verdict: 'approved', decidedBy: 'factory', reason: 'spec_approval is "skip" in factory.yaml' }, onProgress);
      return true;
    }
    if (mode === 'ai') {
      const doc = (await this.#specs.get(spec.specId, spec.version)) ?? fail('spec not found');
      const item = await this.#tracker().getItem(wi.source);
      const repos = reposSection({ main: project.config.project, related: Object.keys(project.related ?? {}) }).join('\n');
      const check = await this.#check(project, wi, 'spec', `# Spec check\n\n## The request: ${item.title}\n\n${item.body.trim()}${repos ? `\n${repos}` : ''}\n\n## The spec, version ${doc.version}: ${doc.title}\n\n${specBody(doc)}`);
      await this.#decideSpec(wi, { mode, verdict: check.verdict, decidedBy: check.by, reason: check.reasons.join(' ') || 'the spec check passed' }, onProgress);
      await this.#say(wi.source, checkComment('Spec', check));
      return true;
    }
    const decision = await this.#commandFromIssue(wi, gateTag('spec', spec.version));
    if (!decision) return false;
    await this.#decideSpec(wi, { mode: 'human', ...decision }, onProgress);
    return true;
  }

  async #planGate(project: Project, wi: WorkItem, onProgress: (p: WorkProgress) => void): Promise<boolean> {
    const mode = this.#gateMode(wi, 'plan_check', project.config.gates.planCheck);
    if (mode === 'skipped') {
      await this.#decidePlan(wi, { mode, verdict: 'approved', decidedBy: 'factory', reason: 'plan_check is "skip" in factory.yaml' }, onProgress);
      return true;
    }
    if (mode === 'ai') {
      const doc = (await this.#specFor({ specId: wi.spec?.specId ?? '' })) ?? fail('spec not found');
      const name = new Map(wi.proposedTasks.map((t, i) => [t.id, `T${i + 1}`]));
      const plan = wi.proposedTasks
        .map((t) => `### ${name.get(t.id)}: ${t.title} (${t.size}${t.dependsOn.length ? `, after ${t.dependsOn.map((d) => name.get(d)).join(', ')}` : ''}${t.repo ? `, in ${t.repo}` : ''})\n\n${t.description ?? ''}`)
        .join('\n\n');
      const check = await this.#check(project, wi, 'plan', `# Plan check\n\n## The spec: ${doc.title}\n\n${specBody(doc)}\n\n## The plan\n\n${plan}`);
      await this.#decidePlan(wi, { mode, verdict: check.verdict, decidedBy: check.by, reason: check.reasons.join(' ') || 'the plan check passed' }, onProgress);
      await this.#say(wi.source, checkComment('Plan', check));
      return true;
    }
    const attempt = wi.gateDecisions.filter((d) => d.gate === 'plan_check').length + 1;
    const decision = await this.#commandFromIssue(wi, gateTag('plan', attempt));
    if (!decision) return false;
    await this.#decidePlan(wi, { mode: 'human', ...decision }, onProgress);
    return true;
  }

  async #decideSpec(wi: WorkItem, d: { mode: GateMode; verdict: 'approved' | 'rejected'; decidedBy: string; reason: string }, onProgress?: (p: WorkProgress) => void): Promise<void> {
    const spec = wi.spec ?? fail('no spec');
    await this.#emit(wi.id, [{ type: 'gate_decided', at: this.#clock(), decisionId: this.#id('gate'), gate: 'spec_approval', subjectId: spec.specId, ...d }]);
    if (d.verdict === 'approved') await this.#specs.approve(spec.specId, spec.version, { by: d.decidedBy, at: this.#clock() });
    onProgress?.({ kind: 'decided', gate: 'spec_approval', verdict: d.verdict, mode: d.mode, by: d.decidedBy, reason: d.reason });
  }

  async #decidePlan(wi: WorkItem, d: { mode: GateMode; verdict: 'approved' | 'rejected'; decidedBy: string; reason: string }, onProgress?: (p: WorkProgress) => void): Promise<void> {
    await this.#emit(wi.id, [{ type: 'gate_decided', at: this.#clock(), decisionId: this.#id('gate'), gate: 'plan_check', subjectId: wi.id, ...d }]);
    onProgress?.({ kind: 'decided', gate: 'plan_check', verdict: d.verdict, mode: d.mode, by: d.decidedBy, reason: d.reason });
  }

  /** `ai` falls back to a person after the checker rejected twice, so a disagreement can't loop. */
  #gateMode(wi: WorkItem, gate: 'spec_approval' | 'plan_check', configured: GateMode): GateMode {
    if (configured !== 'ai') return configured;
    const rejections = wi.gateDecisions.filter((d) => d.gate === gate && d.mode === 'ai' && d.verdict === 'rejected').length;
    return rejections >= 2 ? 'human' : 'ai';
  }

  /** The last /approve or /reject after `tag` from someone allowed to decide. */
  async #commandFromIssue(wi: WorkItem, tag: string): Promise<{ verdict: 'approved' | 'rejected'; decidedBy: string; reason: string } | undefined> {
    if (!fromTracker(wi)) return undefined;
    const tracker = this.#tracker();
    const item = await tracker.getItem(wi.source);
    const commands = commandsAfter(item.comments, tag).filter((c) => c.kind !== 'retry');
    for (const c of commands.reverse()) {
      if (!(await tracker.canApprove(wi.source, c.by))) continue;
      if (c.kind === 'approve') return { verdict: 'approved', decidedBy: c.by, reason: c.note || 'approved on the issue' };
      if (c.kind === 'reject' && c.reason) return { verdict: 'rejected', decidedBy: c.by, reason: c.reason };
    }
    return undefined;
  }

  /** Answers to the spec agent's questions, or a /retry from someone allowed to decide. */
  async #unblockFromIssue(wi: WorkItem): Promise<string | undefined> {
    if (!fromTracker(wi)) return undefined;
    const tracker = this.#tracker();
    const item = await tracker.getItem(wi.source);
    if (wi.specQuestions && wi.blockedFrom === 'specifying' && wi.blockedReason?.startsWith('waiting for')) {
      const replies = repliesAfter(item.comments, gateTag('questions', 1));
      if (replies.length > 0) {
        await this.#emit(wi.id, [{ type: 'work_item_unblocked', at: this.#clock() }]);
        return replies[0]!.author.handle ?? replies[0]!.author.name;
      }
      return undefined;
    }
    for (const c of commandsAfter(item.comments, 'cradleworks:blocked:').reverse()) {
      if (c.kind === 'retry' && (await tracker.canApprove(wi.source, c.by))) {
        await this.#emit(wi.id, [{ type: 'work_item_unblocked', at: this.#clock() }]);
        return c.by;
      }
    }
    return undefined;
  }

  async #block(wi: WorkItem, reason: string, onProgress: (p: WorkProgress) => void): Promise<void> {
    await this.#emit(wi.id, [{ type: 'work_item_blocked', at: this.#clock(), reason }]);
    onProgress({ kind: 'blocked', reason });
    await this.#say(wi.source, `${gateTag('blocked', `${wi.id}:${wi.version}`)}\n**Stopped, needs a person:** ${reason}\n\nFix what's needed (edit the issue, or answer below), then reply **\`/retry\`**.`, true);
  }

  /** Runs every task that can move, in parallel up to the project's concurrency; returns what it waits on. */
  async #runTasks(project: Project, workItemId: string, onProgress: (p: WorkProgress) => void): Promise<string> {
    const running = new Map<string, Promise<void>>();
    const started = new Set<string>();
    for (;;) {
      const wi = await this.#mustLoad(workItemId);
      if (TERMINAL_WORK_ITEM_STATES.has(wi.state) || wi.state === 'blocked') break;
      for (const task of wi.tasks) {
        if (started.has(task.id) || !canMove(wi, task, projectFor(project, task))) continue;
        started.add(task.id);
        const run = this.#withSlot(project.config.project, project.config.concurrency, () => this.#runOneTask(project, wi, task, onProgress)).finally(() => running.delete(task.id));
        running.set(task.id, run);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    return waitingSummary(await this.#mustLoad(workItemId));
  }

  async #runOneTask(project: Project, wi: WorkItem, task: Task, onProgress: (p: WorkProgress) => void): Promise<void> {
    const target = projectFor(project, task);
    try {
      const outcome = await this.runTask(target, wi.id, task.id, (progress) => {
        onProgress({ kind: 'task', taskId: task.id, title: task.title, progress });
        if (progress.kind === 'built' && progress.outcome.outcome === 'pr_opened' && !progress.outcome.reworked && fromTracker(wi)) {
          void this.#deps.tracker?.link(wi.source, { kind: 'pull_request', url: progress.outcome.pr.url, title: task.title }).catch(() => undefined);
        }
      });
      onProgress({ kind: 'task_stopped', taskId: task.id, title: task.title, outcome });
      if (!fromTracker(wi)) return;
      if (outcome.state === 'escalated' || outcome.state === 'failed') {
        await this.#say(wi.source, `**${task.title}** ${outcome.state === 'failed' ? 'failed' : 'needs a person'}: ${outcome.reason ?? 'see the run log'}${outcome.pr ? ` ([pull request](${outcome.pr.url}))` : ''}\n\n${outcome.state === 'escalated' ? `Give it another go with \`factory retry ${task.id} --note "…"\`, or stop with \`factory cancel ${wi.id}\`.` : `Cancel with \`factory cancel ${wi.id}\`, or file the task again.`}`);
      } else if (outcome.awaitingApproval && outcome.pr) {
        await this.#say(wi.source, `**${task.title}** passed verification and is ready for review: ${outcome.pr.url}. Approve it on the pull request (or \`factory approve ${task.id}\`), or request changes to send it back.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress({ kind: 'task_error', taskId: task.id, title: task.title, error: message });
      if (fromTracker(wi)) await this.#say(wi.source, `**${task.title}** stopped on an error: ${message}`);
    }
  }

  async #withSlot<T>(key: string, size: number, fn: () => Promise<T>): Promise<T> {
    let slot = this.#slots.get(key);
    if (!slot) this.#slots.set(key, (slot = { free: size, waiting: [] }));
    if (slot.free > 0) slot.free--;
    else await new Promise<void>((resolve) => slot!.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = slot.waiting.shift();
      if (next) next();
      else slot.free++;
    }
  }

  /** A read-only agent in a fresh sandbox on the base branch: spec, plan and check agents. */
  async #inspect(
    project: Project,
    wi: WorkItem,
    runId: string,
    log: RunLog,
    opts: { role: AgentRole; station: Station; rolePrompt: (contextFiles: string[]) => string; input: string; agentRunId?: string },
  ): Promise<{ ok: true; summary: string | undefined; cost: number } | { ok: false; error: string; cost: number }> {
    const base = wi.baseBranch ?? project.baseBranch ?? 'main';
    const profile: AgentProfile = { role: opts.role, ...resolveAgent(project.config, opts.role) };
    const tag = `${opts.station}-${shortId(this.#id('run')).slice(4, 12)}`;
    const checkoutDir = join(this.#deps.workRoot, shortId(wi.id), tag);
    let sandbox: SandboxHandle | undefined;
    let step = 'clone';
    try {
      mkdirSync(checkoutDir, { recursive: true });
      const checkout = await this.#deps.sourceControl.clone(project.repo, join(checkoutDir, 'source'), { ref: base });
      await log.write({ type: 'checkout_cloned', path: checkout.path, repo: project.repo.id });
      step = 'sandbox';
      const network = withHosts(project.config.network, this.#deps.runtime.requiredHosts(profile));
      sandbox = await this.#deps.sandbox.create({ taskId: `${shortId(wi.id)}-${tag}`, source: checkout, baseRef: base, branch: `factory/${shortId(wi.id)}-${tag}`, image: project.config.stack.image, network });
      await log.write({ type: 'sandbox_created', sandboxId: sandbox.id, branch: base, baseRef: base, network });
      const pack = buildContextPack(sandbox.workspacePath, project.config.context.rules, this.#deps.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES);
      await log.write({ type: 'context_pack_built', ...pack });
      const contextFiles = pack.files.map((f) => f.path);
      step = 'agent';
      const limits = { maxWallSeconds: this.#deps.stationWallSeconds ?? 900, maxSpendUsd: project.config.budgets.perTaskUsd };
      await log.write({ type: 'agent_started', agent: profile.agent, model: profile.model, limits });
      const done = await this.#runAgent(log, { runId: opts.agentRunId ?? runId, profile, sandbox, rolePrompt: opts.rolePrompt(contextFiles), input: opts.input, contextFiles, tools: { allow: [], deny: READ_ONLY }, limits });
      const cost = done?.total.costUsd ?? 0;
      if (done?.outcome !== 'succeeded') return { ok: false, error: `the ${opts.role} agent run ${done?.outcome ?? 'ended without a result'}${done?.error ? `: ${done.error}` : ''}`, cost };
      return { ok: true, summary: done.summary, cost };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await log.write({ type: 'step_failed', step, error: message });
      return { ok: false, error: `${step}: ${message}`, cost: 0 };
    } finally {
      if (sandbox) {
        await this.#deps.sandbox.destroy(sandbox).catch(() => undefined);
        await log.write({ type: 'sandbox_destroyed', sandboxId: sandbox.id }).catch(() => undefined);
      }
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  }

  /** The ai gate for a spec or plan: a checker agent, in its own run. */
  async #check(project: Project, wi: WorkItem, what: 'spec' | 'plan', input: string): Promise<{ verdict: 'approved' | 'rejected'; reasons: string[]; by: string }> {
    const runId = this.#id('run');
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile: AgentProfile = { role: 'reviewer', ...resolveAgent(project.config, 'reviewer') };
    const station: Station = what === 'spec' ? 'approve_spec' : 'plan';
    await this.#emit(wi.id, [{ type: 'run_started', at: this.#clock(), runId, subjectId: wi.id, station, agentProfile: profile }]);
    await log.write({ type: 'run_context', workItemId: wi.id, taskId: wi.id, station: `${what}_check` });
    const done = await this.#inspect(project, wi, runId, log, { role: 'reviewer', station, rolePrompt: () => checkerPrompt(what), input });
    const verdict = done.ok ? parseCheck(done.summary) : { verdict: 'rejected' as const, reasons: [`The ${what} check could not run: ${done.error}`] };
    await log.write({ type: 'check_decided', what, ...verdict });
    await this.#emit(wi.id, [{ type: 'run_ended', at: this.#clock(), runId, outcome: done.ok ? 'succeeded' : 'failed' }]);
    return { ...verdict, by: `${what} checker (${profile.model})` };
  }

  /** The tester agent writes acceptance tests on the base branch, from the spec, never seeing the diff. */
  async #writeAcceptanceTests(
    project: Project,
    workItemId: string,
    task: Task,
    spec: SpecDocument,
    checkout: WorkingCopy,
    base: string,
    runId: string,
    log: RunLog,
  ): Promise<{ tests?: { runId: string; files: string[]; patch: string }; cost: number }> {
    const profile: AgentProfile = { role: 'tester', ...resolveAgent(project.config, 'tester') };
    const tag = shortId(runId).slice(4, 12);
    let sandbox: SandboxHandle | undefined;
    try {
      const network = withHosts(project.config.network, this.#deps.runtime.requiredHosts(profile));
      sandbox = await this.#deps.sandbox.create({ taskId: `${shortId(task.id)}-tester-${tag}`, source: checkout, baseRef: base, branch: `factory/${shortId(task.id)}-tests-${tag}`, image: project.config.stack.image, network });
      await log.write({ type: 'sandbox_created', sandboxId: sandbox.id, branch: base, baseRef: base, network });
      const pack = buildContextPack(sandbox.workspacePath, project.config.context.rules, this.#deps.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES);
      const contextFiles = pack.files.map((f) => f.path);
      const limits = { maxWallSeconds: this.#deps.stationWallSeconds ?? 900, maxSpendUsd: project.config.budgets.perTaskUsd };
      await log.write({ type: 'agent_started', agent: profile.agent, model: profile.model, limits });
      const done = await this.#runAgent(log, { runId: `${runId}-tester`, profile, sandbox, rolePrompt: testerPrompt(project.config, contextFiles), input: testerInput(spec, task), contextFiles, tools: { allow: [], deny: [] }, limits });
      const cost = done?.total.costUsd ?? 0;
      if (done?.outcome !== 'succeeded') {
        await log.write({ type: 'acceptance_tests', files: [], note: `the tester run ${done?.outcome ?? 'ended without a result'}` });
        return { cost };
      }
      // Git's own files are read-only in the sandbox, so new files are diffed without the index.
      const names = await this.#deps.sandbox.exec(sandbox, ['sh', '-c', 'git diff --name-only; git ls-files --others --exclude-standard']);
      const patch = await this.#deps.sandbox.exec(sandbox, ['sh', '-c', 'git diff --binary; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --binary --no-index /dev/null {}; true']);
      const files = [...new Set(names.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
      const tests = { runId, files, patch: files.length ? patch.stdout : '' };
      await this.#emit(workItemId, [{ type: 'task_acceptance_tests_written', at: this.#clock(), taskId: task.id, ...tests }]);
      await log.write({ type: 'acceptance_tests', files });
      return { tests, cost };
    } finally {
      if (sandbox) {
        await this.#deps.sandbox.destroy(sandbox).catch(() => undefined);
        await log.write({ type: 'sandbox_destroyed', sandboxId: sandbox.id }).catch(() => undefined);
      }
    }
  }

  async #specFor(task: { specId: string }): Promise<SpecDocument | undefined> {
    if (!task.specId) return undefined;
    return this.#specs.get(task.specId);
  }

  #tracker(): Tracker {
    return this.#deps.tracker ?? fail('this factory has no tracker configured');
  }

  /** Posts on the work item's issue; reporting never stops the work. */
  async #say(item: ItemRef, body: string, important = false): Promise<void> {
    if (!this.#deps.tracker || item.id.startsWith('submitted:')) return;
    try {
      await this.#deps.tracker.comment(item, body);
    } catch (error) {
      if (important) throw error;
    }
  }

  async #showStatus(wi: WorkItem): Promise<void> {
    if (!this.#deps.tracker || !fromTracker(wi)) return;
    const status = wi.state as FactoryStatus;
    if (this.#statusShown.get(wi.id) === status) return;
    try {
      await this.#deps.tracker.setStatus(wi.source, status);
      this.#statusShown.set(wi.id, status);
    } catch {
      // Labels are a courtesy; the event log is the record.
    }
  }

  async #announceEnd(wi: WorkItem): Promise<void> {
    if (!this.#deps.tracker || !fromTracker(wi) || this.#announced.has(wi.id)) return;
    this.#announced.add(wi.id);
    const tag = gateTag('blocked', 'done').replace('blocked', 'done');
    const item = await this.#deps.tracker.getItem(wi.source).catch(() => undefined);
    if (!item || item.comments.some((c) => c.byFactory && c.body.includes(tag))) return;
    const merged = wi.tasks.filter((t) => t.state === 'merged');
    const text =
      wi.state === 'merged'
        ? `Done: ${merged.length} pull request${merged.length > 1 ? 's' : ''} merged.\n\n${merged.map((t) => `- ${t.title}${t.pr ? `: ${t.pr.url}` : ''}`).join('\n')}`
        : `Stopped: ${wi.state}${wi.endReason ? ` (${wi.endReason})` : ''}.`;
    await this.#say(wi.source, `${tag}\n${text}`);
  }

  /** A person approves a ready task at the change gate; merges when asked or when auto_merge is on. */
  async approveTask(project: Project, workItemId: string, taskId: string, input: { by: string; reason?: string; merge?: boolean }): Promise<{ merged?: string }> {
    const wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    if (task.state !== 'ready') throw new Error(`task ${taskId} is ${task.state}; only a ready task can be approved`);
    if (!task.changeApproved) {
      await this.#decideChange(wi, task, { mode: 'human', verdict: 'approved', decidedBy: input.by, reason: input.reason?.trim() || 'approved from the CLI' });
    }
    if (input.merge || project.config.gates.autoMerge) return { merged: await this.mergeTask(project, workItemId, taskId) };
    return {};
  }

  /** A person sends a ready task back at the change gate; the reason becomes rework feedback. */
  async rejectTask(workItemId: string, taskId: string, input: { by: string; reason: string }): Promise<void> {
    if (input.reason.trim() === '') throw new Error('a rejection needs a reason');
    const wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    if (task.state !== 'ready') throw new Error(`task ${taskId} is ${task.state}; only a ready task can be rejected`);
    await this.#decideChange(wi, task, { mode: 'human', verdict: 'rejected', decidedBy: input.by, reason: input.reason.trim() });
  }

  /** Gives an escalated task more attempts; `note` reaches the implementer as feedback. */
  async retryTask(workItemId: string, taskId: string, input: { by: string; extraLoops?: number; note?: string }): Promise<void> {
    const wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    if (task.state !== 'escalated') throw new Error(`task ${taskId} is ${task.state}; only an escalated task can be retried`);
    const note =
      input.note?.trim() ||
      (task.pr ? `A person granted another attempt after: ${task.lastReason ?? 'an escalation'}` : 'A person read your reason for not changing anything and wants the change made.');
    await this.#emit(wi.id, [{ type: 'task_retry_granted', at: this.#clock(), taskId, grantedBy: input.by, extraLoops: input.extraLoops ?? 1, note }]);
  }

  async cancelWorkItem(workItemId: string, reason: string): Promise<void> {
    const wi = await this.#mustLoad(workItemId);
    await this.#emit(wi.id, [{ type: 'work_item_cancelled', at: this.#clock(), reason: reason.trim() || 'cancelled from the CLI' }]);
  }

  /** Merges an approved task's PR, refusing if its head moved since Verify passed it. */
  async mergeTask(project: Project, workItemId: string, taskId: string): Promise<string> {
    const wi = await this.#mustLoad(workItemId);
    const task = findTask(wi, taskId);
    if (task.state !== 'ready' || !task.changeApproved) throw new Error(`task ${taskId} has not passed the change gate`);
    const pr = task.pr ?? fail(`task ${taskId} has no pull request`);
    const verified = task.evidence?.sha ?? fail(`task ${taskId} has no verified commit`);
    const status = await this.#deps.sourceControl.getPRStatus(pr);
    let sha: string;
    if (status.state === 'merged') {
      sha = status.headSha;
    } else {
      if (status.state !== 'open') throw new Error(`pull request ${pr.url} is closed`);
      if (status.headSha !== verified) {
        throw new Error(`the pull request head moved since it was verified (verified ${verified.slice(0, 12)}, now ${status.headSha.slice(0, 12)}); not merging`);
      }
      // One merge at a time per repository: parallel tasks finish together, and a hosted
      // merge can refuse while the base branch is moving under it.
      sha = await this.#withSlot(`merge:${project.repo.id}`, 1, async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return (await this.#deps.sourceControl.merge(pr, { method: 'squash', expectedHeadSha: verified })).sha;
          } catch (error) {
            if (attempt >= 3 || !(error instanceof AdapterError) || error.code !== 'conflict' || !/base|lock|modified/i.test(error.message)) throw error;
          }
        }
      });
    }
    await this.#emit(wi.id, [{ type: 'task_merged', at: this.#clock(), taskId, sha }]);
    return sha;
  }

  /**
   * Brings tasks in line with their pull requests: an approving review after Verify passes
   * the change gate, a requested change sends the task back, a merge or close done by a
   * person on the PR is recorded. Returns one line per change made.
   */
  async syncWorkItem(project: Project, workItemId: string): Promise<string[]> {
    const notes: string[] = [];
    const wi = await this.#mustLoad(workItemId);
    for (const task of wi.tasks) {
      if (!task.pr || ['merged', 'failed', 'cancelled'].includes(task.state)) continue;
      const status = await this.#deps.sourceControl.getPRStatus(task.pr);
      const current = findTask((await this.#mustLoad(workItemId)), task.id);
      if (status.state === 'closed') {
        await this.#emit(workItemId, [{ type: 'task_cancelled', at: this.#clock(), taskId: task.id, reason: 'pull request closed without merging' }]);
        notes.push(`${task.id}: pull request closed; task cancelled`);
        continue;
      }
      if (current.state !== 'ready') {
        if (status.state === 'merged') notes.push(`${task.id}: merged on the pull request while ${current.state}; not recorded`);
        continue;
      }
      const since = current.evidence?.verifiedAt ?? '';
      const latest = new Map<string, (typeof status.reviews)[number]>();
      for (const r of status.reviews) if (r.at > since && r.verdict !== 'commented') latest.set(r.author.handle ?? r.author.name, r);
      const reviews = [...latest.values()];
      const changes = reviews.find((r) => r.verdict === 'changes_requested');
      const approval = reviews.find((r) => r.verdict === 'approved');
      if (!current.changeApproved) {
        if (status.state === 'merged') {
          await this.#decideChange(await this.#mustLoad(workItemId), current, { mode: 'human', verdict: 'approved', decidedBy: approval?.author.handle ?? 'pull request', reason: 'merged on the pull request' });
        } else if (changes && project.config.gates.changeApproval === 'human') {
          await this.#decideChange(await this.#mustLoad(workItemId), current, { mode: 'human', verdict: 'rejected', decidedBy: changes.author.handle ?? changes.author.name, reason: changes.body.trim() || 'changes requested on the pull request' });
          notes.push(`${task.id}: changes requested by ${changes.author.handle ?? changes.author.name}; back to rework`);
          continue;
        } else if (approval && project.config.gates.changeApproval === 'human') {
          await this.#decideChange(await this.#mustLoad(workItemId), current, { mode: 'human', verdict: 'approved', decidedBy: approval.author.handle ?? approval.author.name, reason: 'approving review on the pull request' });
          notes.push(`${task.id}: approved by ${approval.author.handle ?? approval.author.name}`);
        } else {
          continue;
        }
      }
      if (status.state === 'merged') {
        await this.#emit(workItemId, [{ type: 'task_merged', at: this.#clock(), taskId: task.id, sha: status.headSha }]);
        notes.push(`${task.id}: merged on the pull request`);
      } else if (project.config.gates.autoMerge) {
        const sha = await this.mergeTask(project, workItemId, task.id);
        notes.push(`${task.id}: merged ${sha.slice(0, 12)}`);
      }
    }
    return notes;
  }

  async #decideChange(
    wi: WorkItem,
    task: Task,
    d: { mode: 'human' | 'ai' | 'skipped'; verdict: 'approved' | 'rejected'; decidedBy: string; reason: string },
  ): Promise<void> {
    await this.#emit(wi.id, [
      { type: 'gate_decided', at: this.#clock(), decisionId: this.#id('gate'), gate: 'change_approval', subjectId: task.id, mode: d.mode, decidedBy: d.decidedBy, verdict: d.verdict, reason: d.reason },
    ]);
  }

  /** Runs one agent to completion, logging every event; returns its `done` event. */
  async #runAgent(log: RunLog, request: Parameters<AgentRuntime['start']>[0]): Promise<Extract<AgentEvent, { type: 'done' }> | undefined> {
    const run = await this.#deps.runtime.start(request);
    let done: Extract<AgentEvent, { type: 'done' }> | undefined;
    for await (const event of run.events) {
      await log.write({ type: 'agent_event', event });
      if (event.type === 'done') done = event;
    }
    return done;
  }

  async #fail(wi: WorkItem, log: RunLog, runId: string, taskId: string, step: string, reason: string, outcome: AgentOutcome): Promise<BuildOutcome> {
    await log.write({ type: 'step_failed', step, error: reason });
    await this.#emit(wi.id, [
      { type: 'task_failed', at: this.#clock(), taskId, reason: `${step}: ${reason}` },
      { type: 'run_ended', at: this.#clock(), runId, outcome: outcome === 'succeeded' ? 'failed' : outcome },
    ]);
    return { outcome: 'failed', reason: `${step}: ${reason}`, runId };
  }

  /**
   * Appends to a work item's stream on top of its latest state. Appends to one work item
   * are serialised, so tasks running in parallel never race; a conflict with another
   * process (a CLI command while \`watch\` runs) is retried on the reloaded state.
   */
  async #emit(workItemId: string, events: WorkItemEvent[]): Promise<WorkItem> {
    const previous = this.#locks.get(workItemId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 0; ; attempt++) {
          const current = await this.#mustLoad(workItemId);
          try {
            return await this.#repo.append(current, events);
          } catch (error) {
            if (error instanceof AdapterError && error.code === 'conflict' && attempt < 5) continue;
            throw error;
          }
        }
      });
    this.#locks.set(workItemId, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(workItemId) === run) this.#locks.delete(workItemId);
    }
  }

  async #mustLoad(workItemId: string): Promise<WorkItem> {
    const wi = await this.#repo.load(workItemId);
    if (!wi) throw new Error(`no work item ${workItemId}`);
    return wi;
  }
}

function outcomeOf(task: Task, awaitingApproval: boolean): TaskOutcome {
  return {
    state: task.state,
    awaitingApproval,
    ...(task.pr ? { pr: task.pr } : {}),
    ...(task.branch ? { branch: task.branch } : {}),
    ...(task.lastReason ? { reason: task.lastReason } : {}),
    ...(task.evidence ? { evidence: task.evidence } : {}),
  };
}

function fail(message: string): never {
  throw new Error(message);
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

function reviewInput(task: Task, checks: Evidence['checks'], spec?: SpecDocument): string {
  const lines = [`# Task: ${task.title}`, '', task.description?.trim() || '_(no description)_'];
  if (spec) lines.push('', `## The spec this task is part of: ${spec.title}`, '', specBody(spec), '', 'Judge this task against the criteria it covers; other tasks cover the rest.');
  lines.push('', '## Project checks on this branch');
  for (const c of checks) lines.push(`- \`${c.name}\` (\`${c.command}\`): ${c.outcome}${c.flaky ? ' (failed once, passed on a second run)' : ''}`);
  return lines.join('\n');
}

function commitMessage(task: Task, workItemId: string, runId: string, reworkAttempt?: number): string {
  const subject = reworkAttempt ? `${task.title} (rework ${reworkAttempt - 1})` : task.title;
  return `${subject}\n\nFactory task ${task.id} (work item ${workItemId}), run ${runId}.`;
}

function prBody(taskBody: string, summary: string | undefined, workItemId: string, taskId: string, runId: string, contextFiles: string[], issueUrl?: string): string {
  return [
    ...(issueUrl ? [`Part of ${issueUrl}`, ''] : []),
    '## Task',
    taskBody.trim() || '_(no description)_',
    '',
    '## Agent summary',
    summary?.trim() || '_(the agent gave no summary)_',
    '',
    '## Factory',
    `- Work item: \`${workItemId}\``,
    `- Task: \`${taskId}\``,
    `- Run: \`${runId}\` (replay with \`factory log ${runId}\`)`,
    `- Context files: ${contextFiles.length > 0 ? contextFiles.map((f) => `\`${f}\``).join(', ') : 'none'}`,
    '',
    '_Opened by Cradleworks. Verification results follow as comments._',
  ].join('\n');
}

// --- the issue flow's helpers -------------------------------------------------------

/** Progress reports from `runWorkItem`, for a CLI to print as they happen. */
export type WorkProgress =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'spec'; version: number; title: string; criteria: number }
  | { kind: 'decided'; gate: GateName; verdict: 'approved' | 'rejected'; mode: GateMode; by: string; reason: string }
  | { kind: 'planned'; tasks: Array<{ id: string; title: string; dependsOn: string[] }> }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unblocked'; by: string }
  | { kind: 'task'; taskId: string; title: string; progress: Progress }
  | { kind: 'task_stopped'; taskId: string; title: string; outcome: TaskOutcome }
  | { kind: 'task_error'; taskId: string; title: string; error: string }
  | { kind: 'done'; state: WorkItemState };

export interface WorkItemOutcome {
  state: WorkItemState;
  /** What the work item waits on, when it hasn't ended. */
  waitingFor?: string;
}

/** Tools a read-only agent may not use. */
const READ_ONLY = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

/** The branch the issue named, in every repository the work touches; else the project's default. */
function baseFor(project: Project, wi: WorkItem, _task: Task): string {
  return wi.baseBranch ?? project.baseBranch ?? 'main';
}

function fromTracker(wi: WorkItem): boolean {
  return !wi.source.id.startsWith('submitted:');
}

function projectFor(project: Project, task: Task): Project {
  if (!task.repo || task.repo === project.config.project) return project;
  return project.related?.[task.repo] ?? fail(`task ${task.id} is for ${task.repo}, which is not a related repo of ${project.config.project}`);
}

function lastRejection(wi: WorkItem, gate: GateName): string | undefined {
  const last = wi.gateDecisions.filter((d) => d.gate === gate).at(-1);
  return last?.verdict === 'rejected' ? `${last.reason} (${last.decidedBy})` : undefined;
}

function specFileName(wi: WorkItem, spec: SpecDocument): string {
  const issue = /#(\d+)$/.exec(wi.source.id)?.[1];
  return `${issue ? `issue-${issue}` : shortId(spec.id)}-${slug(spec.title)}.md`;
}

/** Whether the scheduler has something to do for this task right now. */
function canMove(wi: WorkItem, task: Task, project: Project): boolean {
  switch (task.state) {
    case 'queued':
      return task.dependsOn.every((d) => wi.tasks.find((t) => t.id === d)?.state === 'merged');
    case 'rework':
    case 'verifying':
      return true;
    case 'ready':
      return task.changeApproved ? project.config.gates.autoMerge : project.config.gates.changeApproval !== 'human';
    default:
      return false;
  }
}

function waitingSummary(wi: WorkItem): string {
  const count = (pred: (t: Task) => boolean) => wi.tasks.filter(pred).length;
  const parts: string[] = [];
  const review = count((t) => t.state === 'ready' && !t.changeApproved);
  const merge = count((t) => t.state === 'ready' && t.changeApproved);
  const escalated = count((t) => t.state === 'escalated');
  const failed = count((t) => t.state === 'failed');
  const blocked = count((t) => t.state === 'queued');
  if (review) parts.push(`${review} ready for review`);
  if (merge) parts.push(`${merge} approved, to merge`);
  if (escalated) parts.push(`${escalated} escalated`);
  if (failed) parts.push(`${failed} failed`);
  if (blocked) parts.push(`${blocked} waiting on ${blocked > 1 ? 'their' : 'its'} dependencies`);
  return parts.length ? `tasks: ${parts.join(', ')}` : 'nothing';
}

function checkComment(what: 'Spec' | 'Plan', check: { verdict: 'approved' | 'rejected'; reasons: string[]; by: string }): string {
  const head = check.verdict === 'approved' ? `**${what} check passed** (${check.by}).` : `**${what} check sent it back** (${check.by}); writing a new version.`;
  return [head, ...check.reasons.map((r) => `- ${r}`)].join('\n');
}

/** The project's test command with the tester's tests applied on top of the branch; removed afterwards. */
async function runAcceptance(sandboxes: Sandbox, sandbox: SandboxHandle, tests: { files: string[]; patch: string }, testCommand: string, timeoutSeconds: number): Promise<CheckResult> {
  const command = `${testCommand} (with the tester's tests: ${tests.files.join(', ')})`;
  const started = Date.now();
  const applied = await sandboxes.exec(sandbox, ['git', 'apply', '--whitespace=nowarn', '-'], { stdin: tests.patch });
  if (applied.exitCode !== 0) {
    return { name: 'acceptance', command, outcome: 'skipped', durationMs: Date.now() - started, outputTail: `The tester's tests did not apply to this branch, so they were not run:\n${tail(applied.stderr || applied.stdout)}` };
  }
  try {
    const run = () => sandboxes.exec(sandbox, ['sh', '-c', testCommand], { timeoutSeconds });
    let r = await run();
    let flaky = false;
    if (r.exitCode !== 0 && !r.timedOut) {
      const again = await run();
      if (again.exitCode === 0) flaky = true;
      else r = again;
    }
    const outcome = r.timedOut ? 'timed_out' : r.exitCode === 0 || flaky ? 'passed' : 'failed';
    return {
      name: 'acceptance',
      command,
      outcome,
      exitCode: flaky ? 0 : r.exitCode,
      durationMs: Date.now() - started,
      ...(outcome !== 'passed' ? { outputTail: tail(`${r.stdout}\n${r.stderr}`) } : {}),
      ...(flaky ? { flaky: true } : {}),
    };
  } finally {
    await sandboxes.exec(sandbox, ['git', 'apply', '-R', '--whitespace=nowarn', '-'], { stdin: tests.patch }).catch(() => undefined);
  }
}

function tail(text: string): string {
  const lines = text.trimEnd().split('\n').slice(-60).join('\n');
  return lines.length > 6000 ? lines.slice(-6000) : lines;
}

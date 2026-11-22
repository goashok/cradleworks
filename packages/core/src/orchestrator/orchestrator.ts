// The orchestrator drives a work item through the stations. Through M2 it accepts a
// hand-written task (the spec and plan stations are M3), runs Build and Verify in a loop
// until the change passes or needs a human, and applies the change gate.
// Every decision lands in the work item's stream; every step lands in the run's stream.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterError,
  type AgentEvent,
  type AgentOutcome,
  type AgentProfile,
  type AgentRuntime,
  type CI,
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
import type { CiResult, Evidence, ReviewResult, Task, TaskState, VerifyVerdict, WorkItem } from '../domain/types.ts';
import { buildContextPack, DEFAULT_CONTEXT_BUDGET_BYTES } from './context-pack.ts';
import { implementerPrompt, reviewerPrompt } from './prompts.ts';
import { RunLog } from './run-log.ts';
import { combine, evidenceMarkdown, parseReview, reworkFeedback, runChecks, waitForCi, type CiWaitOptions } from './verify.ts';
import { WorkItemRepository } from './work-item-repository.ts';

export interface OrchestratorDeps {
  store: StateStore;
  sourceControl: SourceControl;
  sandbox: Sandbox;
  runtime: AgentRuntime;
  /** CI for the Verify station; absent = the project has none. */
  ci?: CI;
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
    const base = project.baseBranch ?? 'main';
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile = { role: 'implementer' as const, ...resolveAgent(project.config, 'implementer') };
    const attempt = task.reworkLoops + task.gateReworks + 1;

    wi = await this.#repo.append(wi, [
      { type: 'run_started', at: this.#clock(), runId, subjectId: taskId, station: 'build', agentProfile: profile },
      rework ? { type: 'task_rework_started', at: this.#clock(), taskId } : { type: 'task_started', at: this.#clock(), taskId, branch },
    ]);
    await log.write({ type: 'run_context', workItemId, taskId, station: 'build', attempt });

    // A new folder per run, never a reused or recreated one: Docker Desktop's file sharing can
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

      step = 'agent';
      const taskText = `# ${task.title}\n\n${task.description ?? ''}`.trim();
      const humanNote = task.lastReason && task.lastReason !== task.evidence?.reason ? task.lastReason : undefined;
      const input = rework ? `${taskText}\n\n${reworkFeedback(task.evidence, humanNote, attempt)}` : taskText;
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
          await this.#repo.append(wi, [
            { type: 'task_declined', at: this.#clock(), taskId, reason },
            { type: 'run_ended', at: this.#clock(), runId, outcome: 'succeeded' },
          ]);
          return { outcome: 'declined', reason, runId };
        }
        throw error;
      }
      await log.write({ type: 'changes_committed', sha });

      step = 'push';
      await this.#deps.sourceControl.push(copy, branch);
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
          body: prBody(task.description ?? '', done?.summary, workItemId, taskId, runId, contextFiles),
          labels: [],
        });
        await log.write({ type: 'pr_opened', id: pr.id, url: pr.url });
        events.push({ type: 'task_pr_opened', at: this.#clock(), taskId, pr });
      }

      await this.#repo.append(wi, [
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
    const base = project.baseBranch ?? 'main';
    const runId = this.#id('run');
    const log = new RunLog(this.#deps.store, runId, this.#clock);
    const profile: AgentProfile = { role: 'reviewer', ...resolveAgent(project.config, 'reviewer') };
    const attempt = task.reworkLoops + task.gateReworks + 1;

    wi = await this.#repo.append(wi, [{ type: 'run_started', at: this.#clock(), runId, subjectId: taskId, station: 'verify', agentProfile: profile }]);
    await log.write({ type: 'run_context', workItemId, taskId, station: 'verify', attempt });

    // A new folder per run, never a reused or recreated one: Docker Desktop's file sharing can
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
      const checksPassed = checks.every((c) => c.outcome === 'passed' || c.outcome === 'skipped');

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
          input: reviewInput(task, checks),
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
      wi = await this.#repo.append(wi, [
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
      const latest = (await this.#repo.load(wi.id)) ?? wi;
      await this.#repo.append(latest, [
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
    await this.#repo.append(wi, [{ type: 'task_retry_granted', at: this.#clock(), taskId, grantedBy: input.by, extraLoops: input.extraLoops ?? 1, note }]);
  }

  async cancelWorkItem(workItemId: string, reason: string): Promise<void> {
    const wi = await this.#mustLoad(workItemId);
    await this.#repo.append(wi, [{ type: 'work_item_cancelled', at: this.#clock(), reason: reason.trim() || 'cancelled from the CLI' }]);
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
      sha = (await this.#deps.sourceControl.merge(pr, { method: 'squash', expectedHeadSha: verified })).sha;
    }
    await this.#repo.append(wi, [{ type: 'task_merged', at: this.#clock(), taskId, sha }]);
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
        await this.#repo.append(await this.#mustLoad(workItemId), [{ type: 'task_cancelled', at: this.#clock(), taskId: task.id, reason: 'pull request closed without merging' }]);
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
        await this.#repo.append(await this.#mustLoad(workItemId), [{ type: 'task_merged', at: this.#clock(), taskId: task.id, sha: status.headSha }]);
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
    await this.#repo.append(wi, [
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

function reviewInput(task: Task, checks: Evidence['checks']): string {
  const lines = [`# Task: ${task.title}`, '', task.description?.trim() || '_(no description)_', '', '## Project checks on this branch'];
  for (const c of checks) lines.push(`- \`${c.name}\` (\`${c.command}\`): ${c.outcome}${c.flaky ? ' (failed once, passed on a second run)' : ''}`);
  return lines.join('\n');
}

function commitMessage(task: Task, workItemId: string, runId: string, reworkAttempt?: number): string {
  const subject = reworkAttempt ? `${task.title} (rework ${reworkAttempt - 1})` : task.title;
  return `${subject}\n\nFactory task ${task.id} (work item ${workItemId}), run ${runId}.`;
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
    `- Run: \`${runId}\` (replay with \`factory log ${runId}\`)`,
    `- Context files: ${contextFiles.length > 0 ? contextFiles.map((f) => `\`${f}\``).join(', ') : 'none'}`,
    '',
    '_Opened by Cradleworks. Verification results follow as comments._',
  ].join('\n');
}

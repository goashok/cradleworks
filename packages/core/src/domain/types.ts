// The core's domain model (Build spec, section 4). Entities hold opaque references
// into external systems but no vendor-specific fields.

import type { AgentProfile, ExternalRef, GateName, Timestamp } from '@cradleworks/interfaces';

export type WorkItemState =
  | 'received'
  | 'specifying'
  | 'awaiting_spec_approval'
  | 'planning'
  | 'in_progress'
  | 'awaiting_change_approval'
  | 'merged'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type TaskState =
  | 'queued'
  | 'building'
  | 'verifying'
  | 'rework'
  | 'ready'
  | 'merged'
  | 'escalated'
  | 'budget_exceeded'
  | 'failed'
  | 'cancelled';

export type TaskSize = 'small' | 'medium' | 'large';

export type Station =
  | 'intake'
  | 'specify'
  | 'approve_spec'
  | 'plan'
  | 'build'
  | 'verify'
  | 'approve_change'
  | 'merge';

export type GateMode = 'human' | 'ai' | 'skipped';
export type GateVerdict = 'approved' | 'rejected';

export interface GateDecision {
  id: string;
  gate: GateName;
  /** Spec id for spec_approval, work item id for plan_check, task id for change_approval. */
  subjectId: string;
  mode: GateMode;
  decidedBy: string;
  verdict: GateVerdict;
  reason: string;
  at: Timestamp;
}

export interface SpecPointer {
  specId: string;
  version: number;
  approved: boolean;
}

export interface Task {
  id: string;
  specId: string;
  title: string;
  dependsOn: string[];
  size: TaskSize;
  description?: string;
  state: TaskState;
  branch?: string;
  pr?: ExternalRef;
  /** Verify → Build loops so far; escalates past the work item's limit. */
  reworkLoops: number;
  /** Rework requested at the change gate; not limited. */
  gateReworks: number;
  /** Extra loops a human granted after an escalation. */
  extraLoops: number;
  changeApproved: boolean;
  /** State to return to when an exceeded budget is extended. */
  resumeState?: 'building' | 'verifying';
  /** Model spend on this task so far, every attempt and agent together. */
  spentUsd: number;
  /** The task's spend limit, when someone raised it above the project's `per_task_usd`. */
  budgetUsd?: number;
  mergedSha?: string;
  lastReason?: string;
  /** The latest Verify result, the basis for rework feedback and the change gate. */
  evidence?: Evidence;
  /** Project the task changes, when it isn't the work item's own. */
  repo?: string;
  /** The tester agent's tests, written from the spec before it saw the diff. */
  acceptanceTests?: { runId: string; files: string[]; patch: string };
}

/** What Verify found for one commit of a task (Build spec, section 4). */
export interface Evidence {
  /** The verify run that produced it. */
  runId: string;
  /** The commit that was verified; a merge is refused if the PR head has moved. */
  sha: string;
  checks: CheckResult[];
  ci: CiResult;
  review?: ReviewResult;
  verdict: VerifyVerdict;
  /** One line, for status and the event log. */
  reason: string;
  costUsd: number;
  verifiedAt: Timestamp;
}

export type VerifyVerdict = 'pass' | 'rework' | 'escalate';

export interface CheckResult {
  /** The stack command's name: build, test, lint, or a project-defined one. */
  name: string;
  command: string;
  outcome: 'passed' | 'failed' | 'timed_out' | 'skipped';
  exitCode?: number;
  durationMs: number;
  /** The last lines of output, for rework feedback. */
  outputTail?: string;
  /** Passed only when run a second time. */
  flaky?: boolean;
}

export interface CiResult {
  state: 'passed' | 'failed' | 'timed_out' | 'none' | 'not_configured' | 'skipped' | 'error';
  runs: Array<{ id: string; url: string; state: string; failedJobs: string[] }>;
  /** Log tails of failed jobs. */
  failureLogs?: string;
  note?: string;
}

export interface ReviewResult {
  verdict: VerifyVerdict;
  risk: 'low' | 'medium' | 'high';
  reasons: string[];
  model: string;
}

export type RunOutcome = 'succeeded' | 'failed' | 'stopped' | 'timed_out' | 'limit_reached';

export interface Run {
  id: string;
  /** Task id, or the work item id for work-item-level stations. */
  subjectId: string;
  station: Station;
  agentProfile?: AgentProfile;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  outcome?: RunOutcome;
}

export interface WorkItem {
  id: string;
  source: ExternalRef;
  requester: string;
  projectId: string;
  title: string;
  state: WorkItemState;
  /** State to return to when unblocked. */
  blockedFrom?: WorkItemState;
  blockedReason?: string;
  maxReworkLoops: number;
  /** Branch the work starts from and merges into, when not the project's default. */
  baseBranch?: string;
  spec?: SpecPointer;
  /** Questions the spec agent asked; it asks one round at most. */
  specQuestions?: string[];
  /** Plan awaiting the plan check; moved to `tasks` once approved. */
  proposedTasks: Task[];
  /** Model spend on the work item so far, its own agents and its tasks'. */
  spentUsd: number;
  tasks: Task[];
  gateDecisions: GateDecision[];
  runs: Run[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Number of events folded into this state. */
  version: number;
  endReason?: string;
}

export const TERMINAL_WORK_ITEM_STATES: ReadonlySet<WorkItemState> = new Set(['merged', 'failed', 'cancelled']);
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['merged', 'failed', 'cancelled']);

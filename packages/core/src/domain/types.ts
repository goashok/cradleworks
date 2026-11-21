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
  mergedSha?: string;
  lastReason?: string;
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
  spec?: SpecPointer;
  /** Plan awaiting the plan check; moved to `tasks` once approved. */
  proposedTasks: Task[];
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

// Every change to a work item is one of these events, appended to the work item's stream.
// Agent-level events (tool calls, usage) go to each run's own stream instead.

import type { AgentProfile, ExternalRef, GateName, Timestamp } from '@cradleworks/interfaces';
import type { Evidence, GateMode, GateVerdict, RunOutcome, Station, TaskSize } from './types.ts';

interface Base {
  at: Timestamp;
}

export interface PlannedTask {
  taskId: string;
  title: string;
  dependsOn: string[];
  size: TaskSize;
  /** Markdown: what to change and how to tell it is done. */
  description?: string;
  /** Project the task changes, when it isn't the work item's own (a related repo). */
  repo?: string;
}

export type WorkItemEvent =
  | (Base & {
      type: 'work_item_received';
      workItemId: string;
      source: ExternalRef;
      requester: string;
      projectId: string;
      title: string;
      maxReworkLoops: number;
      /** Branch the work starts from and merges into; default the project's. */
      baseBranch?: string;
    })
  | (Base & { type: 'specifying_started' })
  | (Base & { type: 'spec_drafted'; specId: string; version: number })
  /** The spec agent needs answers first; the work item then blocks until someone replies. */
  | (Base & { type: 'spec_questions_asked'; questions: string[] })
  | (Base & {
      type: 'gate_decided';
      decisionId: string;
      gate: GateName;
      subjectId: string;
      mode: GateMode;
      decidedBy: string;
      verdict: GateVerdict;
      reason: string;
    })
  | (Base & { type: 'tasks_planned'; tasks: PlannedTask[] })
  | (Base & { type: 'task_started'; taskId: string; branch: string })
  | (Base & { type: 'task_pr_opened'; taskId: string; pr: ExternalRef })
  /** `protectedPaths`: files the change touches that only a person may approve and merge. */
  | (Base & { type: 'task_built'; taskId: string; protectedPaths?: string[] })
  | (Base & { type: 'task_evidence_recorded'; taskId: string; evidence: Evidence })
  /** `protectedPaths`: protected files Verify found on the branch, when it scanned the whole of it. */
  | (Base & { type: 'task_verified'; taskId: string; verdict: 'pass' | 'rework' | 'escalate'; reason: string; protectedPaths?: string[] })
  /**
   * A person asked for the branch as it stands to be verified again, without building: after
   * pushing to it by hand, or to see how a check judges it. From ready, rework or escalated.
   */
  | (Base & { type: 'task_reverify_requested'; taskId: string; requestedBy: string; reason: string })
  /** The implementer finished without changing anything and said why; a human decides. */
  | (Base & { type: 'task_declined'; taskId: string; reason: string })
  | (Base & { type: 'task_rework_started'; taskId: string })
  /** The tester agent wrote acceptance tests from the spec, once per task, before seeing the diff. */
  | (Base & { type: 'task_acceptance_tests_written'; taskId: string; runId: string; files: string[]; patch: string })
  /**
   * The implementer refused to change sound code to satisfy a failing acceptance test, and the
   * tester reviewed its test against the spec: `revised` replaces the tests and verifies again,
   * `upheld` escalates with both sides. Once per task.
   */
  | (Base & { type: 'task_tests_disputed'; taskId: string; runId: string; dispute: string; verdict: 'revised' | 'upheld'; reasons: string[]; files?: string[]; patch?: string })
  /** A build stopped without finishing (the factory was stopped); the task builds again. */
  | (Base & { type: 'task_interrupted'; taskId: string; reason: string })
  | (Base & { type: 'task_retry_granted'; taskId: string; grantedBy: string; extraLoops: number; note?: string })
  | (Base & { type: 'task_merged'; taskId: string; sha: string })
  | (Base & { type: 'task_budget_exceeded'; taskId: string; spentUsd: number; reason?: string })
  | (Base & { type: 'task_budget_extended'; taskId: string; extendedBy: string; newLimitUsd: number })
  | (Base & { type: 'task_failed'; taskId: string; reason: string })
  | (Base & { type: 'task_cancelled'; taskId: string; reason: string })
  | (Base & { type: 'run_started'; runId: string; subjectId: string; station: Station; agentProfile?: AgentProfile })
  | (Base & { type: 'run_ended'; runId: string; outcome: RunOutcome })
  /** What one agent run cost, charged to the task (or the work item) and the requester. */
  | (Base & { type: 'agent_cost_recorded'; runId: string; subjectId: string; role: string; requester: string; costUsd: number })
  | (Base & { type: 'work_item_blocked'; reason: string })
  | (Base & { type: 'work_item_unblocked' })
  | (Base & { type: 'work_item_failed'; reason: string })
  | (Base & { type: 'work_item_cancelled'; reason: string });

export type WorkItemEventType = WorkItemEvent['type'];

export const WORK_ITEM_EVENT_TYPES: ReadonlySet<WorkItemEventType> = new Set<WorkItemEventType>([
  'work_item_received',
  'specifying_started',
  'spec_drafted',
  'spec_questions_asked',
  'gate_decided',
  'tasks_planned',
  'task_started',
  'task_pr_opened',
  'task_built',
  'task_evidence_recorded',
  'task_verified',
  'task_reverify_requested',
  'task_declined',
  'task_rework_started',
  'task_acceptance_tests_written',
  'task_tests_disputed',
  'task_interrupted',
  'task_retry_granted',
  'task_merged',
  'task_budget_exceeded',
  'task_budget_extended',
  'task_failed',
  'task_cancelled',
  'run_started',
  'run_ended',
  'agent_cost_recorded',
  'work_item_blocked',
  'work_item_unblocked',
  'work_item_failed',
  'work_item_cancelled',
]);

// Every change to a work item is one of these events, appended to the work item's stream.
// Agent-level events (tool calls, usage) go to each run's own stream instead.

import type { AgentProfile, ExternalRef, GateName, Timestamp } from '@cradleworks/interfaces';
import type { GateMode, GateVerdict, RunOutcome, Station, TaskSize } from './types.ts';

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
    })
  | (Base & { type: 'specifying_started' })
  | (Base & { type: 'spec_drafted'; specId: string; version: number })
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
  | (Base & { type: 'task_built'; taskId: string })
  | (Base & { type: 'task_verified'; taskId: string; verdict: 'pass' | 'rework' | 'escalate'; reason: string })
  | (Base & { type: 'task_rework_started'; taskId: string })
  | (Base & { type: 'task_retry_granted'; taskId: string; grantedBy: string; extraLoops: number })
  | (Base & { type: 'task_merged'; taskId: string; sha: string })
  | (Base & { type: 'task_budget_exceeded'; taskId: string; spentUsd: number })
  | (Base & { type: 'task_budget_extended'; taskId: string; extendedBy: string; newLimitUsd: number })
  | (Base & { type: 'task_failed'; taskId: string; reason: string })
  | (Base & { type: 'task_cancelled'; taskId: string; reason: string })
  | (Base & { type: 'run_started'; runId: string; subjectId: string; station: Station; agentProfile?: AgentProfile })
  | (Base & { type: 'run_ended'; runId: string; outcome: RunOutcome })
  | (Base & { type: 'work_item_blocked'; reason: string })
  | (Base & { type: 'work_item_unblocked' })
  | (Base & { type: 'work_item_failed'; reason: string })
  | (Base & { type: 'work_item_cancelled'; reason: string });

export type WorkItemEventType = WorkItemEvent['type'];

export const WORK_ITEM_EVENT_TYPES: ReadonlySet<WorkItemEventType> = new Set<WorkItemEventType>([
  'work_item_received',
  'specifying_started',
  'spec_drafted',
  'gate_decided',
  'tasks_planned',
  'task_started',
  'task_pr_opened',
  'task_built',
  'task_verified',
  'task_rework_started',
  'task_retry_granted',
  'task_merged',
  'task_budget_exceeded',
  'task_budget_extended',
  'task_failed',
  'task_cancelled',
  'run_started',
  'run_ended',
  'work_item_blocked',
  'work_item_unblocked',
  'work_item_failed',
  'work_item_cancelled',
]);

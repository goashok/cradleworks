// The work item state machine. `applyEvent` is a pure function: given the current
// state and one event it returns the next state, or throws IllegalTransitionError and
// changes nothing. Current state is always `replay(events)` (Build spec, section 3).

import { IllegalTransitionError } from './errors.ts';
import type { WorkItemEvent } from './events.ts';
import {
  TERMINAL_TASK_STATES,
  TERMINAL_WORK_ITEM_STATES,
  type Task,
  type TaskState,
  type WorkItem,
  type WorkItemState,
} from './types.ts';

export function replay(events: Iterable<WorkItemEvent>): WorkItem | undefined {
  let state: WorkItem | undefined;
  for (const event of events) state = applyEvent(state, event);
  return state;
}

export function applyEvent(current: WorkItem | undefined, event: WorkItemEvent): WorkItem {
  if (current === undefined) {
    if (event.type !== 'work_item_received') {
      throw new IllegalTransitionError(event.type, 'none', 'the first event must be work_item_received');
    }
    if (!Number.isInteger(event.maxReworkLoops) || event.maxReworkLoops < 0) {
      throw new IllegalTransitionError(event.type, 'none', 'maxReworkLoops must be a non-negative integer');
    }
    return {
      id: event.workItemId,
      source: event.source,
      requester: event.requester,
      projectId: event.projectId,
      title: event.title,
      state: 'received',
      maxReworkLoops: event.maxReworkLoops,
      ...(event.baseBranch ? { baseBranch: event.baseBranch } : {}),
      proposedTasks: [],
      spentUsd: 0,
      tasks: [],
      gateDecisions: [],
      runs: [],
      createdAt: event.at,
      updatedAt: event.at,
      version: 1,
    };
  }

  const next = structuredClone(current);
  mutate(next, event);
  next.updatedAt = event.at;
  next.version = current.version + 1;
  return next;
}

// ---------------------------------------------------------------------------

function mutate(wi: WorkItem, event: WorkItemEvent): void {
  const fail = (detail: string): never => {
    throw new IllegalTransitionError(event.type, wi.state, detail);
  };

  // Runs may finish after the work item has stopped; everything else needs a live item.
  if (event.type === 'run_ended') return endRun(wi, event.runId, event.outcome, event.at, fail);
  if (event.type === 'agent_cost_recorded') return recordCost(wi, event);
  if (TERMINAL_WORK_ITEM_STATES.has(wi.state)) fail('the work item has ended');
  if (wi.state === 'blocked' && !['work_item_unblocked', 'work_item_failed', 'work_item_cancelled'].includes(event.type)) {
    fail('the work item is blocked');
  }

  switch (event.type) {
    case 'work_item_received':
      return fail('the work item already exists');

    case 'specifying_started':
      expectState(wi, ['received'], fail);
      wi.state = 'specifying';
      return;

    case 'spec_drafted':
      expectState(wi, ['specifying'], fail);
      if (wi.spec && wi.spec.specId === event.specId && event.version <= wi.spec.version) {
        fail(`spec version must increase past ${wi.spec.version}`);
      }
      wi.spec = { specId: event.specId, version: event.version, approved: false };
      wi.state = 'awaiting_spec_approval';
      return;

    case 'spec_questions_asked':
      expectState(wi, ['specifying'], fail);
      if (wi.specQuestions) fail('questions were already asked once');
      if (event.questions.length === 0) fail('no questions to ask');
      wi.specQuestions = [...event.questions];
      return;

    case 'gate_decided':
      return decideGate(wi, event, fail);

    case 'tasks_planned': {
      expectState(wi, ['planning'], fail);
      if (event.tasks.length === 0) fail('a plan needs at least one task');
      const ids = new Set(event.tasks.map((t) => t.taskId));
      if (ids.size !== event.tasks.length) fail('task ids must be unique');
      for (const t of event.tasks) {
        for (const dep of t.dependsOn) if (!ids.has(dep)) fail(`task ${t.taskId} depends on unknown task ${dep}`);
      }
      if (hasCycle(event.tasks)) fail('task dependencies must not form a cycle');
      const specId = wi.spec?.specId ?? fail('no approved spec');
      wi.proposedTasks = event.tasks.map((t) => newTask(t.taskId, specId, t.title, t.dependsOn, t.size, t.description, t.repo));
      return;
    }

    case 'task_started': {
      expectState(wi, ['in_progress', 'awaiting_change_approval'], fail);
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['queued'], fail);
      const unmet = task.dependsOn.filter((dep) => findTask(wi, dep, fail).state !== 'merged');
      if (unmet.length > 0) fail(`task ${task.id} waits on unmerged dependencies: ${unmet.join(', ')}`);
      task.state = 'building';
      task.branch = event.branch;
      break;
    }

    case 'task_pr_opened': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['building', 'verifying'], fail);
      task.pr = event.pr;
      break;
    }

    case 'task_built': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['building'], fail);
      task.state = 'verifying';
      if (event.protectedPaths?.length) task.protectedPaths = [...new Set([...(task.protectedPaths ?? []), ...event.protectedPaths])].sort();
      break;
    }

    case 'task_evidence_recorded': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['verifying'], fail);
      task.evidence = event.evidence;
      break;
    }

    case 'task_declined': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['building'], fail);
      if (event.reason.trim() === '') fail('a decline needs a reason');
      task.state = 'escalated';
      task.lastReason = event.reason;
      break;
    }

    case 'task_verified': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['verifying'], fail);
      task.lastReason = event.reason;
      if (event.verdict === 'pass') {
        if (!task.pr) fail(`task ${task.id} has no pull request to approve`);
        task.state = 'ready';
      } else if (event.verdict === 'escalate' || task.reworkLoops >= wi.maxReworkLoops + task.extraLoops) {
        task.state = 'escalated';
      } else {
        task.reworkLoops += 1;
        task.state = 'rework';
      }
      break;
    }

    case 'task_rework_started': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['rework'], fail);
      task.state = 'building';
      task.changeApproved = false;
      break;
    }

    case 'task_acceptance_tests_written': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['verifying'], fail);
      if (task.acceptanceTests) fail(`task ${task.id} already has acceptance tests`);
      task.acceptanceTests = { runId: event.runId, files: [...event.files], patch: event.patch };
      break;
    }

    case 'task_interrupted': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['building'], fail);
      task.state = 'rework';
      task.lastReason = event.reason;
      break;
    }

    case 'task_retry_granted': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['escalated'], fail);
      if (!Number.isInteger(event.extraLoops) || event.extraLoops < 1) fail('extraLoops must be a positive integer');
      task.extraLoops += event.extraLoops;
      task.state = 'rework';
      if (event.note) task.lastReason = event.note;
      break;
    }

    case 'task_merged': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['ready'], fail);
      if (!task.changeApproved) fail(`task ${task.id} has not passed the change gate`);
      task.state = 'merged';
      task.mergedSha = event.sha;
      break;
    }

    case 'task_budget_exceeded': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['building', 'verifying'], fail);
      task.resumeState = task.state as 'building' | 'verifying';
      task.state = 'budget_exceeded';
      task.lastReason = event.reason ?? `budget exceeded at $${event.spentUsd.toFixed(2)}`;
      break;
    }

    case 'task_budget_extended': {
      const task = findTask(wi, event.taskId, fail);
      expectTaskState(task, ['budget_exceeded'], fail);
      if (!Number.isFinite(event.newLimitUsd) || event.newLimitUsd <= 0) fail('the new limit must be a positive number');
      // A build cut off by its budget builds again; a verify carries on where it stopped.
      task.state = task.resumeState === 'verifying' ? 'verifying' : 'rework';
      task.budgetUsd = event.newLimitUsd;
      delete task.resumeState;
      break;
    }

    case 'task_failed': {
      const task = findTask(wi, event.taskId, fail);
      if (TERMINAL_TASK_STATES.has(task.state)) fail(`task ${task.id} has already ended`);
      task.state = 'failed';
      task.lastReason = event.reason;
      break;
    }

    case 'task_cancelled': {
      const task = findTask(wi, event.taskId, fail);
      if (TERMINAL_TASK_STATES.has(task.state)) fail(`task ${task.id} has already ended`);
      task.state = 'cancelled';
      task.lastReason = event.reason;
      break;
    }

    case 'run_started':
      if (wi.runs.some((r) => r.id === event.runId)) fail(`run ${event.runId} already exists`);
      wi.runs.push({
        id: event.runId,
        subjectId: event.subjectId,
        station: event.station,
        startedAt: event.at,
        ...(event.agentProfile ? { agentProfile: event.agentProfile } : {}),
      });
      return;

    case 'work_item_blocked':
      wi.blockedFrom = wi.state;
      wi.blockedReason = event.reason;
      wi.state = 'blocked';
      return;

    case 'work_item_unblocked':
      expectState(wi, ['blocked'], fail);
      wi.state = wi.blockedFrom ?? fail('no state to return to');
      delete wi.blockedFrom;
      delete wi.blockedReason;
      return;

    case 'work_item_failed':
      wi.state = 'failed';
      wi.endReason = event.reason;
      return;

    case 'work_item_cancelled':
      wi.state = 'cancelled';
      wi.endReason = event.reason;
      for (const task of wi.tasks) {
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          task.state = 'cancelled';
          task.lastReason = event.reason;
        }
      }
      return;
  }

  // Every task-level event lands here: the work item's state follows its tasks.
  expectState(wi, ['in_progress', 'awaiting_change_approval'], fail);
  wi.state = rollUp(wi.tasks);
}

function decideGate(
  wi: WorkItem,
  event: Extract<WorkItemEvent, { type: 'gate_decided' }>,
  fail: (detail: string) => never,
): void {
  const record = () =>
    wi.gateDecisions.push({
      id: event.decisionId,
      gate: event.gate,
      subjectId: event.subjectId,
      mode: event.mode,
      decidedBy: event.decidedBy,
      verdict: event.verdict,
      reason: event.reason,
      at: event.at,
    });
  if (event.verdict === 'rejected' && event.reason.trim() === '') fail('a rejection needs a reason');

  switch (event.gate) {
    case 'spec_approval': {
      expectState(wi, ['awaiting_spec_approval'], fail);
      const spec = wi.spec ?? fail('no spec to approve');
      if (event.subjectId !== spec.specId) fail(`gate is for spec ${event.subjectId}, not ${spec.specId}`);
      record();
      if (event.verdict === 'approved') {
        spec.approved = true;
        wi.state = 'planning';
      } else {
        wi.state = 'specifying';
      }
      return;
    }

    case 'plan_check': {
      expectState(wi, ['planning'], fail);
      if (event.subjectId !== wi.id) fail(`gate is for ${event.subjectId}, not work item ${wi.id}`);
      if (wi.proposedTasks.length === 0) fail('no plan to check');
      record();
      if (event.verdict === 'approved') {
        wi.tasks = wi.proposedTasks;
        wi.state = 'in_progress';
      }
      wi.proposedTasks = [];
      return;
    }

    case 'change_approval': {
      expectState(wi, ['in_progress', 'awaiting_change_approval'], fail);
      const task = findTask(wi, event.subjectId, fail);
      expectTaskState(task, ['ready'], fail);
      record();
      if (event.verdict === 'approved') {
        task.changeApproved = true;
      } else {
        task.gateReworks += 1;
        task.lastReason = event.reason;
        task.state = 'rework';
        task.changeApproved = false;
      }
      wi.state = rollUp(wi.tasks);
      return;
    }
  }
}

function endRun(
  wi: WorkItem,
  runId: string,
  outcome: NonNullable<WorkItem['runs'][number]['outcome']>,
  at: string,
  fail: (detail: string) => never,
): void {
  const run = wi.runs.find((r) => r.id === runId) ?? fail(`unknown run ${runId}`);
  if (run.endedAt !== undefined) fail(`run ${runId} has already ended`);
  run.endedAt = at;
  run.outcome = outcome;
}

/** in_progress while any task can still move on its own; awaiting approval when all are at the gate. */
function rollUp(tasks: Task[]): WorkItemState {
  const live = tasks.filter((t) => t.state !== 'cancelled');
  if (live.length > 0 && live.every((t) => t.state === 'merged')) return 'merged';
  const open = live.filter((t) => t.state !== 'merged');
  if (open.length > 0 && open.every((t) => t.state === 'ready' && !t.changeApproved)) return 'awaiting_change_approval';
  return 'in_progress';
}

function newTask(id: string, specId: string, title: string, dependsOn: string[], size: Task['size'], description?: string, repo?: string): Task {
  return {
    id,
    specId,
    title,
    dependsOn: [...dependsOn],
    size,
    ...(description !== undefined ? { description } : {}),
    ...(repo !== undefined ? { repo } : {}),
    state: 'queued',
    reworkLoops: 0,
    gateReworks: 0,
    extraLoops: 0,
    changeApproved: false,
    spentUsd: 0,
  };
}

function recordCost(wi: WorkItem, event: Extract<WorkItemEvent, { type: 'agent_cost_recorded' }>): void {
  if (!Number.isFinite(event.costUsd) || event.costUsd < 0) throw new IllegalTransitionError(event.type, wi.state, 'costUsd must be a non-negative number');
  // Work items saved before costs were recorded have no totals yet.
  wi.spentUsd = (wi.spentUsd ?? 0) + event.costUsd;
  const task = wi.tasks.find((t) => t.id === event.subjectId);
  if (task) task.spentUsd = (task.spentUsd ?? 0) + event.costUsd;
}

function hasCycle(tasks: ReadonlyArray<{ taskId: string; dependsOn: string[] }>): boolean {
  const deps = new Map(tasks.map((t) => [t.taskId, t.dependsOn]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) if (visit(dep)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return tasks.some((t) => visit(t.taskId));
}

function findTask(wi: WorkItem, taskId: string, fail: (detail: string) => never): Task {
  return wi.tasks.find((t) => t.id === taskId) ?? fail(`unknown task ${taskId}`);
}

function expectState(wi: WorkItem, allowed: WorkItemState[], fail: (detail: string) => never): void {
  if (!allowed.includes(wi.state)) fail(`expected ${allowed.join(' or ')}`);
}

function expectTaskState(task: Task, allowed: TaskState[], fail: (detail: string) => never): void {
  if (!allowed.includes(task.state)) fail(`task ${task.id} is ${task.state}, expected ${allowed.join(' or ')}`);
}

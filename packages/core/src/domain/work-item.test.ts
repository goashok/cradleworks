import type { StoredEvent } from '@cradleworks/interfaces';
import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  applyEvent,
  fromStoredEvent,
  replay,
  toNewEvent,
  type WorkItem,
  type WorkItemEvent,
} from './index.ts';

// --- helpers ---------------------------------------------------------------

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 21, 12, 0, clock++)).toISOString();

type EventInput = WorkItemEvent extends infer E ? (E extends WorkItemEvent ? Omit<E, 'at'> : never) : never;
const ev = (e: EventInput): WorkItemEvent => ({ ...e, at: at() }) as WorkItemEvent;

const received = (maxReworkLoops = 2) =>
  ev({
    type: 'work_item_received',
    workItemId: 'wi_1',
    source: { id: 'issue-42', url: 'https://tracker.example/issues/42' },
    requester: 'alex',
    projectId: 'proj_1',
    title: 'Add order export',
    maxReworkLoops,
  });

const gate = (
  g: 'spec_approval' | 'plan_check' | 'change_approval',
  subjectId: string,
  verdict: 'approved' | 'rejected' = 'approved',
  reason = verdict === 'approved' ? 'looks right' : 'missing edge cases',
) => ev({ type: 'gate_decided', decisionId: `gate_${clock}`, gate: g, subjectId, mode: 'human', decidedBy: 'sam', verdict, reason });

/** A work item with an approved spec and plan: task t1, and t2 depending on t1. */
function planned(maxReworkLoops = 2): WorkItemEvent[] {
  return [
    received(maxReworkLoops),
    ev({ type: 'specifying_started' }),
    ev({ type: 'spec_drafted', specId: 'spec_1', version: 1 }),
    gate('spec_approval', 'spec_1'),
    ev({
      type: 'tasks_planned',
      tasks: [
        { taskId: 't1', title: 'API endpoint', dependsOn: [], size: 'small' },
        { taskId: 't2', title: 'Export button', dependsOn: ['t1'], size: 'small' },
      ],
    }),
    gate('plan_check', 'wi_1'),
  ];
}

/** Drives a task from queued to ready with a PR. */
const toReady = (taskId: string): WorkItemEvent[] => [
  ev({ type: 'task_started', taskId, branch: `factory/${taskId}` }),
  ev({ type: 'task_pr_opened', taskId, pr: { id: `pr-${taskId}`, url: `https://scm.example/pr/${taskId}` } }),
  ev({ type: 'task_built', taskId }),
  ev({ type: 'task_verified', taskId, verdict: 'pass', reason: 'all checks green' }),
];

const build = (events: WorkItemEvent[]): WorkItem => {
  const state = replay(events);
  if (!state) throw new Error('no state');
  return state;
};

const task = (wi: WorkItem, id: string) => wi.tasks.find((t) => t.id === id)!;

function expectIllegal(state: WorkItem | undefined, event: WorkItemEvent, message?: RegExp) {
  let error: unknown;
  try {
    applyEvent(state, event);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(IllegalTransitionError);
  if (message) expect((error as Error).message).toMatch(message);
}

// --- tests -----------------------------------------------------------------

describe('work item happy path', () => {
  it('goes from issue to merged through every station', () => {
    let wi = build(planned());
    expect(wi.state).toBe('in_progress');
    expect(wi.spec).toEqual({ specId: 'spec_1', version: 1, approved: true });
    expect(wi.tasks.map((t) => t.state)).toEqual(['queued', 'queued']);

    wi = build([...planned(), ...toReady('t1')]);
    expect(wi.state).toBe('in_progress'); // t2 is still queued

    wi = build([...planned(), ...toReady('t1'), gate('change_approval', 't1'), ev({ type: 'task_merged', taskId: 't1', sha: 'abc' })]);
    expect(task(wi, 't1').state).toBe('merged');

    wi = build([
      ...planned(),
      ...toReady('t1'),
      gate('change_approval', 't1'),
      ev({ type: 'task_merged', taskId: 't1', sha: 'abc' }),
      ...toReady('t2'),
    ]);
    expect(wi.state).toBe('awaiting_change_approval');

    wi = build([
      ...planned(),
      ...toReady('t1'),
      gate('change_approval', 't1'),
      ev({ type: 'task_merged', taskId: 't1', sha: 'abc' }),
      ...toReady('t2'),
      gate('change_approval', 't2'),
      ev({ type: 'task_merged', taskId: 't2', sha: 'def' }),
    ]);
    expect(wi.state).toBe('merged');
    expect(wi.gateDecisions.map((g) => g.gate)).toEqual(['spec_approval', 'plan_check', 'change_approval', 'change_approval']);
  });

  it('counts versions and timestamps from the log', () => {
    const events = planned();
    const wi = build(events);
    expect(wi.version).toBe(events.length);
    expect(wi.createdAt).toBe(events[0]!.at);
    expect(wi.updatedAt).toBe(events.at(-1)!.at);
  });
});

describe('illegal transitions are rejected', () => {
  it('needs work_item_received first, exactly once', () => {
    expectIllegal(undefined, ev({ type: 'specifying_started' }), /first event/);
    expectIllegal(build([received()]), received(), /already exists/);
  });

  it('cannot skip stations', () => {
    const wi = build([received()]);
    expectIllegal(wi, ev({ type: 'spec_drafted', specId: 'spec_1', version: 1 }), /expected specifying/);
    expectIllegal(wi, gate('spec_approval', 'spec_1'));
    expectIllegal(wi, ev({ type: 'tasks_planned', tasks: [{ taskId: 't1', title: 'x', dependsOn: [], size: 'small' }] }));
  });

  it('cannot plan before the spec is approved', () => {
    const wi = build(planned().slice(0, 3)); // spec drafted, not approved
    expectIllegal(wi, ev({ type: 'tasks_planned', tasks: [{ taskId: 't1', title: 'x', dependsOn: [], size: 'small' }] }));
  });

  it('rejects a gate decision for the wrong subject', () => {
    const wi = build(planned().slice(0, 3));
    expectIllegal(wi, gate('spec_approval', 'spec_other'), /not spec_1/);
  });

  it('rejects a rejection without a reason', () => {
    const wi = build(planned().slice(0, 3));
    expectIllegal(wi, gate('spec_approval', 'spec_1', 'rejected', '  '), /needs a reason/);
  });

  it('rejects bad plans', () => {
    const wi = build(planned().slice(0, 4));
    const plan = (tasks: Array<{ taskId: string; dependsOn: string[] }>) =>
      ev({ type: 'tasks_planned', tasks: tasks.map((t) => ({ ...t, title: t.taskId, size: 'small' as const })) });
    expectIllegal(wi, plan([]), /at least one task/);
    expectIllegal(wi, plan([{ taskId: 'a', dependsOn: [] }, { taskId: 'a', dependsOn: [] }]), /unique/);
    expectIllegal(wi, plan([{ taskId: 'a', dependsOn: ['zzz'] }]), /unknown task zzz/);
    expectIllegal(wi, plan([{ taskId: 'a', dependsOn: ['b'] }, { taskId: 'b', dependsOn: ['a'] }]), /cycle/);
  });

  it('will not start a task before its dependencies merge', () => {
    const wi = build(planned());
    expectIllegal(wi, ev({ type: 'task_started', taskId: 't2', branch: 'b' }), /unmerged dependencies: t1/);
  });

  it('will not merge without the change gate', () => {
    const wi = build([...planned(), ...toReady('t1')]);
    expectIllegal(wi, ev({ type: 'task_merged', taskId: 't1', sha: 'abc' }), /change gate/);
  });

  it('will not pass verification without a pull request', () => {
    const wi = build([
      ...planned(),
      ev({ type: 'task_started', taskId: 't1', branch: 'b' }),
      ev({ type: 'task_built', taskId: 't1' }),
    ]);
    expectIllegal(wi, ev({ type: 'task_verified', taskId: 't1', verdict: 'pass', reason: 'ok' }), /no pull request/);
  });

  it('accepts nothing but unblock, fail or cancel while blocked', () => {
    const wi = build([...planned(), ev({ type: 'work_item_blocked', reason: 'waiting on credentials' })]);
    expectIllegal(wi, ev({ type: 'task_started', taskId: 't1', branch: 'b' }), /blocked/);
    expect(applyEvent(wi, ev({ type: 'work_item_unblocked' })).state).toBe('in_progress');
  });

  it('accepts nothing after the work item ends, except a run finishing', () => {
    const wi = build([
      ...planned(),
      ev({ type: 'run_started', runId: 'run_1', subjectId: 't1', station: 'build' }),
      ev({ type: 'work_item_cancelled', reason: 'no longer needed' }),
    ]);
    expectIllegal(wi, ev({ type: 'work_item_unblocked' }), /ended/);
    expectIllegal(wi, ev({ type: 'task_started', taskId: 't1', branch: 'b' }), /ended/);
    const after = applyEvent(wi, ev({ type: 'run_ended', runId: 'run_1', outcome: 'stopped' }));
    expect(after.runs[0]?.outcome).toBe('stopped');
  });

  it('leaves the state untouched when it throws', () => {
    const wi = build(planned());
    const before = structuredClone(wi);
    expectIllegal(wi, ev({ type: 'task_merged', taskId: 't1', sha: 'x' }));
    expect(wi).toEqual(before);
  });
});

describe('rework and escalation', () => {
  const failVerify = (taskId: string) => [
    ev({ type: 'task_verified', taskId, verdict: 'rework', reason: 'test failed' }),
  ];
  const rebuild = (taskId: string) => [ev({ type: 'task_rework_started', taskId }), ev({ type: 'task_built', taskId })];

  it('loops at most maxReworkLoops times, then escalates', () => {
    const start = [...planned(2), ev({ type: 'task_started', taskId: 't1', branch: 'b' }), ev({ type: 'task_built', taskId: 't1' })];
    const once = build([...start, ...failVerify('t1')]);
    expect(task(once, 't1')).toMatchObject({ state: 'rework', reworkLoops: 1 });

    const twice = build([...start, ...failVerify('t1'), ...rebuild('t1'), ...failVerify('t1')]);
    expect(task(twice, 't1')).toMatchObject({ state: 'rework', reworkLoops: 2 });

    const third = build([...start, ...failVerify('t1'), ...rebuild('t1'), ...failVerify('t1'), ...rebuild('t1'), ...failVerify('t1')]);
    expect(task(third, 't1')).toMatchObject({ state: 'escalated', reworkLoops: 2 });

    // A human grants one more loop.
    const granted = applyEvent(third, ev({ type: 'task_retry_granted', taskId: 't1', grantedBy: 'sam', extraLoops: 1 }));
    expect(task(granted, 't1').state).toBe('rework');
  });

  it('escalates at once when the reviewer says so', () => {
    const wi = build([
      ...planned(),
      ev({ type: 'task_started', taskId: 't1', branch: 'b' }),
      ev({ type: 'task_built', taskId: 't1' }),
      ev({ type: 'task_verified', taskId: 't1', verdict: 'escalate', reason: 'touches auth' }),
    ]);
    expect(task(wi, 't1').state).toBe('escalated');
  });

  it('sends a rejected change back to rework without using up loops', () => {
    const wi = build([...planned(0), ...toReady('t1'), gate('change_approval', 't1', 'rejected', 'wrong file format')]);
    expect(task(wi, 't1')).toMatchObject({ state: 'rework', gateReworks: 1, reworkLoops: 0, lastReason: 'wrong file format' });
    expect(wi.state).toBe('in_progress');
  });

  it('needs a fresh approval after rework', () => {
    const wi = build([
      ...planned(),
      ...toReady('t1'),
      gate('change_approval', 't1', 'rejected', 'rename the column'),
      ev({ type: 'task_rework_started', taskId: 't1' }),
      ev({ type: 'task_built', taskId: 't1' }),
      ev({ type: 'task_verified', taskId: 't1', verdict: 'pass', reason: 'ok' }),
    ]);
    expect(task(wi, 't1').changeApproved).toBe(false);
    expectIllegal(wi, ev({ type: 'task_merged', taskId: 't1', sha: 'x' }), /change gate/);
  });

  it('returns to specifying when the spec is rejected, and needs a newer version', () => {
    const wi = build([...planned().slice(0, 3), gate('spec_approval', 'spec_1', 'rejected', 'scope too wide')]);
    expect(wi.state).toBe('specifying');
    expectIllegal(wi, ev({ type: 'spec_drafted', specId: 'spec_1', version: 1 }), /version must increase/);
    expect(applyEvent(wi, ev({ type: 'spec_drafted', specId: 'spec_1', version: 2 })).spec?.version).toBe(2);
  });

  it('discards a rejected plan', () => {
    const events = planned();
    events[events.length - 1] = gate('plan_check', 'wi_1', 'rejected', 'tasks too large');
    const wi = build(events);
    expect(wi.state).toBe('planning');
    expect(wi.tasks).toEqual([]);
    expect(wi.proposedTasks).toEqual([]);
  });
});

describe('budgets', () => {
  it('stops a task and resumes it where it was when extended', () => {
    const wi = build([
      ...planned(),
      ev({ type: 'task_started', taskId: 't1', branch: 'b' }),
      ev({ type: 'task_built', taskId: 't1' }),
      ev({ type: 'task_budget_exceeded', taskId: 't1', spentUsd: 5.02 }),
    ]);
    expect(task(wi, 't1')).toMatchObject({ state: 'budget_exceeded', resumeState: 'verifying' });
    expectIllegal(wi, ev({ type: 'task_built', taskId: 't1' }));
    const resumed = applyEvent(wi, ev({ type: 'task_budget_extended', taskId: 't1', extendedBy: 'sam', newLimitUsd: 10 }));
    expect(task(resumed, 't1').state).toBe('verifying');
  });
});

describe('cancellation', () => {
  it('cancels every open task with the work item', () => {
    const wi = build([
      ...planned(),
      ...toReady('t1'),
      gate('change_approval', 't1'),
      ev({ type: 'task_merged', taskId: 't1', sha: 'abc' }),
      ev({ type: 'work_item_cancelled', reason: 'superseded' }),
    ]);
    expect(wi.tasks.map((t) => t.state)).toEqual(['merged', 'cancelled']);
  });
});

describe('event codec', () => {
  it('round-trips through the store format and replays to the same state', () => {
    const events = [...planned(), ...toReady('t1')];
    const stored: StoredEvent[] = events.map((e, i) => ({ ...toNewEvent(e), streamId: 'wi_1', seq: i + 1, position: i + 1 }));
    expect(stored[0]!.payload).not.toHaveProperty('type');
    expect(replay(stored.map(fromStoredEvent))).toEqual(replay(events));
  });

  it('refuses unknown event types', () => {
    const bad: StoredEvent = { type: 'task_teleported', payload: {}, at: at(), streamId: 'wi_1', seq: 1, position: 1 };
    expect(() => fromStoredEvent(bad)).toThrow(/unknown event type/);
  });
});

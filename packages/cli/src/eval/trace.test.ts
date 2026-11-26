import { describe, expect, it } from 'vitest';
import { traceOf, type TraceEvent } from './trace.ts';

const t = (s: number) => new Date(Date.UTC(2026, 10, 26, 12, 0, s)).toISOString();
const ev = (type: string, at: number, payload: Record<string, unknown>): TraceEvent => ({ type, at: t(at), payload });

describe('traceOf', () => {
  it('reads each station run, its agents, what Verify found and how the work ended', () => {
    const events = [
      ev('run_started', 0, { runId: 'r1', subjectId: 'wi_1', station: 'specify', agentProfile: { role: 'specifier', agent: 'claude-code', model: 'claude-sonnet-5-5' } }),
      ev('agent_cost_recorded', 20, { runId: 'r1', role: 'specifier', costUsd: 0.1 }),
      ev('run_ended', 20, { runId: 'r1', outcome: 'succeeded' }),
      ev('gate_decided', 21, { gate: 'spec_approval', verdict: 'approved', decidedBy: 'ai', reason: 'clear enough' }),
      ev('tasks_planned', 30, { tasks: [{ id: 'task_a' }] }),
      ev('run_started', 40, { runId: 'r2', subjectId: 'task_a', station: 'build', agentProfile: { role: 'implementer', model: 'claude-opus-5-5' } }),
      ev('agent_cost_recorded', 100, { runId: 'r2', role: 'implementer', costUsd: 0.5 }),
      ev('run_ended', 100, { runId: 'r2', outcome: 'succeeded' }),
      ev('run_started', 101, { runId: 'r3', subjectId: 'task_a', station: 'verify', agentProfile: { role: 'reviewer', model: 'claude-haiku-5-5' } }),
      ev('agent_cost_recorded', 120, { runId: 'r3', role: 'tester', costUsd: 0.2 }),
      ev('agent_cost_recorded', 130, { runId: 'r3', role: 'reviewer', costUsd: 0.05 }),
      ev('task_evidence_recorded', 131, { taskId: 'task_a', evidence: { runId: 'r3', verdict: 'rework', reason: 'tests failed', checks: [{ name: 'test', outcome: 'failed' }, { name: 'build', outcome: 'passed' }], ci: { state: 'not_configured' }, review: { verdict: 'rework', risk: 'medium', reasons: ['no test for an empty list'] } } }),
      ev('run_ended', 131, { runId: 'r3', outcome: 'succeeded' }),
      ev('task_rework_started', 132, { taskId: 'task_a' }),
      ev('run_started', 133, { runId: 'r4', subjectId: 'task_a', station: 'build', agentProfile: { role: 'implementer', model: 'claude-opus-5-5' } }),
      ev('task_budget_exceeded', 150, { taskId: 'task_a', spentUsd: 1.02 }),
      ev('run_ended', 150, { runId: 'r4', outcome: 'limit_reached' }),
    ];
    const trace = traceOf(events, { tester: 'claude-sonnet-5-5' });
    expect(trace.steps.map((s) => [s.station, s.round, s.outcome, s.seconds, s.costUsd])).toEqual([
      ['specify', 1, 'succeeded', 20, 0.1],
      ['build', 1, 'succeeded', 60, 0.5],
      ['verify', 1, 'succeeded', 30, 0.25],
      ['build', 2, 'limit_reached', 17, 0],
    ]);
    // A verify run's agents: the reviewer it ran as, and the tester from the settings.
    expect(trace.steps[2]!.agents).toEqual([
      { role: 'reviewer', model: 'claude-haiku-5-5', costUsd: 0.05 },
      { role: 'tester', model: 'claude-sonnet-5-5', costUsd: 0.2 },
    ]);
    expect(trace.steps[2]).toMatchObject({ verdict: 'rework', failedChecks: ['test'], review: { reasons: ['no test for an empty list'] } });
    expect(trace.steps[2]!.ci).toBeUndefined();
    // One task: no task names on the steps.
    expect(trace.steps[1]!.task).toBeUndefined();
    expect(trace.byRole).toEqual({ specifier: 0.1, implementer: 0.5, tester: 0.2, reviewer: 0.05 });
    expect(trace.notes.map((n) => n.kind)).toEqual(['gate', 'rework', 'budget']);
    expect(trace.endReason).toBe('reached the spend limit per task');
  });

  it('keeps long text short and ignores events it does not know', () => {
    const trace = traceOf([ev('something_new', 0, {}), ev('task_failed', 1, { reason: 'x'.repeat(5000) })]);
    expect(trace.steps).toEqual([]);
    expect(trace.endReason!.length).toBeLessThanOrEqual(600);
  });
});

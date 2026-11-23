import { describe, expect, it } from 'vitest';
import { dashboardBody, runsListBody, workListBody } from './console-dashboard.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const wi = (id: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ id, source: { id: 'o/r#1' }, requester: 'sam', projectId: 'demo', title: `Item ${id}`, state, maxReworkLoops: 3, proposedTasks: [], spentUsd: 1, tasks: [], gateDecisions: [], runs: [], createdAt: '2026-11-22T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z', version: 1, ...extra }) as never;
const run = (id: string, outcome?: string, startedAt = '2026-11-23T09:00:00Z') => ({ id, subjectId: 'x', station: 'build', startedAt, ...(outcome ? { outcome, endedAt: startedAt } : {}) });

describe('console dashboard', () => {
  const items = [
    wi('wi_a', 'awaiting_spec_approval'),
    wi('wi_b', 'in_progress', { runs: [run('run_1'), run('run_2', 'failed', '2026-11-22T09:00:00Z')] }),
    wi('wi_c', 'merged', { runs: [run('run_3', 'succeeded', '2026-11-21T09:00:00Z')] }),
    wi('wi_d', 'cancelled', { updatedAt: '2026-10-01T10:00:00Z' }),
  ];
  const costs = new Map([['run_1', 0.5], ['run_2', 0.25], ['run_3', 1]]);

  it('counts what needs a person, what is moving, what finished this week and what it cost', () => {
    const html = dashboardBody(items, costs, NOW);
    const tile = (label: string) => new RegExp(`<span class="label">${label}</span><span class="value">([^<]+)</span>`).exec(html)?.[1];
    expect(tile('Needs you')).toBe('1');
    expect(tile('In progress')).toBe('1');
    expect(tile('Merged this week')).toBe('1');
    expect(tile('Runs this week')).toBe('3');
    expect(tile('Spent this week')).toBe('$1.75');
    expect(html).toContain('href="/wi/wi_a"');
    expect(html).toContain('href="/run/run_1"');
    expect(html).toContain('1 did not succeed');
    expect(html).not.toContain('Stalled');
    const later = dashboardBody(items.map((w: { id: string; runs: unknown[] }) => (w.id === 'wi_b' ? { ...w, runs: w.runs.slice(1) } : w)) as never, costs, NOW + 2 * 3_600_000);
    expect(later).toContain('1 stalled, no run for over an hour');
    expect(later).toContain('Stalled');
  });

  it('lists work by filter and runs across work items, newest first', () => {
    expect(workListBody(items, 'finished')).toContain('wi_c');
    expect(workListBody(items, 'finished')).not.toContain('/wi/wi_a"');
    expect(workListBody(items, 'waiting')).toContain('/wi/wi_a"');
    const runs = runsListBody(items, costs, 'all');
    expect(runs.indexOf('run_1')).toBeLessThan(runs.indexOf('run_2'));
    expect(runs.indexOf('run_2')).toBeLessThan(runs.indexOf('run_3'));
    const failed = runsListBody(items, costs, 'failed');
    expect(failed).toContain('/run/run_2');
    expect(failed).not.toContain('/run/run_1"');
  });

  it('escapes titles', () => {
    expect(dashboardBody([wi('wi_x', 'blocked', { title: '<b>x</b>' })], new Map(), NOW)).not.toContain('<b>x</b>');
  });
});

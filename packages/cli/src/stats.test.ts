import type { StoredEvent } from '@cradleworks/interfaces';
import type { WorkItem } from '@cradleworks/core';
import { describe, expect, it } from 'vitest';
import { computeStats, formatStats } from './stats.ts';

let pos = 0;
const ev = (type: string, at: string, payload: Record<string, unknown> = {}): StoredEvent => ({ streamId: 'wi', seq: ++pos, position: pos, type, at, payload: { type, at, ...payload } });
const task = (over: Record<string, unknown>) => ({ id: 't', state: 'merged', reworkLoops: 0, gateReworks: 0, ...over });
const evidence = (config: string, verdict: string, at: string, checks: unknown[] = []) => ({ evidence: { factoryConfig: config, verdict, verifiedAt: at, agentChecks: checks } });

describe('factory stats', () => {
  it('counts gates, send-backs, rework, agent check catches, cost and time to merge, by factory config', () => {
    const items = [
      {
        wi: { id: 'a', state: 'merged', spentUsd: 3, tasks: [task({ reworkLoops: 1 })] } as unknown as WorkItem,
        events: [
          ev('work_item_received', '2026-11-20T10:00:00Z'),
          ev('task_evidence_recorded', '2026-11-20T10:10:00Z', evidence('aaaaaaaaaaaa', 'rework', '2026-11-20T10:10:00Z', [{ name: 'security', blocking: true, verdict: 'rework', reasons: ['x'] }])),
          ev('task_verified', '2026-11-20T10:10:00Z', { verdict: 'rework' }),
          ev('task_evidence_recorded', '2026-11-20T10:30:00Z', evidence('aaaaaaaaaaaa', 'pass', '2026-11-20T10:30:00Z', [{ name: 'security', blocking: true, verdict: 'pass', reasons: [] }])),
          ev('task_verified', '2026-11-20T10:30:00Z', { verdict: 'pass' }),
          ev('gate_decided', '2026-11-20T11:00:00Z', { gate: 'change_approval', verdict: 'approved', mode: 'human' }),
          ev('task_merged', '2026-11-20T12:00:00Z'),
        ],
      },
      {
        wi: { id: 'b', state: 'escalated', spentUsd: 1, tasks: [task({ state: 'escalated' })] } as unknown as WorkItem,
        events: [
          ev('work_item_received', '2026-11-21T10:00:00Z'),
          ev('task_evidence_recorded', '2026-11-21T10:10:00Z', evidence('bbbbbbbbbbbb', 'escalate', '2026-11-21T10:10:00Z', [{ name: 'security', blocking: false, verdict: 'escalate', couldNotCheck: 'ceiling', reasons: [] }])),
          ev('task_verified', '2026-11-21T10:10:00Z', { verdict: 'escalate' }),
        ],
      },
      { wi: { id: 'old', state: 'merged', spentUsd: 9, tasks: [task({})] } as unknown as WorkItem, events: [ev('work_item_received', '2026-10-01T10:00:00Z')] },
    ];
    const s = computeStats(items, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-23T00:00:00Z'));
    expect(s.workItems).toBe(2);
    expect(s.tasks).toMatchObject({ total: 2, merged: 1, escalated: 1 });
    expect(s.firstPass).toBe(0);
    expect(s.reworkPerMerged).toBe(1);
    expect(s.verify).toEqual({ runs: 3, pass: 1, rework: 1, escalate: 1 });
    expect(s.gates.change_approval).toEqual({ approved: 1, rejected: 0, byPerson: 1 });
    expect(s.agentChecks.security).toEqual({ runs: 3, rework: 1, escalate: 0, couldNotCheck: 1, blocking: 2 });
    expect(s.costUsd).toBe(4);
    expect(s.costPerMergedUsd).toBe(4);
    expect(s.medianHoursToMerge).toBe(2);
    expect(s.byConfig.map((c) => [c.config, c.verifies, c.passed])).toEqual([['aaaaaaaaaaaa', 2, 1], ['bbbbbbbbbbbb', 1, 0]]);
    const text = formatStats(s, 'demo');
    expect(text).toContain('agent check security: 3 runs, 1 sent back, 0 escalated, 1 couldn\'t check (1 as advisory)');
    expect(text).toContain('time to merge    median 2.0 h from the request');
    expect(text).toContain('aaaaaaaaaa  2026-11-20 to 2026-11-20: 2 Verify runs, 1 passed (50%)');
  });
});

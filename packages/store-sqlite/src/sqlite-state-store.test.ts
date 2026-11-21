import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { applyEvent, fromStoredEvent, replay, toNewEvent, type WorkItem, type WorkItemEvent } from '@cradleworks/core';
import type { NewEvent } from '@cradleworks/interfaces';
import { describeStateStoreContract } from '@cradleworks/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStateStore } from './index.ts';

const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, s)).toISOString();
const e = (type: string, payload: unknown = {}, s = 0): NewEvent => ({ type, payload, at: at(s) });


describeStateStoreContract('sqlite in memory', async () => ({ store: new SqliteStateStore({ path: ':memory:' }), cleanup: async () => {} }));

describeStateStoreContract('sqlite on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-store-contract-'));
  const path = join(dir, 'state.db');
  return {
    store: new SqliteStateStore({ path }),
    openSecond: async () => new SqliteStateStore({ path }),
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
});

describe('rebuilding a work item from the store', () => {
  const ev = (event: Record<string, unknown>, s: number) => ({ ...event, at: at(s) }) as WorkItemEvent;
  const events: WorkItemEvent[] = [
    ev({ type: 'work_item_received', workItemId: 'wi_1', source: { id: 'i-1', url: 'https://t.example/1' }, requester: 'alex', projectId: 'p', title: 'Export', maxReworkLoops: 2 }, 0),
    ev({ type: 'specifying_started' }, 1),
    ev({ type: 'spec_drafted', specId: 'spec_1', version: 1 }, 2),
    ev({ type: 'gate_decided', decisionId: 'g1', gate: 'spec_approval', subjectId: 'spec_1', mode: 'human', decidedBy: 'sam', verdict: 'approved', reason: 'ok' }, 3),
    ev({ type: 'tasks_planned', tasks: [{ taskId: 't1', title: 'API', dependsOn: [], size: 'small' }] }, 4),
    ev({ type: 'gate_decided', decisionId: 'g2', gate: 'plan_check', subjectId: 'wi_1', mode: 'ai', decidedBy: 'reviewer', verdict: 'approved', reason: 'ok' }, 5),
    ev({ type: 'task_started', taskId: 't1', branch: 'factory/t1' }, 6),
    ev({ type: 'task_pr_opened', taskId: 't1', pr: { id: 'pr-1', url: 'https://scm.example/pr/1' } }, 7),
    ev({ type: 'task_built', taskId: 't1' }, 8),
    ev({ type: 'task_verified', taskId: 't1', verdict: 'rework', reason: 'test failed' }, 9),
    ev({ type: 'task_rework_started', taskId: 't1' }, 10),
    ev({ type: 'task_built', taskId: 't1' }, 11),
    ev({ type: 'task_verified', taskId: 't1', verdict: 'pass', reason: 'green' }, 12),
  ];

  it('matches a full replay when rebuilt from a snapshot plus later events', async () => {
    const store = new SqliteStateStore({ path: ':memory:' });
    await store.append('wi_1', events.slice(0, 7).map(toNewEvent), 0);
    const atSeven = replay((await store.readStream('wi_1')).map(fromStoredEvent))!;
    await store.saveSnapshot({ streamId: 'wi_1', seq: 7, state: atSeven });
    await store.append('wi_1', events.slice(7).map(toNewEvent), 7);

    const snapshot = (await store.loadSnapshot('wi_1'))!;
    const tail = (await store.readStream('wi_1', snapshot.seq + 1)).map(fromStoredEvent);
    const rebuilt = tail.reduce<WorkItem>((state, event) => applyEvent(state, event), snapshot.state as WorkItem);

    const full = replay((await store.readStream('wi_1')).map(fromStoredEvent));
    expect(rebuilt).toEqual(full);
    expect(full).toEqual(replay(events));
    expect(rebuilt.tasks[0]).toMatchObject({ state: 'ready', reworkLoops: 1 });
    await store.close();
  });
});

describe('on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists across reopen and creates parent folders', async () => {
    const path = join(dir, 'nested', 'state.db');
    const first = new SqliteStateStore({ path });
    await first.append('a', [e('x'), e('y')]);
    await first.saveSnapshot({ streamId: 'a', seq: 2, state: { ok: true } });
    await first.close();

    const second = new SqliteStateStore({ path });
    expect((await second.readStream('a')).map((s) => s.type)).toEqual(['x', 'y']);
    expect(await second.loadSnapshot('a')).toEqual({ streamId: 'a', seq: 2, state: { ok: true } });
    expect((await second.append('a', [e('z')], 2))[0]?.seq).toBe(3);
    await second.close();
  });

  it('keeps the log append-only even for direct SQL', async () => {
    const path = join(dir, 'state.db');
    const s = new SqliteStateStore({ path });
    await s.append('a', [e('x')]);
    await s.close();

    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE events SET type = 'tampered'")).toThrow(/append-only/);
    expect(() => raw.exec('DELETE FROM events')).toThrow(/append-only/);
    raw.close();
  });

  it('refuses a database from a different schema version', async () => {
    const path = join(dir, 'state.db');
    await new SqliteStateStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    raw.close();
    expect(() => new SqliteStateStore({ path })).toThrow(/schema version 99/);
  });

  it('stays consistent with several processes appending at once', { timeout: 60_000 }, async () => {
    const path = join(dir, 'shared.db');
    await new SqliteStateStore({ path }).close();
    const writer = fileURLToPath(new URL('./concurrent-writer.fixture.ts', import.meta.url));
    const writers = 4;
    const each = 25;
    const results = await Promise.all(
      Array.from({ length: writers }, (_, w) => promisify(execFile)(process.execPath, [writer, path, `w${w}`, String(each)])),
    );
    for (const r of results) expect(JSON.parse(r.stdout)).toHaveProperty('conflicts');

    const store = new SqliteStateStore({ path });
    const events = await store.readStream('shared');
    await store.close();
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: writers * each }, (_, i) => i + 1));
    for (let w = 0; w < writers; w++) {
      const mine = events.filter((e) => (e.payload as { writer: string }).writer === `w${w}`).map((e) => (e.payload as { i: number }).i);
      expect(mine).toEqual(Array.from({ length: each }, (_, i) => i));
    }
  });
});

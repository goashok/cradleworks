import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyEvent, fromStoredEvent, replay, toNewEvent, type WorkItem, type WorkItemEvent } from '@cradleworks/core';
import { AdapterError, type NewEvent } from '@cradleworks/interfaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStateStore } from './index.ts';

const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, s)).toISOString();
const e = (type: string, payload: unknown = {}, s = 0): NewEvent => ({ type, payload, at: at(s) });

async function expectAdapterError(promise: Promise<unknown>, code: AdapterError['code']) {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AdapterError);
  expect((error as AdapterError).code).toBe(code);
}

let store: SqliteStateStore;
beforeEach(() => {
  store = new SqliteStateStore({ path: ':memory:' });
});
afterEach(async () => {
  await store.close();
});

describe('append and read', () => {
  it('numbers events per stream and globally', async () => {
    const a = await store.append('a', [e('x'), e('y')]);
    const b = await store.append('b', [e('x')]);
    const a2 = await store.append('a', [e('z')]);
    expect(a.map((s) => [s.seq, s.position])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(b.map((s) => [s.seq, s.position])).toEqual([[1, 3]]);
    expect(a2.map((s) => [s.seq, s.position])).toEqual([[3, 4]]);
    expect((await store.readStream('a')).map((s) => s.type)).toEqual(['x', 'y', 'z']);
    expect((await store.readStream('a', 3)).map((s) => s.type)).toEqual(['z']);
  });

  it('round-trips payloads and timestamps', async () => {
    const payload = { n: 1, list: ['a', { deep: true }], none: null };
    await store.append('a', [e('x', payload, 7)]);
    const [read] = await store.readStream('a');
    expect(read).toMatchObject({ streamId: 'a', seq: 1, type: 'x', payload, at: at(7) });
  });

  it('enforces expectedSeq', async () => {
    await store.append('a', [e('x')], 0);
    await store.append('a', [e('y')], 1);
    await expectAdapterError(store.append('a', [e('z')], 1), 'conflict');
    await expectAdapterError(store.append('new', [e('z')], 3), 'conflict');
    expect(await store.readStream('a')).toHaveLength(2);
  });

  it('writes all events of a call or none', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expectAdapterError(store.append('a', [e('ok'), e('bad', circular)]), 'invalid_input');
    await expectAdapterError(store.append('a', [e('ok'), { type: 'bad', payload: undefined, at: at(0) }]), 'invalid_input');
    expect(await store.readStream('a')).toEqual([]);
  });

  it('treats an empty append as a no-op that still checks expectedSeq', async () => {
    expect(await store.append('a', [], 0)).toEqual([]);
    await expectAdapterError(store.append('a', [], 5), 'conflict');
  });
});

describe('query', () => {
  beforeEach(async () => {
    await store.append('a', [e('x'), e('y')]);
    await store.append('b', [e('x'), e('z')]);
  });

  it('filters by stream, type and position, in global order', async () => {
    const pos = async (q: Parameters<SqliteStateStore['query']>[0]) => (await store.query(q)).map((s) => s.position);
    expect(await pos({})).toEqual([1, 2, 3, 4]);
    expect(await pos({ streamIds: ['b'] })).toEqual([3, 4]);
    expect(await pos({ types: ['x'] })).toEqual([1, 3]);
    expect(await pos({ types: ['x', 'z'], streamIds: ['b'] })).toEqual([3, 4]);
    expect(await pos({ afterPosition: 2 })).toEqual([3, 4]);
    expect(await pos({ limit: 1, afterPosition: 1 })).toEqual([2]);
    expect(await pos({ streamIds: [] })).toEqual([]);
  });

  it('rejects a bad limit', async () => {
    await expectAdapterError(store.query({ limit: -1 }), 'invalid_input');
  });
});

describe('snapshots', () => {
  it('saves, loads and keeps the newest', async () => {
    await store.append('a', [e('x'), e('y'), e('z')]);
    expect(await store.loadSnapshot('a')).toBeUndefined();
    await store.saveSnapshot({ streamId: 'a', seq: 2, state: { n: 2 } });
    await store.saveSnapshot({ streamId: 'a', seq: 1, state: { n: 1 } });
    expect(await store.loadSnapshot('a')).toEqual({ streamId: 'a', seq: 2, state: { n: 2 } });
    await store.saveSnapshot({ streamId: 'a', seq: 3, state: { n: 3 } });
    expect((await store.loadSnapshot('a'))?.seq).toBe(3);
  });

  it('refuses a snapshot past the end of its stream', async () => {
    await store.append('a', [e('x')]);
    await expectAdapterError(store.saveSnapshot({ streamId: 'a', seq: 2, state: {} }), 'invalid_input');
    await expectAdapterError(store.saveSnapshot({ streamId: 'none', seq: 1, state: {} }), 'invalid_input');
  });
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

  it('fails clearly after close', async () => {
    const s = new SqliteStateStore({ path: ':memory:' });
    await s.close();
    await s.close(); // idempotent
    await expectAdapterError(s.readStream('a'), 'unavailable');
  });
});

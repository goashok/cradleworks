import type { NewEvent, StateStore } from '@cradleworks/interfaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectAdapterError } from './assert.ts';

export interface StateStoreFixture {
  store: StateStore;
  /** A second handle on the same storage, where the store supports that. */
  openSecond?: () => Promise<StateStore>;
  cleanup(): Promise<void>;
}

const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, s)).toISOString();
const e = (type: string, payload: unknown = {}, s = 0): NewEvent => ({ type, payload, at: at(s) });

export function describeStateStoreContract(name: string, setup: () => Promise<StateStoreFixture>): void {
  describe(`StateStore contract: ${name}`, () => {
    let f: StateStoreFixture;
    beforeEach(async () => {
      f = await setup();
    });
    afterEach(async () => {
      await f.store.close();
      await f.cleanup();
    });

    it('numbers events per stream and globally', async () => {
      const a = await f.store.append('a', [e('x'), e('y')]);
      const b = await f.store.append('b', [e('x')]);
      const a2 = await f.store.append('a', [e('z')]);
      expect(a.map((s) => s.seq)).toEqual([1, 2]);
      expect(b.map((s) => s.seq)).toEqual([1]);
      expect(a2.map((s) => s.seq)).toEqual([3]);
      const positions = [...a, ...b, ...a2].map((s) => s.position);
      expect([...positions].sort((x, y) => x - y)).toEqual(positions);
      expect(new Set(positions).size).toBe(4);
      expect((await f.store.readStream('a')).map((s) => s.type)).toEqual(['x', 'y', 'z']);
      expect((await f.store.readStream('a', 3)).map((s) => s.type)).toEqual(['z']);
    });

    it('round-trips payloads and timestamps', async () => {
      const payload = { n: 1, list: ['a', { deep: true }], none: null };
      await f.store.append('a', [e('x', payload, 7)]);
      expect((await f.store.readStream('a'))[0]).toMatchObject({ streamId: 'a', seq: 1, type: 'x', payload, at: at(7) });
    });

    it('enforces expectedSeq', async () => {
      await f.store.append('a', [e('x')], 0);
      await f.store.append('a', [e('y')], 1);
      await expectAdapterError(f.store.append('a', [e('z')], 1), 'conflict');
      await expectAdapterError(f.store.append('new', [e('z')], 3), 'conflict');
      expect(await f.store.readStream('a')).toHaveLength(2);
    });

    it('writes all events of a call or none', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expectAdapterError(f.store.append('a', [e('ok'), e('bad', circular)]), 'invalid_input');
      await expectAdapterError(f.store.append('a', [e('ok'), { type: 'bad', payload: undefined, at: at(0) }]), 'invalid_input');
      expect(await f.store.readStream('a')).toEqual([]);
    });

    it('treats an empty append as a no-op that still checks expectedSeq', async () => {
      expect(await f.store.append('a', [], 0)).toEqual([]);
      await expectAdapterError(f.store.append('a', [], 5), 'conflict');
    });

    it('filters queries by stream, type and position, in global order', async () => {
      await f.store.append('a', [e('x'), e('y')]);
      await f.store.append('b', [e('x'), e('z')]);
      const all = await f.store.query({});
      const p = all.map((s) => s.position);
      const pos = async (q: Parameters<StateStore['query']>[0]) => (await f.store.query(q)).map((s) => s.position);
      expect(all.map((s) => `${s.streamId}${s.seq}`)).toEqual(['a1', 'a2', 'b1', 'b2']);
      expect(await pos({ streamIds: ['b'] })).toEqual([p[2], p[3]]);
      expect(await pos({ types: ['x'] })).toEqual([p[0], p[2]]);
      expect(await pos({ types: ['x', 'z'], streamIds: ['b'] })).toEqual([p[2], p[3]]);
      expect(await pos({ afterPosition: p[1]! })).toEqual([p[2], p[3]]);
      expect(await pos({ limit: 1, afterPosition: p[0]! })).toEqual([p[1]]);
      expect(await pos({ streamIds: [] })).toEqual([]);
      await expectAdapterError(f.store.query({ limit: -1 }), 'invalid_input');
    });

    it('keeps the newest snapshot', async () => {
      await f.store.append('a', [e('x'), e('y'), e('z')]);
      expect(await f.store.loadSnapshot('a')).toBeUndefined();
      await f.store.saveSnapshot({ streamId: 'a', seq: 2, state: { n: 2 } });
      await f.store.saveSnapshot({ streamId: 'a', seq: 1, state: { n: 1 } });
      expect(await f.store.loadSnapshot('a')).toEqual({ streamId: 'a', seq: 2, state: { n: 2 } });
      await f.store.saveSnapshot({ streamId: 'a', seq: 3, state: { n: 3 } });
      expect((await f.store.loadSnapshot('a'))?.seq).toBe(3);
    });

    it('refuses a snapshot past the end of its stream', async () => {
      await f.store.append('a', [e('x')]);
      await expectAdapterError(f.store.saveSnapshot({ streamId: 'a', seq: 2, state: {} }), 'invalid_input');
      await expectAdapterError(f.store.saveSnapshot({ streamId: 'none', seq: 1, state: {} }), 'invalid_input');
    });

    it('sees one consistent stream from two handles', async (ctx) => {
      if (!f.openSecond) return ctx.skip();
      const second = await f.openSecond();
      try {
        await f.store.append('a', [e('x')], 0);
        expect(await second.readStream('a')).toHaveLength(1);
        await expectAdapterError(second.append('a', [e('y')], 0), 'conflict');
        await second.append('a', [e('y')], 1);
        expect((await f.store.readStream('a')).map((s) => s.seq)).toEqual([1, 2]);
      } finally {
        await second.close();
      }
    });

    it('fails clearly after close', async () => {
      await f.store.close();
      await f.store.close();
      await expectAdapterError(f.store.readStream('a'), 'unavailable');
    });
  });
}

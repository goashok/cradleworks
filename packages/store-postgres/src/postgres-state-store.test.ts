// The StateStore contract and the Postgres-only rules (tenants, append-only, ordered positions)
// against a real server: CRADLEWORKS_TEST_POSTGRES_URL when set, otherwise a throwaway
// container. Skipped when neither is available. Each test gets its own schema.

import { randomBytes } from 'node:crypto';
import { describeStateStoreContract } from '@cradleworks/contracts';
import { AdapterError, type NewEvent } from '@cradleworks/interfaces';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresStateStore } from './index.ts';
import { testServer } from './testing.ts';

const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 12, 0, s)).toISOString();
const e = (type: string, payload: unknown = {}, s = 0): NewEvent => ({ type, payload, at: at(s) });

const pgServer = await testServer();
afterAll(() => pgServer?.stop());

const freshSchema = () => `cw_test_${randomBytes(6).toString('hex')}`;
async function dropSchema(schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: pgServer!.url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}

if (pgServer) {
  describeStateStoreContract('postgres', async () => {
    const schema = freshSchema();
    const open = () => PostgresStateStore.open({ connectionString: pgServer.url, schema });
    return { store: await open(), openSecond: open, cleanup: () => dropSchema(schema) };
  });
}

describe.skipIf(!pgServer)('PostgresStateStore', () => {
  const withSchema = async (fn: (schema: string) => Promise<void>) => {
    const schema = freshSchema();
    try {
      await fn(schema);
    } finally {
      await dropSchema(schema);
    }
  };

  it('keeps tenants apart: same stream ids, separate events and snapshots', () =>
    withSchema(async (schema) => {
      const a = await PostgresStateStore.open({ connectionString: pgServer!.url, schema, tenant: 'org_a' });
      const b = await PostgresStateStore.open({ connectionString: pgServer!.url, schema, tenant: 'org_b' });
      try {
        await a.append('wi_1', [e('x', { who: 'a' })], 0);
        await b.append('wi_1', [e('x', { who: 'b' }), e('y')], 0);
        expect((await a.readStream('wi_1')).map((s) => s.payload)).toEqual([{ who: 'a' }]);
        expect((await b.readStream('wi_1')).map((s) => s.seq)).toEqual([1, 2]);
        expect(await a.query({ types: ['y'] })).toEqual([]);
        await b.saveSnapshot({ streamId: 'wi_1', seq: 2, state: { b: true } });
        expect(await a.loadSnapshot('wi_1')).toBeUndefined();
      } finally {
        await a.close();
        await b.close();
      }
    }));

  it('refuses to change or delete an event, even with direct SQL', () =>
    withSchema(async (schema) => {
      const store = await PostgresStateStore.open({ connectionString: pgServer!.url, schema });
      await store.append('a', [e('x')], 0);
      await store.close();
      const client = new pg.Client({ connectionString: pgServer!.url });
      await client.connect();
      try {
        await expect(client.query(`UPDATE ${schema}.events SET type = 'y'`)).rejects.toThrow(/append-only/);
        await expect(client.query(`DELETE FROM ${schema}.events`)).rejects.toThrow(/append-only/);
        await expect(client.query(`TRUNCATE ${schema}.events`)).rejects.toThrow(/append-only/);
      } finally {
        await client.end();
      }
    }));

  it('lets exactly one of two racing writers append at the same seq, and keeps positions in commit order', () =>
    withSchema(async (schema) => {
      const stores = await Promise.all([0, 1, 2, 3].map(() => PostgresStateStore.open({ connectionString: pgServer!.url, schema })));
      try {
        const results = await Promise.allSettled(stores.map((s, i) => s.append('race', [e('x', { i })], 0)));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) if (r.status === 'rejected') expect((r.reason as AdapterError).code).toBe('conflict');

        // Many writers on different streams: what a reader sees after any position is complete.
        await Promise.all(stores.map((s, i) => Promise.all(Array.from({ length: 10 }, (_, n) => s.append(`s${i}-${n}`, [e('y'), e('z')], 0)))));
        const all = await stores[0]!.query({});
        const positions = all.map((s) => s.position);
        expect(positions).toEqual([...positions].sort((x, y) => x - y));
        expect(all).toHaveLength(1 + 4 * 10 * 2);
      } finally {
        await Promise.all(stores.map((s) => s.close()));
      }
    }));

  it('lets stores open while others append and save snapshots, as many factory processes on one database do', () =>
    withSchema(async (schema) => {
      const open = (tenant: string) => PostgresStateStore.open({ connectionString: pgServer!.url, schema, tenant });
      const first = await open('t0');
      const errors: unknown[] = [];
      // Writers keep appending and saving snapshots, each in its own tenant, while new stores open.
      const writers = [1, 2, 3].map(async (w) => {
        const store = await open(`t${w}`);
        try {
          for (let n = 0; n < 40; n++) {
            const [last] = (await store.append(`s${n}`, [e('a'), e('b')], 0)).slice(-1);
            await store.saveSnapshot({ streamId: `s${n}`, seq: last!.seq, state: { n } });
          }
        } catch (error) {
          errors.push(error);
        } finally {
          await store.close();
        }
      });
      const openers = Array.from({ length: 30 }, async (_, i) => {
        try {
          const s = await open(`o${i}`);
          await s.readStream('x');
          await s.close();
        } catch (error) {
          errors.push(error);
        }
      });
      await Promise.all([...writers, ...openers]);
      await first.close();
      expect(errors.map((x) => (x as Error).message)).toEqual([]);
    }), 60_000);

  it('creates its schema once when several start together, and refuses a newer schema version', () =>
    withSchema(async (schema) => {
      const stores = await Promise.all([0, 1, 2].map(() => PostgresStateStore.open({ connectionString: pgServer!.url, schema })));
      await Promise.all(stores.map((s) => s.close()));
      const client = new pg.Client({ connectionString: pgServer!.url });
      await client.connect();
      await client.query(`UPDATE ${schema}.meta SET value = '99' WHERE key = 'schema_version'`);
      await client.end();
      await expect(PostgresStateStore.open({ connectionString: pgServer!.url, schema })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/schema version 99/) });
    }));

  it('reports a server it cannot reach as unavailable, and a bad schema name as invalid input', async () => {
    await expect(PostgresStateStore.open({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(PostgresStateStore.open({ connectionString: pgServer!.url, schema: 'Robert"); DROP' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

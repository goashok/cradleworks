// The CLI keeps its state in SQLite in the factory home, or in Postgres when
// CRADLEWORKS_DATABASE_URL is set; then two factory homes (two machines) share it.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNewEvent, type WorkItemEvent } from '@cradleworks/core';
import { testServer } from '@cradleworks/store-postgres/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './index.ts';
import { openStore } from './store.ts';

const pgServer = await testServer();
afterAll(() => pgServer?.stop());

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-cli-store-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const received: WorkItemEvent = {
  type: 'work_item_received',
  at: '2026-11-25T12:00:00.000Z',
  workItemId: 'wi_shared',
  source: { id: 'submitted:1', url: 'file:///task.md' },
  requester: 'alex',
  projectId: 'demo',
  title: 'Shared through the database',
  maxReworkLoops: 2,
};

describe('openStore', () => {
  it('uses SQLite in the factory home when no database URL is set', async () => {
    const store = await openStore({}, join(root, 'home'));
    expect(store.id).toBe('sqlite');
    await store.close();
    expect(existsSync(join(root, 'home', 'state.db'))).toBe(true);
  });

  it.skipIf(!pgServer)('uses Postgres when CRADLEWORKS_DATABASE_URL is set, so two factory homes see the same work', async () => {
    const schema = `cw_cli_${randomBytes(6).toString('hex')}`;
    const env = { CRADLEWORKS_DATABASE_URL: pgServer!.url, CRADLEWORKS_DATABASE_SCHEMA: schema, USER: 'tester' };
    try {
      const first = await openStore(env, join(root, 'a'));
      expect(first.id).toBe('postgres');
      await first.append('wi_shared', [toNewEvent(received)], 0);
      await first.close();
      expect(existsSync(join(root, 'a', 'state.db'))).toBe(false);

      let stdout = '';
      const code = await run(['status'], { cwd: root, env: { ...env, CRADLEWORKS_HOME: join(root, 'b') }, stdout: (t) => (stdout += t), stderr: () => undefined });
      expect(code).toBe(0);
      expect(stdout).toMatch(/wi_shared\s+received\s+0\/0\s+demo\s+Shared through the database/);

      // Another tenant on the same database sees none of it.
      let other = '';
      await run(['status'], { cwd: root, env: { ...env, CRADLEWORKS_TENANT: 'someone-else', CRADLEWORKS_HOME: join(root, 'c') }, stdout: (t) => (other += t), stderr: () => undefined });
      expect(other).not.toContain('wi_shared');
    } finally {
      const client = new pg.Client({ connectionString: pgServer!.url });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });
});

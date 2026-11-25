// StateStore on PostgreSQL, for a factory that runs as a service: several workers, one database.
// Same rules as the SQLite store: the events table is append-only (triggers refuse UPDATE and
// DELETE), so the log is the audit trail, and a stream's seq has no gaps.
//
// Two things are specific to a shared database:
// - Every row carries a tenant. A store reads and writes only its own tenant's rows; until the
//   service has organisations, every store uses the same one.
// - Appends take one database-wide lock for their transaction, so global positions become
//   visible in order. Without it, a reader asking for events after position N could miss one
//   whose transaction committed after a later position's. Appends are a few rows each; the lock
//   costs little at the factory's write rate.

import pg from 'pg';
import {
  AdapterError,
  type EventQuery,
  type NewEvent,
  type Snapshot,
  type StateStore,
  type StoredEvent,
} from '@cradleworks/interfaces';

const ADAPTER = 'postgres';
const SCHEMA_VERSION = 1;
/** Key for the advisory lock that orders appends (and serialises migrations). */
const APPEND_LOCK = 0x63770001;
const MIGRATE_LOCK = 0x63770002;
/** Tries for a transaction the server aborted for a deadlock or serialisation failure. */
const RETRIES = 4;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const schemaSql = (s: string) => `
CREATE TABLE IF NOT EXISTS ${s}.events (
  position  BIGSERIAL PRIMARY KEY,
  tenant    TEXT    NOT NULL,
  stream_id TEXT    NOT NULL,
  seq       INTEGER NOT NULL CHECK (seq >= 1),
  type      TEXT    NOT NULL,
  payload   JSONB   NOT NULL,
  at        TEXT    NOT NULL,
  UNIQUE (tenant, stream_id, seq)
);
CREATE INDEX IF NOT EXISTS events_by_type ON ${s}.events (tenant, type, position);
CREATE INDEX IF NOT EXISTS events_by_position ON ${s}.events (tenant, position);

CREATE OR REPLACE FUNCTION ${s}.events_append_only() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'events are append-only'; END $$;
DROP TRIGGER IF EXISTS events_no_change ON ${s}.events;
CREATE TRIGGER events_no_change BEFORE UPDATE OR DELETE ON ${s}.events
  FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();
DROP TRIGGER IF EXISTS events_no_truncate ON ${s}.events;
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON ${s}.events
  FOR EACH STATEMENT EXECUTE FUNCTION ${s}.events_append_only();

CREATE TABLE IF NOT EXISTS ${s}.snapshots (
  tenant    TEXT    NOT NULL,
  stream_id TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  state     JSONB   NOT NULL,
  PRIMARY KEY (tenant, stream_id)
);

CREATE TABLE IF NOT EXISTS ${s}.meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface EventRow {
  position: string;
  stream_id: string;
  seq: number;
  type: string;
  payload: unknown;
  at: string;
}

export interface PostgresStateStoreOptions {
  /** A `postgres://` URL. Read it from the environment; never put a password in a file. */
  connectionString: string;
  /** Schema the tables live in, created if missing. Default `cradleworks`. */
  schema?: string;
  /** Whose rows this store reads and writes. Default `default`. */
  tenant?: string;
  /** Connections in the pool. Default 5. */
  maxConnections?: number;
}

export class PostgresStateStore implements StateStore {
  readonly id = ADAPTER;
  readonly #pool: pg.Pool;
  readonly #s: string;
  readonly #tenant: string;
  #closed = false;

  private constructor(pool: pg.Pool, schema: string, tenant: string) {
    this.#pool = pool;
    this.#s = schema;
    this.#tenant = tenant;
  }

  /** Connects, creates or checks the schema, and returns a store ready to use. */
  static async open(options: PostgresStateStoreOptions): Promise<PostgresStateStore> {
    const schema = options.schema ?? 'cradleworks';
    if (!NAME.test(schema)) throw invalid('open', `schema "${schema}" must be lowercase letters, digits and underscores`);
    const tenant = options.tenant ?? 'default';
    if (tenant === '') throw invalid('open', 'tenant must not be empty');
    const pool = new pg.Pool({ connectionString: options.connectionString, max: options.maxConnections ?? 5 });
    // An idle connection the server drops must not crash the process; the next query reconnects.
    pool.on('error', () => undefined);
    const store = new PostgresStateStore(pool, schema, tenant);
    try {
      await store.#migrate();
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw translate(error, 'open');
    }
    return store;
  }

  async append(streamId: string, events: NewEvent[], expectedSeq?: number): Promise<StoredEvent[]> {
    this.#assertOpen('append');
    if (streamId === '') throw invalid('append', 'streamId must not be empty');
    const rows = events.map((e) => ({ ...e, json: serialise(e.payload, 'append') }));
    return this.#transaction('append', async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK]);
      const last = await this.#lastSeq(c, streamId);
      if (expectedSeq !== undefined && last !== expectedSeq) {
        throw new AdapterError('conflict', `stream ${streamId} is at seq ${last}, expected ${expectedSeq}`, { adapter: ADAPTER, operation: 'append' });
      }
      const stored: StoredEvent[] = [];
      for (const [i, row] of rows.entries()) {
        const seq = last + i + 1;
        const result = await c.query<{ position: string; payload: unknown }>(
          `INSERT INTO ${this.#s}.events (tenant, stream_id, seq, type, payload, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING position, payload`,
          [this.#tenant, streamId, seq, row.type, row.json, row.at],
        );
        const inserted = result.rows[0]!;
        stored.push({ streamId, seq, position: Number(inserted.position), type: row.type, payload: inserted.payload, at: row.at });
      }
      return stored;
    });
  }

  async readStream(streamId: string, fromSeq = 1): Promise<StoredEvent[]> {
    this.#assertOpen('readStream');
    const result = await this.#query<EventRow>('readStream', `SELECT * FROM ${this.#s}.events WHERE tenant = $1 AND stream_id = $2 AND seq >= $3 ORDER BY seq`, [
      this.#tenant,
      streamId,
      fromSeq,
    ]);
    return result.rows.map(toStored);
  }

  async query(query: EventQuery): Promise<StoredEvent[]> {
    this.#assertOpen('query');
    const where = ['tenant = $1'];
    const params: unknown[] = [this.#tenant];
    const param = (value: unknown) => `$${params.push(value)}`;
    if (query.streamIds) {
      if (query.streamIds.length === 0) return [];
      where.push(`stream_id = ANY(${param(query.streamIds)}::text[])`);
    }
    if (query.types) {
      if (query.types.length === 0) return [];
      where.push(`type = ANY(${param(query.types)}::text[])`);
    }
    if (query.afterPosition !== undefined) where.push(`position > ${param(query.afterPosition)}`);
    let sql = `SELECT * FROM ${this.#s}.events WHERE ${where.join(' AND ')} ORDER BY position`;
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 0) throw invalid('query', 'limit must be a non-negative integer');
      sql += ` LIMIT ${param(query.limit)}`;
    }
    return (await this.#query<EventRow>('query', sql, params)).rows.map(toStored);
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.#assertOpen('saveSnapshot');
    const state = serialise(snapshot.state, 'saveSnapshot');
    await this.#transaction('saveSnapshot', async (c) => {
      const last = await this.#lastSeq(c, snapshot.streamId);
      if (!Number.isInteger(snapshot.seq) || snapshot.seq < 1 || snapshot.seq > last) {
        throw invalid('saveSnapshot', `seq ${snapshot.seq} is outside stream ${snapshot.streamId} (last seq ${last})`);
      }
      // Keeps the newest snapshot: an older one never replaces a newer one.
      await c.query(
        `INSERT INTO ${this.#s}.snapshots (tenant, stream_id, seq, state) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant, stream_id) DO UPDATE SET seq = excluded.seq, state = excluded.state
         WHERE excluded.seq >= ${this.#s}.snapshots.seq`,
        [this.#tenant, snapshot.streamId, snapshot.seq, state],
      );
    });
  }

  async loadSnapshot(streamId: string): Promise<Snapshot | undefined> {
    this.#assertOpen('loadSnapshot');
    const result = await this.#query<{ seq: number; state: unknown }>('loadSnapshot', `SELECT seq, state FROM ${this.#s}.snapshots WHERE tenant = $1 AND stream_id = $2`, [
      this.#tenant,
      streamId,
    ]);
    const row = result.rows[0];
    return row ? { streamId, seq: row.seq, state: row.state } : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }

  async #migrate(): Promise<void> {
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      // Two services starting at once would race on CREATE ... IF NOT EXISTS; take turns.
      await c.query('SELECT pg_advisory_xact_lock($1)', [MIGRATE_LOCK]);
      // A schema already at this version is left alone: recreating its triggers takes the
      // strongest lock on the events table, and with other processes appending that deadlocks.
      const ready = (await c.query<{ meta: string | null }>(`SELECT to_regclass('${this.#s}.meta') AS meta`)).rows[0]?.meta;
      if (ready) {
        const current = (await c.query<{ value: string }>(`SELECT value FROM ${this.#s}.meta WHERE key = 'schema_version'`)).rows[0];
        if (current && Number(current.value) === SCHEMA_VERSION) {
          await c.query('COMMIT');
          return;
        }
      }
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.#s}`);
      await c.query(schemaSql(this.#s));
      const row = (await c.query<{ value: string }>(`SELECT value FROM ${this.#s}.meta WHERE key = 'schema_version'`)).rows[0];
      if (!row) {
        await c.query(`INSERT INTO ${this.#s}.meta (key, value) VALUES ('schema_version', $1)`, [String(SCHEMA_VERSION)]);
      } else if (Number(row.value) !== SCHEMA_VERSION) {
        throw invalid('open', `database schema version ${row.value} is not supported (expected ${SCHEMA_VERSION})`);
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  async #lastSeq(c: pg.PoolClient, streamId: string): Promise<number> {
    const result = await c.query<{ last: number | null }>(`SELECT MAX(seq) AS last FROM ${this.#s}.events WHERE tenant = $1 AND stream_id = $2`, [this.#tenant, streamId]);
    return result.rows[0]?.last ?? 0;
  }

  async #query<R extends pg.QueryResultRow>(operation: string, sql: string, params: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.#pool.query<R>(sql, params);
    } catch (error) {
      throw translate(error, operation);
    }
  }

  /**
   * Runs `fn` in a transaction. One the server aborts for a deadlock or a serialisation failure
   * rolled back entirely, so it runs again, a few times, as Postgres advises.
   */
  async #transaction<T>(operation: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let c: pg.PoolClient;
      try {
        c = await this.#pool.connect();
      } catch (error) {
        throw translate(error, operation);
      }
      try {
        await c.query('BEGIN');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        const code = (error as { code?: string }).code;
        if ((code === '40P01' || code === '40001') && attempt < RETRIES) {
          await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
          continue;
        }
        throw translate(error, operation);
      } finally {
        c.release();
      }
    }
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new AdapterError('unavailable', 'state store is closed', { adapter: ADAPTER, operation, retryable: false });
  }
}

function toStored(row: EventRow): StoredEvent {
  return { streamId: row.stream_id, seq: row.seq, position: Number(row.position), type: row.type, payload: row.payload, at: row.at };
}

function serialise(value: unknown, operation: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new AdapterError('invalid_input', 'value is not JSON-serialisable', { adapter: ADAPTER, operation, cause });
  }
  if (json === undefined) throw invalid(operation, 'value is not JSON-serialisable');
  return json;
}

function invalid(operation: string, message: string): AdapterError {
  return new AdapterError('invalid_input', message, { adapter: ADAPTER, operation });
}

/** Maps driver and server errors to AdapterError codes the core acts on. */
function translate(error: unknown, operation: string): AdapterError {
  if (error instanceof AdapterError) return error;
  const code = (error as { code?: string }).code ?? '';
  const message = (error as Error).message ?? String(error);
  const make = (c: ConstructorParameters<typeof AdapterError>[0], text = message) => new AdapterError(c, text, { adapter: ADAPTER, operation, cause: error });
  if (code === '23505') return make('conflict', 'another writer appended to this stream first');
  if (code === '28P01' || code === '28000') return make('unauthorized');
  if (code === '42501') return make('forbidden');
  if (code === '57014') return make('timeout');
  // Connection failures, a server shutting down or in recovery, too many connections.
  if (/^(08|53|57P)/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return make('unavailable');
  if (code === '22P02' || code === '22021' || code === '22P05') return make('invalid_input');
  return make('unknown');
}

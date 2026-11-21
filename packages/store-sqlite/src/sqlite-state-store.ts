// StateStore on SQLite via the node:sqlite built-in (no native build step).
// The events table is append-only: triggers refuse UPDATE and DELETE, so the
// log can serve as the audit trail (Build spec, section 9).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  AdapterError,
  type EventQuery,
  type NewEvent,
  type Snapshot,
  type StateStore,
  type StoredEvent,
} from '@cradleworks/interfaces';

const ADAPTER = 'sqlite';
const SCHEMA_VERSION = 1;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  position  INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT    NOT NULL,
  seq       INTEGER NOT NULL CHECK (seq >= 1),
  type      TEXT    NOT NULL,
  payload   TEXT    NOT NULL,
  at        TEXT    NOT NULL,
  UNIQUE (stream_id, seq)
);
CREATE INDEX IF NOT EXISTS events_by_type ON events (type, position);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS snapshots (
  stream_id TEXT    PRIMARY KEY,
  seq       INTEGER NOT NULL,
  state     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface EventRow {
  position: number;
  stream_id: string;
  seq: number;
  type: string;
  payload: string;
  at: string;
}

export interface SqliteStateStoreOptions {
  /** File path, or ":memory:" for tests. Parent folders are created. */
  path: string;
  /** Milliseconds to wait on a locked database before failing. Default 5000. */
  busyTimeoutMs?: number;
}

export class SqliteStateStore implements StateStore {
  readonly id = ADAPTER;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(options: SqliteStateStoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)};`);
    if (options.path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#db.exec(SCHEMA);
    this.#checkSchemaVersion();
  }

  async append(streamId: string, events: NewEvent[], expectedSeq?: number): Promise<StoredEvent[]> {
    this.#assertOpen('append');
    if (streamId === '') throw invalid('append', 'streamId must not be empty');
    const rows = events.map((e) => ({ ...e, json: serialise(e.payload, 'append') }));

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.#lastSeq(streamId);
      if (expectedSeq !== undefined && last !== expectedSeq) {
        throw new AdapterError('conflict', `stream ${streamId} is at seq ${last}, expected ${expectedSeq}`, {
          adapter: ADAPTER,
          operation: 'append',
        });
      }
      const insert = this.#db.prepare(
        'INSERT INTO events (stream_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?) RETURNING position',
      );
      const stored: StoredEvent[] = rows.map((row, i) => {
        const seq = last + i + 1;
        const { position } = insert.get(streamId, seq, row.type, row.json, row.at) as { position: number };
        return { streamId, seq, position, type: row.type, payload: JSON.parse(row.json), at: row.at };
      });
      this.#db.exec('COMMIT');
      return stored;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw translate(error, 'append');
    }
  }

  async readStream(streamId: string, fromSeq = 1): Promise<StoredEvent[]> {
    this.#assertOpen('readStream');
    const rows = this.#db
      .prepare('SELECT * FROM events WHERE stream_id = ? AND seq >= ? ORDER BY seq')
      .all(streamId, fromSeq) as unknown as EventRow[];
    return rows.map(toStored);
  }

  async query(query: EventQuery): Promise<StoredEvent[]> {
    this.#assertOpen('query');
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.streamIds) {
      if (query.streamIds.length === 0) return [];
      where.push(`stream_id IN (${query.streamIds.map(() => '?').join(', ')})`);
      params.push(...query.streamIds);
    }
    if (query.types) {
      if (query.types.length === 0) return [];
      where.push(`type IN (${query.types.map(() => '?').join(', ')})`);
      params.push(...query.types);
    }
    if (query.afterPosition !== undefined) {
      where.push('position > ?');
      params.push(query.afterPosition);
    }
    let sql = 'SELECT * FROM events';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY position';
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 0) throw invalid('query', 'limit must be a non-negative integer');
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    return (this.#db.prepare(sql).all(...params) as unknown as EventRow[]).map(toStored);
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.#assertOpen('saveSnapshot');
    const last = this.#lastSeq(snapshot.streamId);
    if (!Number.isInteger(snapshot.seq) || snapshot.seq < 1 || snapshot.seq > last) {
      throw invalid('saveSnapshot', `seq ${snapshot.seq} is outside stream ${snapshot.streamId} (last seq ${last})`);
    }
    // Keeps the newest snapshot: an older one never replaces a newer one.
    this.#db
      .prepare(
        `INSERT INTO snapshots (stream_id, seq, state) VALUES (?, ?, ?)
         ON CONFLICT (stream_id) DO UPDATE SET seq = excluded.seq, state = excluded.state
         WHERE excluded.seq >= snapshots.seq`,
      )
      .run(snapshot.streamId, snapshot.seq, serialise(snapshot.state, 'saveSnapshot'));
  }

  async loadSnapshot(streamId: string): Promise<Snapshot | undefined> {
    this.#assertOpen('loadSnapshot');
    const row = this.#db.prepare('SELECT seq, state FROM snapshots WHERE stream_id = ?').get(streamId) as
      | { seq: number; state: string }
      | undefined;
    return row ? { streamId, seq: row.seq, state: JSON.parse(row.state) } : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #lastSeq(streamId: string): number {
    const row = this.#db.prepare('SELECT MAX(seq) AS last FROM events WHERE stream_id = ?').get(streamId) as {
      last: number | null;
    };
    return row.last ?? 0;
  }

  #checkSchemaVersion(): void {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.#db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(row.value) !== SCHEMA_VERSION) {
      this.#db.close();
      this.#closed = true;
      throw invalid('open', `database schema version ${row.value} is not supported (expected ${SCHEMA_VERSION})`);
    }
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new AdapterError('unavailable', 'state store is closed', { adapter: ADAPTER, operation, retryable: false });
  }
}

function toStored(row: EventRow): StoredEvent {
  return {
    streamId: row.stream_id,
    seq: row.seq,
    position: row.position,
    type: row.type,
    payload: JSON.parse(row.payload),
    at: row.at,
  };
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

function translate(error: unknown, operation: string): unknown {
  if (error instanceof AdapterError) return error;
  const errcode = (error as { errcode?: number }).errcode;
  if (errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
    return new AdapterError('conflict', 'another writer appended to this stream first', {
      adapter: ADAPTER,
      operation,
      cause: error,
    });
  }
  return new AdapterError('unknown', (error as Error).message ?? String(error), { adapter: ADAPTER, operation, cause: error });
}

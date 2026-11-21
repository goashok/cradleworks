// StateStore held in memory. For tests of code that needs a store but not persistence.

import {
  AdapterError,
  type EventQuery,
  type NewEvent,
  type Snapshot,
  type StateStore,
  type StoredEvent,
} from '@cradleworks/interfaces';

const ADAPTER = 'memory';

export class InMemoryStateStore implements StateStore {
  readonly id = ADAPTER;
  readonly #events: StoredEvent[] = [];
  readonly #snapshots = new Map<string, Snapshot>();
  #closed = false;

  async append(streamId: string, events: NewEvent[], expectedSeq?: number): Promise<StoredEvent[]> {
    this.#open('append');
    if (streamId === '') throw fail('invalid_input', 'append', 'streamId must not be empty');
    const last = this.#lastSeq(streamId);
    if (expectedSeq !== undefined && last !== expectedSeq) {
      throw fail('conflict', 'append', `stream ${streamId} is at seq ${last}, expected ${expectedSeq}`);
    }
    const payloads = events.map((e) => copy(e.payload, 'append'));
    const stored = events.map((e, i) => ({
      streamId,
      seq: last + i + 1,
      position: this.#events.length + i + 1,
      type: e.type,
      payload: payloads[i],
      at: e.at,
    }));
    this.#events.push(...stored);
    return structuredClone(stored);
  }

  async readStream(streamId: string, fromSeq = 1): Promise<StoredEvent[]> {
    this.#open('readStream');
    return structuredClone(this.#events.filter((e) => e.streamId === streamId && e.seq >= fromSeq));
  }

  async query(query: EventQuery): Promise<StoredEvent[]> {
    this.#open('query');
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
      throw fail('invalid_input', 'query', 'limit must be a non-negative integer');
    }
    const matches = this.#events.filter(
      (e) =>
        (query.streamIds === undefined || query.streamIds.includes(e.streamId)) &&
        (query.types === undefined || query.types.includes(e.type)) &&
        (query.afterPosition === undefined || e.position > query.afterPosition),
    );
    return structuredClone(query.limit === undefined ? matches : matches.slice(0, query.limit));
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.#open('saveSnapshot');
    const last = this.#lastSeq(snapshot.streamId);
    if (!Number.isInteger(snapshot.seq) || snapshot.seq < 1 || snapshot.seq > last) {
      throw fail('invalid_input', 'saveSnapshot', `seq ${snapshot.seq} is outside stream ${snapshot.streamId} (last seq ${last})`);
    }
    const existing = this.#snapshots.get(snapshot.streamId);
    if (!existing || snapshot.seq >= existing.seq) {
      this.#snapshots.set(snapshot.streamId, { ...snapshot, state: copy(snapshot.state, 'saveSnapshot') });
    }
  }

  async loadSnapshot(streamId: string): Promise<Snapshot | undefined> {
    this.#open('loadSnapshot');
    const snapshot = this.#snapshots.get(streamId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #lastSeq(streamId: string): number {
    let last = 0;
    for (const e of this.#events) if (e.streamId === streamId) last = e.seq;
    return last;
  }

  #open(operation: string): void {
    if (this.#closed) throw new AdapterError('unavailable', 'state store is closed', { adapter: ADAPTER, operation, retryable: false });
  }
}

/** JSON round-trip, so the fake refuses what a real store would refuse. */
function copy(value: unknown, operation: string): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new AdapterError('invalid_input', 'value is not JSON-serialisable', { adapter: ADAPTER, operation, cause });
  }
  if (json === undefined) throw fail('invalid_input', operation, 'value is not JSON-serialisable');
  return JSON.parse(json);
}

function fail(code: AdapterError['code'], operation: string, message: string): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation });
}

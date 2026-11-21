import type { Timestamp } from './common.ts';

/** An event as appended. `payload` must be JSON-serialisable. */
export interface NewEvent {
  type: string;
  payload: unknown;
  at: Timestamp;
}

export interface StoredEvent extends NewEvent {
  /** A work item, spec, task or run id. */
  streamId: string;
  /** Strictly increasing within a stream, starting at 1. */
  seq: number;
  /** Global order across all streams. */
  position: number;
}

export interface EventQuery {
  streamIds?: string[];
  types?: string[];
  /** Only events with a global position greater than this. */
  afterPosition?: number;
  limit?: number;
}

export interface Snapshot {
  streamId: string;
  /** Last event seq folded into `state`. */
  seq: number;
  state: unknown;
}

export interface StateStore {
  readonly id: string;

  /**
   * Appends atomically. With `expectedSeq`, refuses (AdapterError `conflict`) unless the
   * stream's last seq equals it; 0 means the stream must be new.
   */
  append(streamId: string, events: NewEvent[], expectedSeq?: number): Promise<StoredEvent[]>;
  readStream(streamId: string, fromSeq?: number): Promise<StoredEvent[]>;
  query(query: EventQuery): Promise<StoredEvent[]>;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  loadSnapshot(streamId: string): Promise<Snapshot | undefined>;
  close(): Promise<void>;
}

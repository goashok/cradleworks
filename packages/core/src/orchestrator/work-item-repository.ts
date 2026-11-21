// Loads and appends a work item's stream. Every append is validated by the state machine
// first, then written with optimistic concurrency, so the log never holds an illegal event.

import type { StateStore } from '@cradleworks/interfaces';
import { fromStoredEvent, toNewEvent } from '../domain/event-codec.ts';
import type { WorkItemEvent } from '../domain/events.ts';
import type { WorkItem } from '../domain/types.ts';
import { applyEvent } from '../domain/work-item.ts';

export const SNAPSHOT_EVERY = 50;

export class WorkItemRepository {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  async load(workItemId: string): Promise<WorkItem | undefined> {
    const snapshot = await this.#store.loadSnapshot(workItemId);
    let state = snapshot ? (snapshot.state as WorkItem) : undefined;
    const tail = await this.#store.readStream(workItemId, (snapshot?.seq ?? 0) + 1);
    for (const stored of tail) state = applyEvent(state, fromStoredEvent(stored));
    return state;
  }

  /** Applies `events` to `current` (undefined for a new work item) and appends them. */
  async append(current: WorkItem | undefined, events: WorkItemEvent[]): Promise<WorkItem> {
    if (events.length === 0) {
      if (!current) throw new Error('nothing to append to a work item that does not exist');
      return current;
    }
    let next = current;
    for (const event of events) next = applyEvent(next, event);
    const state = next!;
    await this.#store.append(state.id, events.map(toNewEvent), current?.version ?? 0);
    const crossed = Math.floor(state.version / SNAPSHOT_EVERY) > Math.floor((current?.version ?? 0) / SNAPSHOT_EVERY);
    if (crossed) await this.#store.saveSnapshot({ streamId: state.id, seq: state.version, state });
    return state;
  }
}

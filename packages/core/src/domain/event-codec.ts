// Maps domain events to and from the StateStore's generic event shape.

import type { NewEvent, StoredEvent } from '@cradleworks/interfaces';
import { WORK_ITEM_EVENT_TYPES, type WorkItemEvent, type WorkItemEventType } from './events.ts';

export function toNewEvent(event: WorkItemEvent): NewEvent {
  const { type, at, ...payload } = event;
  return { type, at, payload };
}

export function fromStoredEvent(stored: StoredEvent): WorkItemEvent {
  if (!WORK_ITEM_EVENT_TYPES.has(stored.type as WorkItemEventType)) {
    throw new Error(`stream ${stored.streamId} seq ${stored.seq}: unknown event type "${stored.type}"`);
  }
  if (typeof stored.payload !== 'object' || stored.payload === null || Array.isArray(stored.payload)) {
    throw new Error(`stream ${stored.streamId} seq ${stored.seq}: payload must be an object`);
  }
  return { ...(stored.payload as object), type: stored.type, at: stored.at } as WorkItemEvent;
}

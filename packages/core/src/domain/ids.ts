import { randomUUID } from 'node:crypto';

export type IdKind = 'wi' | 'spec' | 'task' | 'run' | 'gate';

/** Prefixed random id, e.g. "task_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed". */
export function newId(kind: IdKind): string {
  return `${kind}_${randomUUID()}`;
}

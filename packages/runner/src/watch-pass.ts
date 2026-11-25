// One pass of the factory over a project's tracker: take in newly labelled items, cancel work
// whose item was closed, and move every open work item as far as it can go, up to the
// project's concurrency at a time. `factory watch` runs it on a timer; a hosted service runs
// it when a webhook says something changed. It reports what happens as events and prints
// nothing, so each caller shows them its own way.

import { TERMINAL_WORK_ITEM_STATES, type Orchestrator, type Project, type WorkItem, type WorkProgress } from '@cradleworks/core';
import type { ItemRef, Tracker } from '@cradleworks/interfaces';

/** What a pass works on: a project, the orchestrator that runs it, and its tracker. */
export interface PassTarget {
  project: Project;
  orchestrator: Orchestrator;
  tracker: Tracker;
}

/** What happened during a pass, in the order it happened (work items run in parallel). */
export type PassEvent =
  | { kind: 'list_failed'; error: string }
  | { kind: 'picked_up'; item: ItemRef; workItemId: string }
  | { kind: 'cancelled'; workItem: WorkItem; reason: string }
  | { kind: 'synced'; workItem: WorkItem; note: string }
  | { kind: 'progress'; workItem: WorkItem; progress: WorkProgress }
  /** Where a work item stands at the end of the pass; `changed` when it differs from the last pass. */
  | { kind: 'state'; workItem: WorkItem; state: string; waitingFor?: string; changed: boolean }
  | { kind: 'error'; workItem: WorkItem; error: string };

export interface PassOptions {
  /** Only items carrying this label are the factory's. */
  label: string;
  report?: (event: PassEvent) => void;
  /**
   * Where each work item stood after the previous pass, by work item id, so `state` events can
   * say what changed. Keep the same map across passes; the pass updates it.
   */
  lastState?: Map<string, string>;
}

/** Work items from the tracker that aren't finished, oldest first. */
export async function openWork(target: Pick<PassTarget, 'project' | 'orchestrator'>): Promise<WorkItem[]> {
  const all = await target.orchestrator.listWorkItems(target.project.config.project);
  return all.filter((wi) => !wi.source.id.startsWith('submitted:') && !TERMINAL_WORK_ITEM_STATES.has(wi.state)).reverse();
}

/**
 * Before the first pass after a start: closes the runs a stop cut off, so cut-off builds build
 * again. Returns one note per work item it changed.
 */
export async function recoverOpenWork(target: Pick<PassTarget, 'project' | 'orchestrator'>): Promise<Array<{ workItem: WorkItem; note: string }>> {
  const notes: Array<{ workItem: WorkItem; note: string }> = [];
  for (const wi of await openWork(target)) {
    for (const note of await target.orchestrator.recoverWorkItem(wi.id)) notes.push({ workItem: wi, note });
  }
  return notes;
}

/** One pass over the project's tracker. Errors on one work item are reported, never thrown. */
export async function runPass(target: PassTarget, options: PassOptions): Promise<void> {
  const { project, orchestrator, tracker } = target;
  const report = options.report ?? (() => undefined);
  let open: ItemRef[];
  try {
    open = await tracker.listOpen({ project: project.repo.id, labels: [options.label] });
  } catch (error) {
    report({ kind: 'list_failed', error: (error as Error).message });
    return;
  }
  for (const ref of open) {
    const { workItemId, created } = await orchestrator.receiveItem(project, ref);
    if (created) report({ kind: 'picked_up', item: ref, workItemId });
  }
  const listed = new Set(open.map((r) => r.id));
  const work: WorkItem[] = [];
  for (const wi of await openWork(target)) {
    if (listed.has(wi.source.id)) {
      work.push(wi);
      continue;
    }
    // Not listed: closed (cancel the work), or the label was taken off (paused).
    const item = await tracker.getItem(wi.source).catch(() => undefined);
    if (item?.state === 'closed') {
      const reason = 'the issue was closed';
      await orchestrator.cancelWorkItem(wi.id, reason);
      report({ kind: 'cancelled', workItem: wi, reason });
    }
  }
  await pool(work, project.config.concurrency, async (wi) => {
    try {
      for (const note of await orchestrator.syncWorkItem(project, wi.id)) report({ kind: 'synced', workItem: wi, note });
      const outcome = await orchestrator.runWorkItem(project, wi.id, (progress) => report({ kind: 'progress', workItem: wi, progress }));
      const now = outcome.waitingFor ? `${outcome.state}, waiting for ${outcome.waitingFor}` : outcome.state;
      const changed = options.lastState?.get(wi.id) !== now;
      options.lastState?.set(wi.id, now);
      report({ kind: 'state', workItem: wi, state: outcome.state, ...(outcome.waitingFor ? { waitingFor: outcome.waitingFor } : {}), changed });
    } catch (error) {
      report({ kind: 'error', workItem: wi, error: (error as Error).message });
    }
  });
}

/** Runs `fn` over the items, at most `size` at once. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
    }),
  );
}

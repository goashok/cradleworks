import type { ItemRef, Tracker, TrackerEvent } from '@cradleworks/interfaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectAdapterError } from './assert.ts';
import type { ContractOptions } from './source-control.contract.ts';

export interface TrackerFixture {
  adapter: Tracker;
  /** The tracker project the items live in, as `watch` takes it. */
  project: string;
  /** An open item carrying `label`, that the suite may comment on and relabel. */
  item: ItemRef;
  label: string;
  /** A handle that may decide gates, and one that may not. */
  approver: string;
  stranger: string;
  /** A well-formed reference to an item that does not exist. */
  missing: ItemRef;
  /** How long `watch` may take to report the item. */
  watchSeconds: number;
  cleanup(): Promise<void>;
}

export function describeTrackerContract(name: string, setup: () => Promise<TrackerFixture>, options: ContractOptions = {}): void {
  describe(`Tracker contract: ${name}`, { timeout: options.timeoutMs ?? 30_000 }, () => {
    let f: TrackerFixture;
    beforeAll(async () => {
      f = await setup();
    }, options.timeoutMs ?? 30_000);
    afterAll(async () => f?.cleanup());

    it('reads an item with its labels', async () => {
      const item = await f.adapter.getItem(f.item);
      expect(item.ref.id).toBe(f.item.id);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.state).toBe('open');
      expect(item.labels).toContain(f.label);
    });

    it('posts a comment that reads back as the factory\'s own', async () => {
      const body = `Contract comment ${Date.now()}`;
      const ref = await f.adapter.comment(f.item, body);
      expect(ref.url.length).toBeGreaterThan(0);
      const item = await f.adapter.getItem(f.item);
      const mine = item.comments.find((c) => c.body.includes(body));
      expect(mine).toBeDefined();
      expect(mine!.byFactory).toBe(true);
      // Comments come oldest first.
      const times = item.comments.map((c) => c.at);
      expect([...times].sort()).toEqual(times);
    });

    it('sets a status, twice, and links a pull request', async () => {
      await f.adapter.setStatus(f.item, 'specifying');
      await f.adapter.setStatus(f.item, 'in_progress');
      await f.adapter.link(f.item, { kind: 'pull_request', url: 'https://example.invalid/pr/1', title: 'Contract PR' });
      expect((await f.adapter.getItem(f.item)).state).toBe('open');
    });

    it('reports a labelled item from watch, and stops when aborted', async () => {
      const abort = new AbortController();
      const seen: TrackerEvent[] = [];
      const deadline = setTimeout(() => abort.abort(), f.watchSeconds * 1000);
      for await (const event of f.adapter.watch({ project: f.project, labels: [f.label] }, abort.signal)) {
        seen.push(event);
        if (event.type === 'item_ready' && event.item.id === f.item.id) abort.abort();
      }
      clearTimeout(deadline);
      expect(seen.some((e) => e.type === 'item_ready' && e.item.id === f.item.id)).toBe(true);
    });

    it('lists open items by label', async () => {
      expect((await f.adapter.listOpen({ project: f.project, labels: [f.label] })).map((i) => i.id)).toContain(f.item.id);
      expect((await f.adapter.listOpen({ project: f.project, labels: [`${f.label}-none`] })).map((i) => i.id)).not.toContain(f.item.id);
    });

    it('tells who may decide gates', async () => {
      expect(await f.adapter.canApprove(f.item, f.approver)).toBe(true);
      expect(await f.adapter.canApprove(f.item, f.stranger)).toBe(false);
    });

    it('reports a missing item as not_found', async () => {
      await expectAdapterError(f.adapter.getItem(f.missing), 'not_found');
    });
  });
}

// An in-memory tracker for tests: items, comments, labels and approvers are set up by the
// test; watch polls the in-memory state.

import { AdapterError, type CommentRef, type FactoryStatus, type Identity, type ItemRef, type Tracker, type TrackerEvent, type TrackerItem, type TrackerLink, type WatchQuery } from '@cradleworks/interfaces';

export interface FakeTrackerOptions {
  /** Poll interval of `watch`. Default 5 ms. */
  pollMs?: number;
  clock?: () => string;
}

export class FakeTracker implements Tracker {
  readonly id = 'fake-tracker';
  readonly #items = new Map<string, TrackerItem & { project: string; links: TrackerLink[]; statuses: FactoryStatus[] }>();
  readonly #approvers = new Set<string>();
  readonly #pollMs: number;
  readonly #clock: () => string;
  #n = 0;
  #comments = 0;
  readonly factory: Identity = { name: 'Cradleworks', handle: 'cradleworks[bot]' };

  constructor(options: FakeTrackerOptions = {}) {
    this.#pollMs = options.pollMs ?? 5;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  addItem(input: { project: string; title: string; body: string; author: string; labels?: string[] }): ItemRef {
    const n = ++this.#n;
    const ref = { id: `${input.project}#${n}`, url: `https://tracker.invalid/${input.project}/issues/${n}` };
    this.#items.set(ref.id, {
      ref,
      project: input.project,
      title: input.title,
      body: input.body,
      author: { name: input.author, handle: input.author },
      labels: [...(input.labels ?? [])],
      state: 'open',
      createdAt: this.#clock(),
      comments: [],
      links: [],
      statuses: [],
    });
    return ref;
  }

  /** A person's comment. */
  addComment(item: ItemRef, author: string, body: string): CommentRef {
    const it = this.#get(item, 'addComment');
    const ref = { id: `${item.id}/c${++this.#comments}`, url: `${item.url}#c${this.#comments}` };
    it.comments.push({ ref, author: { name: author, handle: author }, body, at: this.#clock() });
    return ref;
  }

  allowApprover(handle: string): void {
    this.#approvers.add(handle);
  }

  /** Closes it now (the state changes before the promise is awaited, as tests rely on). */
  async close(item: ItemRef): Promise<void> {
    this.#get(item, 'close').state = 'closed';
  }

  statusesOf(item: ItemRef): FactoryStatus[] {
    return [...this.#get(item, 'statusesOf').statuses];
  }

  linksOf(item: ItemRef): TrackerLink[] {
    return [...this.#get(item, 'linksOf').links];
  }

  /** Comments the factory posted, oldest first. */
  factoryComments(item: ItemRef): string[] {
    return this.#get(item, 'factoryComments').comments.filter((c) => c.byFactory).map((c) => c.body);
  }

  async *watch(query: WatchQuery, signal: AbortSignal): AsyncIterable<TrackerEvent> {
    const reported = new Set<string>();
    const seenComments = new Set<string>();
    while (!signal.aborted) {
      for (const it of this.#items.values()) {
        if (it.project !== query.project || it.state !== 'open') continue;
        if (!(query.labels ?? []).every((l) => it.labels.includes(l))) continue;
        if (!reported.has(it.ref.id)) {
          reported.add(it.ref.id);
          for (const c of it.comments) seenComments.add(c.ref.id);
          yield { type: 'item_ready', item: it.ref, at: this.#clock() };
          if (signal.aborted) return;
        }
        for (const c of it.comments) {
          if (seenComments.has(c.ref.id)) continue;
          seenComments.add(c.ref.id);
          yield { type: 'comment_added', item: it.ref, comment: c.ref, at: c.at };
          if (signal.aborted) return;
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  }

  async listOpen(query: WatchQuery): Promise<ItemRef[]> {
    return [...this.#items.values()]
      .filter((it) => it.project === query.project && it.state === 'open' && (query.labels ?? []).every((l) => it.labels.includes(l)))
      .map((it) => it.ref);
  }

  async getItem(item: ItemRef): Promise<TrackerItem> {
    const { project: _p, links: _l, statuses: _s, ...it } = this.#get(item, 'getItem');
    return structuredClone(it);
  }

  async comment(item: ItemRef, body: string): Promise<CommentRef> {
    const it = this.#get(item, 'comment');
    const ref = { id: `${item.id}/c${++this.#comments}`, url: `${item.url}#c${this.#comments}` };
    it.comments.push({ ref, author: this.factory, body, at: this.#clock(), byFactory: true });
    return ref;
  }

  async setStatus(item: ItemRef, status: FactoryStatus): Promise<void> {
    const it = this.#get(item, 'setStatus');
    it.statuses.push(status);
    it.labels = [...it.labels.filter((l) => !l.startsWith('factory:')), `factory:${status}`];
  }

  async link(item: ItemRef, target: TrackerLink): Promise<void> {
    this.#get(item, 'link').links.push(target);
  }

  async canApprove(item: ItemRef, handle: string): Promise<boolean> {
    this.#get(item, 'canApprove');
    return this.#approvers.has(handle);
  }

  #get(item: ItemRef, operation: string) {
    const it = this.#items.get(item.id);
    if (!it) throw new AdapterError('not_found', `no item ${item.id}`, { adapter: this.id, operation });
    return it;
  }
}

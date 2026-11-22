import type { CommentRef, FactoryStatus, Identity, ItemRef, Timestamp } from './common.ts';

export interface TrackerComment {
  ref: CommentRef;
  /** True for comments the factory itself posted. */
  byFactory?: boolean;
  author: Identity;
  body: string;
  at: Timestamp;
}

export interface TrackerItem {
  ref: ItemRef;
  title: string;
  /** Markdown. */
  body: string;
  author: Identity;
  labels: string[];
  state: 'open' | 'closed';
  createdAt: Timestamp;
  comments: TrackerComment[];
}

export interface WatchQuery {
  /** Opaque project or repository id in the tracker. */
  project: string;
  /** Only items carrying all of these labels. */
  labels?: string[];
}

export type TrackerEvent =
  | { type: 'item_ready'; item: ItemRef; at: Timestamp }
  | { type: 'item_updated'; item: ItemRef; at: Timestamp }
  | { type: 'comment_added'; item: ItemRef; comment: CommentRef; at: Timestamp };

export interface TrackerLink {
  kind: 'pull_request' | 'spec' | 'run';
  url: string;
  title?: string;
}

export interface Tracker {
  readonly id: string;

  /** Yields events until `signal` aborts. Webhook or polling is the adapter's choice. */
  watch(query: WatchQuery, signal: AbortSignal): AsyncIterable<TrackerEvent>;
  /** Open items matching the query right now, oldest first. For polling and restarts. */
  listOpen(query: WatchQuery): Promise<ItemRef[]>;
  getItem(item: ItemRef): Promise<TrackerItem>;
  comment(item: ItemRef, body: string): Promise<CommentRef>;
  setStatus(item: ItemRef, status: FactoryStatus): Promise<void>;
  link(item: ItemRef, target: TrackerLink): Promise<void>;
  /** True when `handle` may decide gates on this item (for a code host: write access to the repo). */
  canApprove(item: ItemRef, handle: string): Promise<boolean>;
}

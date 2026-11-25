// Tracker on GitLab issues, over the REST API. `watch` polls, so the factory needs no public
// endpoint: labelled open issues are reported once each, then new comments (notes) on them.
// Status is one `factory:<status>` label; the factory's own notes carry a hidden marker.
// ItemRef ids are "group/name#iid".

import {
  AdapterError,
  type CommentRef,
  type FactoryStatus,
  type ItemRef,
  type Tracker,
  type TrackerComment,
  type TrackerEvent,
  type TrackerItem,
  type TrackerLink,
  type WatchQuery,
} from '@cradleworks/interfaces';
import { GitLabApi, parseProjectPath, projectId, sleep, type GitLabOptions } from './api.ts';

const ADAPTER = 'gitlab-issues';
export const FACTORY_MARKER = '<!-- cradleworks -->';
const STATUS_PREFIX = 'factory:';
/** GitLab's Developer role: may push and merge, so may decide gates. */
const DEVELOPER = 30;

export interface GitLabIssuesOptions extends GitLabOptions {
  /** How often `watch` polls. Default 60 s. */
  pollSeconds?: number;
}

interface RawIssue {
  iid: number;
  web_url: string;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  created_at: string;
  author: { username: string; name?: string } | null;
  labels: string[];
}

interface RawNote {
  id: number;
  body: string;
  created_at: string;
  system: boolean;
  author: { username: string; name?: string } | null;
}

export class GitLabIssuesTracker implements Tracker {
  readonly id = ADAPTER;
  readonly #api: GitLabApi;
  readonly #pollMs: number;

  constructor(options: GitLabIssuesOptions = {}) {
    this.#api = new GitLabApi(ADAPTER, options);
    this.#pollMs = (options.pollSeconds ?? 60) * 1000;
  }

  async *watch(query: WatchQuery, signal: AbortSignal): AsyncIterable<TrackerEvent> {
    const path = parseProjectPath(query.project, ADAPTER, 'watch');
    const reported = new Set<number>();
    const seenNotes = new Map<number, Set<number>>();
    while (!signal.aborted) {
      const pollStarted = new Date().toISOString();
      try {
        for (const issue of await this.#open(path, query.labels, 'watch')) {
          // GitLab has no project-wide "notes since" list, so each open issue's notes are read.
          // They are read before the issue is reported, so a note posted while the factory
          // handles a new issue is still new on the next poll. The first read only learns what's there.
          const notes = (await this.#notes(path, issue.iid, 'watch')).filter((n) => !n.system);
          const seen = seenNotes.get(issue.iid);
          seenNotes.set(issue.iid, new Set(notes.map((n) => n.id)));
          if (!reported.has(issue.iid)) {
            reported.add(issue.iid);
            yield { type: 'item_ready', item: itemRef(path, issue), at: pollStarted };
            if (signal.aborted) return;
          }
          if (!seen) continue;
          for (const n of notes) {
            if (seen.has(n.id)) continue;
            yield { type: 'comment_added', item: itemRef(path, issue), comment: { id: String(n.id), url: `${issue.web_url}#note_${n.id}` }, at: n.created_at };
            if (signal.aborted) return;
          }
        }
      } catch (error) {
        // A failed poll is retried on the next one; only bad credentials or a bad project end the watch.
        if (error instanceof AdapterError && !error.retryable) throw error;
      }
      await sleep(this.#pollMs, signal);
    }
  }

  async listOpen(query: WatchQuery): Promise<ItemRef[]> {
    const path = parseProjectPath(query.project, ADAPTER, 'listOpen');
    return (await this.#open(path, query.labels, 'listOpen')).map((i) => itemRef(path, i));
  }

  async getItem(item: ItemRef): Promise<TrackerItem> {
    const { path, iid } = parseItem(item, 'getItem');
    const issue = await this.#api.request<RawIssue>('getItem', 'GET', `/projects/${projectId(path)}/issues/${iid}`);
    const comments: TrackerComment[] = (await this.#notes(path, iid, 'getItem'))
      .filter((n) => !n.system)
      .map((n) => ({
        ref: { id: String(n.id), url: `${issue.web_url}#note_${n.id}` },
        author: person(n.author),
        body: n.body.replace(FACTORY_MARKER, '').trimEnd(),
        at: n.created_at,
        ...(n.body.includes(FACTORY_MARKER) ? { byFactory: true } : {}),
      }));
    return {
      ref: itemRef(path, issue),
      title: issue.title,
      body: issue.description ?? '',
      author: person(issue.author),
      labels: issue.labels,
      state: issue.state === 'opened' ? 'open' : 'closed',
      createdAt: issue.created_at,
      comments,
    };
  }

  async comment(item: ItemRef, body: string): Promise<CommentRef> {
    const { path, iid } = parseItem(item, 'comment');
    const n = await this.#api.request<RawNote>('comment', 'POST', `/projects/${projectId(path)}/issues/${iid}/notes`, { body: `${body}\n\n${FACTORY_MARKER}` });
    return { id: String(n.id), url: `${item.url}#note_${n.id}` };
  }

  async setStatus(item: ItemRef, status: FactoryStatus): Promise<void> {
    const { path, iid } = parseItem(item, 'setStatus');
    const issue = await this.#api.request<RawIssue>('setStatus', 'GET', `/projects/${projectId(path)}/issues/${iid}`);
    const wanted = `${STATUS_PREFIX}${status}`;
    const stale = issue.labels.filter((l) => l.startsWith(STATUS_PREFIX) && l !== wanted);
    if (stale.length === 0 && issue.labels.includes(wanted)) return;
    await this.#api.request('setStatus', 'PUT', `/projects/${projectId(path)}/issues/${iid}`, { add_labels: wanted, ...(stale.length ? { remove_labels: stale.join(',') } : {}) });
  }

  async close(item: ItemRef): Promise<void> {
    const { path, iid } = parseItem(item, 'close');
    await this.#api.request('close', 'PUT', `/projects/${projectId(path)}/issues/${iid}`, { state_event: 'close' });
  }

  async link(item: ItemRef, target: TrackerLink): Promise<void> {
    const what = { pull_request: 'Merge request', spec: 'Spec', run: 'Run' }[target.kind];
    await this.comment(item, `🔗 ${what}: [${target.title ?? target.url}](${target.url})`);
  }

  async canApprove(item: ItemRef, handle: string): Promise<boolean> {
    const { path } = parseItem(item, 'canApprove');
    if (!/^[A-Za-z0-9_.-]+$/.test(handle)) return false;
    const users = await this.#api.request<Array<{ id: number; username: string }>>('canApprove', 'GET', `/users?username=${encodeURIComponent(handle)}`);
    const user = users.find((u) => u.username.toLowerCase() === handle.toLowerCase());
    if (!user) return false;
    try {
      // members/all includes members inherited from parent groups.
      const member = await this.#api.request<{ access_level: number }>('canApprove', 'GET', `/projects/${projectId(path)}/members/all/${user.id}`);
      return member.access_level >= DEVELOPER;
    } catch (error) {
      if (error instanceof AdapterError && (error.code === 'not_found' || error.code === 'forbidden')) return false;
      throw error;
    }
  }

  async #open(path: string, labels: string[] | undefined, operation: string): Promise<RawIssue[]> {
    const l = (labels ?? []).map(encodeURIComponent).join(',');
    return this.#api.all<RawIssue>(operation, `/projects/${projectId(path)}/issues?state=opened&order_by=created_at&sort=asc${l ? `&labels=${l}` : ''}`);
  }

  async #notes(path: string, iid: number, operation: string): Promise<RawNote[]> {
    return this.#api.all<RawNote>(operation, `/projects/${projectId(path)}/issues/${iid}/notes?order_by=created_at&sort=asc`);
  }
}

const person = (u: { username: string; name?: string } | null) => ({ name: u?.name ?? u?.username ?? 'ghost', handle: u?.username ?? 'ghost' });
const itemRef = (path: string, issue: Pick<RawIssue, 'iid' | 'web_url'>): ItemRef => ({ id: `${path}#${issue.iid}`, url: issue.web_url });

function parseItem(item: ItemRef, operation: string): { path: string; iid: number } {
  const m = /^(.+)#(\d+)$/.exec(item.id);
  if (!m) throw new AdapterError('invalid_input', `issue id must be "group/name#iid", got "${item.id}"`, { adapter: ADAPTER, operation });
  return { path: parseProjectPath(m[1]!, ADAPTER, operation), iid: Number(m[2]) };
}

// Tracker on GitHub Issues, over the REST API. `watch` polls, so the factory needs no
// public endpoint: labelled open issues are reported once each, then new comments on them.
// Status is shown as one `factory:<status>` label; the factory's own comments carry a
// hidden marker so it can tell them from people's.

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
import { defaultTokenProvider, type TokenProvider } from './auth.ts';
import { httpError } from './github-source-control.ts';

const ADAPTER = 'github-issues';
/** Appended to every comment the factory posts. */
export const FACTORY_MARKER = '<!-- cradleworks -->';
const STATUS_PREFIX = 'factory:';

export interface GitHubIssuesOptions {
  token?: TokenProvider;
  apiBase?: string;
  /** How often `watch` polls. Default 60 s. */
  pollSeconds?: number;
  fetch?: typeof fetch;
}

interface RawIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  created_at: string;
  user: { login: string } | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  html_url: string;
  issue_url: string;
  body: string | null;
  created_at: string;
  user: { login: string; type?: string } | null;
}

export class GitHubIssuesTracker implements Tracker {
  readonly id = ADAPTER;
  readonly #tokenProvider: TokenProvider;
  readonly #api: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  #token: Promise<string> | undefined;

  constructor(options: GitHubIssuesOptions = {}) {
    this.#tokenProvider = options.token ?? defaultTokenProvider;
    this.#api = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#pollMs = (options.pollSeconds ?? 60) * 1000;
  }

  async *watch(query: WatchQuery, signal: AbortSignal): AsyncIterable<TrackerEvent> {
    const { owner, name } = parseRepo(query.project, 'watch');
    const reported = new Set<number>();
    let since = new Date().toISOString();
    const labels = (query.labels ?? []).map(encodeURIComponent).join(',');
    while (!signal.aborted) {
      const pollStarted = new Date().toISOString();
      try {
        const issues = await this.#request<RawIssue[]>('watch', 'GET', `/repos/${owner}/${name}/issues?state=open&per_page=100&sort=created&direction=asc${labels ? `&labels=${labels}` : ''}`);
        const open = new Set<number>();
        for (const issue of issues) {
          if (issue.pull_request) continue;
          open.add(issue.number);
          if (reported.has(issue.number)) continue;
          reported.add(issue.number);
          yield { type: 'item_ready', item: itemRef(owner, name, issue.number, issue.html_url), at: pollStarted };
          if (signal.aborted) return;
        }
        const comments = await this.#request<RawComment[]>('watch', 'GET', `/repos/${owner}/${name}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100`);
        for (const c of comments) {
          const n = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
          if (!open.has(n) || c.created_at < since) continue;
          yield { type: 'comment_added', item: itemRef(owner, name, n, c.html_url.replace(/#.*$/, '')), comment: { id: String(c.id), url: c.html_url }, at: c.created_at };
          if (signal.aborted) return;
        }
        since = pollStarted;
      } catch (error) {
        // A failed poll is retried on the next one; only bad credentials or a bad repo end the watch.
        if (error instanceof AdapterError && !error.retryable) throw error;
      }
      await sleep(this.#pollMs, signal);
    }
  }

  async listOpen(query: WatchQuery): Promise<ItemRef[]> {
    const { owner, name } = parseRepo(query.project, 'listOpen');
    const labels = (query.labels ?? []).map(encodeURIComponent).join(',');
    const out: ItemRef[] = [];
    for (let page = 1; page <= 10; page++) {
      const issues = await this.#request<RawIssue[]>('listOpen', 'GET', `/repos/${owner}/${name}/issues?state=open&per_page=100&page=${page}&sort=created&direction=asc${labels ? `&labels=${labels}` : ''}`);
      for (const issue of issues) if (!issue.pull_request) out.push(itemRef(owner, name, issue.number, issue.html_url));
      if (issues.length < 100) break;
    }
    return out;
  }

  async getItem(item: ItemRef): Promise<TrackerItem> {
    const { owner, name, number } = parseItem(item, 'getItem');
    const issue = await this.#request<RawIssue>('getItem', 'GET', `/repos/${owner}/${name}/issues/${number}`);
    if (issue.pull_request) throw fail('not_found', 'getItem', `${item.id} is a pull request, not an issue`);
    const comments: TrackerComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.#request<RawComment[]>('getItem', 'GET', `/repos/${owner}/${name}/issues/${number}/comments?per_page=100&page=${page}`);
      for (const c of batch) {
        const body = c.body ?? '';
        comments.push({
          ref: { id: String(c.id), url: c.html_url },
          author: { name: c.user?.login ?? 'ghost', handle: c.user?.login ?? 'ghost' },
          body: body.replace(FACTORY_MARKER, '').trimEnd(),
          at: c.created_at,
          ...(body.includes(FACTORY_MARKER) ? { byFactory: true } : {}),
        });
      }
      if (batch.length < 100) break;
    }
    return {
      ref: itemRef(owner, name, issue.number, issue.html_url),
      title: issue.title,
      body: issue.body ?? '',
      author: { name: issue.user?.login ?? 'ghost', handle: issue.user?.login ?? 'ghost' },
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      state: issue.state,
      createdAt: issue.created_at,
      comments,
    };
  }

  async comment(item: ItemRef, body: string): Promise<CommentRef> {
    const { owner, name, number } = parseItem(item, 'comment');
    const c = await this.#request<RawComment>('comment', 'POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body: `${body}\n\n${FACTORY_MARKER}` });
    return { id: String(c.id), url: c.html_url };
  }

  async setStatus(item: ItemRef, status: FactoryStatus): Promise<void> {
    const { owner, name, number } = parseItem(item, 'setStatus');
    const current = await this.#request<Array<{ name: string }>>('setStatus', 'GET', `/repos/${owner}/${name}/issues/${number}/labels?per_page=100`);
    const wanted = `${STATUS_PREFIX}${status}`;
    for (const l of current) {
      if (l.name.startsWith(STATUS_PREFIX) && l.name !== wanted) {
        await this.#request('setStatus', 'DELETE', `/repos/${owner}/${name}/issues/${number}/labels/${encodeURIComponent(l.name)}`).catch((e: unknown) => {
          if (!(e instanceof AdapterError && e.code === 'not_found')) throw e;
        });
      }
    }
    if (!current.some((l) => l.name === wanted)) await this.#request('setStatus', 'POST', `/repos/${owner}/${name}/issues/${number}/labels`, { labels: [wanted] });
  }

  async link(item: ItemRef, target: TrackerLink): Promise<void> {
    const what = { pull_request: 'Pull request', spec: 'Spec', run: 'Run' }[target.kind];
    await this.comment(item, `🔗 ${what}: [${target.title ?? target.url}](${target.url})`);
  }

  async canApprove(item: ItemRef, handle: string): Promise<boolean> {
    const { owner, name } = parseItem(item, 'canApprove');
    if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(handle)) return false;
    try {
      const { permission } = await this.#request<{ permission: string }>('canApprove', 'GET', `/repos/${owner}/${name}/collaborators/${encodeURIComponent(handle)}/permission`);
      return permission === 'admin' || permission === 'maintain' || permission === 'write';
    } catch (error) {
      if (error instanceof AdapterError && (error.code === 'not_found' || error.code === 'forbidden')) return false;
      throw error;
    }
  }

  async #request<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.#getToken();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#api}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'cradleworks',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new AdapterError('unavailable', `cannot reach ${this.#api}`, { adapter: ADAPTER, operation, cause });
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (response.ok) return data as T;
    const e = httpError(response, data, operation);
    throw new AdapterError(e.code, e.message, { adapter: ADAPTER, operation, ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
  }

  #getToken(): Promise<string> {
    this.#token ??= this.#tokenProvider().catch((cause: unknown) => {
      this.#token = undefined;
      throw new AdapterError('unauthorized', cause instanceof Error ? cause.message : String(cause), { adapter: ADAPTER, operation: 'auth', cause });
    });
    return this.#token;
  }
}

function itemRef(owner: string, name: string, number: number, url: string): ItemRef {
  return { id: `${owner}/${name}#${number}`, url };
}

function parseRepo(id: string, operation: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(id);
  if (!m) throw fail('invalid_input', operation, `project must be "owner/name", got "${id}"`);
  return { owner: m[1]!, name: m[2]! };
}

function parseItem(item: ItemRef, operation: string): { owner: string; name: string; number: number } {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(item.id);
  if (!m) throw fail('invalid_input', operation, `issue id must be "owner/name#n", got "${item.id}"`);
  return { owner: m[1]!, name: m[2]!, number: Number(m[3]) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

function fail(code: AdapterError['code'], operation: string, message: string): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation });
}

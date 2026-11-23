// The GitLab REST API (v4): one request helper for all three adapters, token auth, and the
// mapping from GitLab's statuses to AdapterError codes.

import { AdapterError, type AdapterErrorCode } from '@cradleworks/interfaces';

export type TokenProvider = () => Promise<string>;

export interface GitLabOptions {
  /** A personal, group or project access token. Default: $CRADLEWORKS_GITLAB_TOKEN, then $GITLAB_TOKEN. */
  token?: TokenProvider;
  /** The GitLab instance. Default: $CRADLEWORKS_GITLAB_URL, then https://gitlab.com */
  baseUrl?: string;
  /** Where git clones from, when not the instance itself (tests use a file:// folder). */
  gitBase?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export function tokenFromEnv(env: Record<string, string | undefined> = process.env): TokenProvider {
  return async () => {
    const token = env.CRADLEWORKS_GITLAB_TOKEN ?? env.GITLAB_TOKEN;
    if (!token) throw new Error('no GitLab token: set CRADLEWORKS_GITLAB_TOKEN (scope: api, write_repository)');
    return token;
  };
}

export function baseUrlFrom(options: GitLabOptions, env: Record<string, string | undefined> = process.env): string {
  return (options.baseUrl ?? env.CRADLEWORKS_GITLAB_URL ?? 'https://gitlab.com').replace(/\/$/, '');
}

/** A project path, `group/name` or `group/subgroup/name`, as GitLab's API wants it in a URL. */
export const projectId = (path: string) => encodeURIComponent(path);

const PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
export function parseProjectPath(path: string, adapter: string, operation: string): string {
  if (!PATH.test(path)) throw new AdapterError('invalid_input', `GitLab project must be "group/name", got "${path}"`, { adapter, operation });
  return path;
}

export class GitLabApi {
  readonly base: string;
  readonly #token: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #adapter: string;

  constructor(adapter: string, options: GitLabOptions) {
    this.#adapter = adapter;
    this.base = baseUrlFrom(options);
    this.#token = options.token ?? tokenFromEnv();
    this.#fetch = options.fetch ?? fetch;
  }

  token(operation: string): Promise<string> {
    return this.#token().catch((cause: unknown) => {
      throw new AdapterError('unauthorized', cause instanceof Error ? cause.message : String(cause), { adapter: this.#adapter, operation, cause });
    });
  }

  async request<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(operation, method, path, body);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (response.ok) return data as T;
    throw gitlabError(response, data, this.#adapter, operation);
  }

  /** The response itself, for text and binary bodies (job logs, artifacts). Throws on failure. */
  async raw(operation: string, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.token(operation);
    let response: Response;
    try {
      response = await this.#fetch(`${this.base}/api/v4${path}`, {
        method,
        headers: { 'PRIVATE-TOKEN': token, 'User-Agent': 'cradleworks', Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new AdapterError('unavailable', `cannot reach ${this.base}`, { adapter: this.#adapter, operation, cause });
    }
    return response;
  }

  /** Every page of a list endpoint (GitLab pages at 100). */
  async all<T>(operation: string, path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>(operation, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }
}

export function gitlabError(response: Response, data: unknown, adapter: string, operation: string): AdapterError {
  const detail = describe(data) || response.statusText || `HTTP ${response.status}`;
  const retryAfter = Number(response.headers.get('retry-after') ?? NaN);
  let code: AdapterErrorCode;
  if (response.status === 429) code = 'rate_limited';
  else if (response.status === 401) code = 'unauthorized';
  else if (response.status === 403) code = 'forbidden';
  else if (response.status === 404) code = 'not_found';
  // 405 not mergeable, 406 merge conflict, 409 already exists or the head moved.
  else if (response.status === 405 || response.status === 406 || response.status === 409) code = 'conflict';
  else if (response.status === 400 || response.status === 422) code = /already exists/i.test(detail) ? 'conflict' : 'invalid_input';
  else if (response.status >= 500) code = 'unavailable';
  else code = 'unknown';
  return new AdapterError(code, `GitLab ${response.status}: ${detail}`, { adapter, operation, ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}) });
}

function describe(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 300);
  if (typeof data !== 'object' || data === null) return '';
  const d = data as { message?: unknown; error?: unknown };
  const m = d.message ?? d.error;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join('; ');
  if (m && typeof m === 'object') return Object.entries(m).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ');
  return '';
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

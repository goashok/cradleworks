// SourceControl for GitHub: git over HTTPS for working copies, the REST API for pull
// requests. RepoRef ids are "owner/name"; PullRequestRef ids are "owner/name#number".

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AdapterError,
  type AdapterErrorCode,
  type ChecksState,
  type CommentRef,
  type CommitRef,
  type Identity,
  type MergeMethod,
  type OpenPullRequestInput,
  type PullRequestRef,
  type PullRequestStatus,
  type RepoRef,
  type Review,
  type SourceControl,
  type WorkingCopy,
} from '@cradleworks/interfaces';
import { tokenProviderFromEnv, type TokenProvider } from './auth.ts';
import { git, GitCommandError, gitExitCode, type GitIdentity } from './git.ts';

const ADAPTER = 'github';

export interface GitHubOptions {
  token?: TokenProvider;
  /** REST API root. Default https://api.github.com */
  apiBase?: string;
  /** Web and git host. Default https://github.com */
  webBase?: string;
  /** Identity on factory commits. */
  committer?: GitIdentity;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export function githubRepoRef(owner: string, name: string, webBase = 'https://github.com'): RepoRef {
  return { id: `${owner}/${name}`, url: `${webBase.replace(/\/$/, '')}/${owner}/${name}` };
}

export class GitHubSourceControl implements SourceControl {
  readonly id = ADAPTER;
  readonly #tokenProvider: TokenProvider;
  readonly #api: string;
  readonly #web: string;
  readonly #identity: GitIdentity;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubOptions = {}) {
    this.#tokenProvider = options.token ?? tokenProviderFromEnv();
    this.#api = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.#web = (options.webBase ?? 'https://github.com').replace(/\/$/, '');
    this.#identity = options.committer ?? { name: 'Cradleworks', email: 'factory@cradleworks.invalid' };
    this.#fetch = options.fetch ?? fetch;
  }

  // --- working copies (git) ------------------------------------------------

  async clone(repo: RepoRef, into: string, options: { ref?: string; depth?: number } = {}): Promise<WorkingCopy> {
    const { owner, name } = parseRepo(repo, 'clone');
    if (existsSync(into) && readdirSync(into).length > 0) throw fail('invalid_input', 'clone', `${into} is not empty`);
    const args = ['clone', '--quiet'];
    if (options.depth !== undefined) args.push('--depth', String(options.depth), '--no-single-branch');
    if (options.ref !== undefined) args.push('--branch', options.ref);
    await this.#git([...args, `${this.#web}/${owner}/${name}.git`, into], 'clone', undefined, true);
    return { repo, path: resolve(into) };
  }

  async createBranch(copy: WorkingCopy, name: string, from?: string): Promise<void> {
    if ((await gitExitCode(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: copy.path, identity: this.#identity })) === 0) {
      throw fail('conflict', 'createBranch', `branch ${name} already exists`);
    }
    await this.#git(['checkout', '--quiet', '-b', name, ...(from ? [from] : [])], 'createBranch', copy.path);
  }

  async commit(copy: WorkingCopy, message: string, options: { author?: Identity; paths?: string[] } = {}): Promise<CommitRef> {
    await this.#git(['add', '-A', '--', ...(options.paths ?? ['.'])], 'commit', copy.path);
    if ((await gitExitCode(['diff', '--cached', '--quiet'], { cwd: copy.path, identity: this.#identity })) === 0) {
      throw fail('invalid_input', 'commit', 'nothing to commit');
    }
    const author = options.author ? ['--author', `${options.author.name} <${options.author.email ?? this.#identity.email}>`] : [];
    await this.#git(['commit', '--quiet', '-m', message, ...author], 'commit', copy.path);
    const sha = (await this.#git(['rev-parse', 'HEAD'], 'commit', copy.path)).trim();
    const { owner, name } = parseRepo(copy.repo, 'commit');
    return { sha, url: `${this.#web}/${owner}/${name}/commit/${sha}` };
  }

  async push(copy: WorkingCopy, branch: string, options: { replace?: boolean } = {}): Promise<void> {
    const plus = options.replace ? '+' : '';
    await this.#git(['push', '--quiet', 'origin', `${plus}refs/heads/${branch}:refs/heads/${branch}`], 'push', copy.path, true);
  }

  // --- pull requests (REST) -------------------------------------------------

  async openPR(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const { owner, name } = parseRepo(input.repo, 'openPR');
    const pr = await this.#request<{ number: number; html_url: string }>('openPR', 'POST', `/repos/${owner}/${name}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft ?? false,
    });
    if (input.labels && input.labels.length > 0) {
      await this.#request('openPR', 'POST', `/repos/${owner}/${name}/issues/${pr.number}/labels`, { labels: input.labels });
    }
    return { id: `${owner}/${name}#${pr.number}`, url: pr.html_url };
  }

  async getPRStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    const { owner, name, number } = parsePR(ref, 'getPRStatus');
    const base = `/repos/${owner}/${name}`;
    const pr = await this.#request<RawPull>('getPRStatus', 'GET', `${base}/pulls/${number}`);
    const [reviews, checks] = await Promise.all([
      this.#request<RawReview[]>('getPRStatus', 'GET', `${base}/pulls/${number}/reviews?per_page=100`),
      this.#checks(base, pr.head.sha),
    ]);
    return {
      ref: { id: ref.id, url: pr.html_url },
      state: pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
      mergeable: pr.state !== 'open' ? false : pr.mergeable ?? 'unknown',
      checks,
      reviews: reviews.flatMap(toReview),
    };
  }

  async merge(ref: PullRequestRef, options: { method: MergeMethod; expectedHeadSha: string }): Promise<CommitRef> {
    const { owner, name, number } = parsePR(ref, 'merge');
    // GitHub accepts a merge call on an already-merged pull request; the contract does not.
    const current = await this.#request<RawPull>('merge', 'GET', `/repos/${owner}/${name}/pulls/${number}`);
    if (current.state !== 'open') {
      throw fail('conflict', 'merge', `pull request is ${current.merged_at ? 'merged' : 'closed'}`);
    }
    let result: { sha: string };
    try {
      result = await this.#request<{ sha: string }>('merge', 'PUT', `/repos/${owner}/${name}/pulls/${number}/merge`, {
        merge_method: options.method,
        sha: options.expectedHeadSha,
      });
    } catch (error) {
      // GitHub answers 405 both for a conflict with the base and for other refusals (a base that
      // moved, branch protection); only the first needs the change rebuilt.
      if (error instanceof AdapterError && error.code === 'conflict') {
        const now = await this.#request<RawPull>('merge', 'GET', `/repos/${owner}/${name}/pulls/${number}`).catch(() => undefined);
        if (/merge conflict/i.test(error.message) || now?.mergeable_state === 'dirty') {
          throw fail('merge_conflict', 'merge', `the change conflicts with ${current.base?.ref ?? 'its base branch'}`, error);
        }
      }
      throw error;
    }
    return { sha: result.sha, url: `${this.#web}/${owner}/${name}/commit/${result.sha}` };
  }

  async comment(ref: PullRequestRef, body: string): Promise<CommentRef> {
    const { owner, name, number } = parsePR(ref, 'comment');
    const c = await this.#request<{ id: number; html_url: string }>('comment', 'POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body });
    return { id: String(c.id), url: c.html_url };
  }

  // --- internals --------------------------------------------------------------

  async #checks(base: string, sha: string): Promise<ChecksState> {
    // A fine-grained token can't be given Checks at all, and may lack Commit statuses: a read it
    // may not make adds nothing, rather than failing every look at the pull request.
    const refused = { refused: true } as const;
    const allowed = <T>(read: Promise<T>) => read.catch((e: unknown) => (e instanceof AdapterError && e.code === 'forbidden' ? refused : Promise.reject(e)));
    const [runsRead, combinedRead] = await Promise.all([
      allowed(this.#request<{ check_runs: Array<{ status: string; conclusion: string | null }> }>('getPRStatus', 'GET', `${base}/commits/${sha}/check-runs?per_page=100`)),
      allowed(this.#request<{ statuses: Array<{ state: string }> }>('getPRStatus', 'GET', `${base}/commits/${sha}/status`)),
    ]);
    const runs = 'refused' in runsRead ? { check_runs: [] } : runsRead;
    const combined = 'refused' in combinedRead ? { statuses: [] } : combinedRead;
    const states = [
      ...runs.check_runs.map((r) =>
        r.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '') ? 'passing' : 'failing',
      ),
      ...combined.statuses.map((s) => (s.state === 'success' ? 'passing' : s.state === 'pending' ? 'pending' : 'failing')),
    ];
    if (states.includes('failing')) return 'failing';
    if (states.includes('pending')) return 'pending';
    if ('refused' in runsRead || 'refused' in combinedRead) return 'unknown';
    return states.length === 0 ? 'none' : 'passing';
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
    const data: unknown = text ? safeJson(text) : undefined;
    if (response.ok) return data as T;
    throw httpError(response, data, operation);
  }

  #getToken(): Promise<string> {
    // Providers cache, and refresh tokens that expire.
    return this.#tokenProvider().catch((cause: unknown) => {
      throw new AdapterError('unauthorized', cause instanceof Error ? cause.message : String(cause), { adapter: ADAPTER, operation: 'auth', cause });
    });
  }

  async #git(args: string[], operation: string, cwd: string | undefined, authenticated = false): Promise<string> {
    const auth = authenticated ? { host: `${this.#web}/`, token: await this.#getToken() } : undefined;
    try {
      return await git(args, { cwd, identity: this.#identity, ...(auth ? { auth } : {}) });
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      const code: AdapterErrorCode = /not found|does not exist/i.test(error.stderr)
        ? 'not_found'
        : /authentication|403|denied/i.test(error.stderr)
          ? 'unauthorized'
          : /rejected|non-fast-forward/i.test(error.stderr)
            ? 'conflict'
            : 'unknown';
      throw fail(code, operation, error.message, error);
    }
  }
}

// --- mapping helpers ----------------------------------------------------------

interface RawPull {
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  mergeable: boolean | null;
  /** `dirty` when the change conflicts with the base branch. */
  mergeable_state?: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

interface RawReview {
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

function toReview(raw: RawReview): Review[] {
  const verdict = ({ APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented' } as const)[
    raw.state as 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  ];
  if (!verdict || !raw.submitted_at) return [];
  const login = raw.user?.login ?? 'ghost';
  return [{ author: { name: login, handle: login }, verdict, body: raw.body ?? '', at: raw.submitted_at }];
}

export function httpError(response: Response, data: unknown, operation: string): AdapterError {
  const detail = describeError(data) || response.statusText || `HTTP ${response.status}`;
  const retryAfter = Number(response.headers.get('retry-after') ?? NaN);
  const rateLimited =
    response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)));
  let code: AdapterErrorCode;
  if (rateLimited) code = 'rate_limited';
  else if (response.status === 401) code = 'unauthorized';
  else if (response.status === 403) code = 'forbidden';
  else if (response.status === 404) code = 'not_found';
  else if (response.status === 409 || response.status === 405) code = 'conflict';
  else if (response.status === 422) code = /already exists/i.test(detail) ? 'conflict' : 'invalid_input';
  else if (response.status >= 500) code = 'unavailable';
  else code = 'unknown';
  return new AdapterError(code, `GitHub ${response.status}: ${detail}`, {
    adapter: ADAPTER,
    operation,
    ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
  });
}

function describeError(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const d = data as { message?: string; errors?: Array<{ message?: string; code?: string; field?: string }> };
  const extra = (d.errors ?? []).map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(' ')).filter(Boolean);
  return [d.message, ...extra].filter(Boolean).join('; ');
}

function parseRepo(repo: RepoRef, operation: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo.id);
  if (!match) throw fail('invalid_input', operation, `repository id must be "owner/name", got "${repo.id}"`);
  return { owner: match[1]!, name: match[2]! };
}

function parsePR(ref: PullRequestRef, operation: string): { owner: string; name: string; number: number } {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(ref.id);
  if (!match) throw fail('invalid_input', operation, `pull request id must be "owner/name#number", got "${ref.id}"`);
  return { owner: match[1]!, name: match[2]!, number: Number(match[3]) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function fail(code: AdapterErrorCode, operation: string, message: string, cause?: unknown): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation, cause });
}

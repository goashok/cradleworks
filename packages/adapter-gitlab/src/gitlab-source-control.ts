// SourceControl for GitLab: git over HTTPS for working copies, the REST API for merge requests.
// RepoRef ids are project paths ("group/name", subgroups allowed); PullRequestRef ids are
// "group/name!iid", GitLab's own way of writing a merge request.

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
import { GitLabApi, parseProjectPath, projectId, type GitLabOptions } from './api.ts';
import { git, GitCommandError, gitExitCode, type GitIdentity } from './git.ts';

const ADAPTER = 'gitlab';

export interface GitLabSourceControlOptions extends GitLabOptions {
  committer?: GitIdentity;
}

export function gitlabRepoRef(path: string, webBase = 'https://gitlab.com'): RepoRef {
  return { id: path, url: `${webBase.replace(/\/$/, '')}/${path}` };
}

interface RawMR {
  iid: number;
  web_url: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  sha: string;
  target_branch: string;
  source_branch: string;
  detailed_merge_status?: string;
  merge_status?: string;
  has_conflicts?: boolean;
  updated_at: string;
  head_pipeline?: { status: string } | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
}

export class GitLabSourceControl implements SourceControl {
  readonly id = ADAPTER;
  readonly #api: GitLabApi;
  readonly #gitBase: string;
  readonly #identity: GitIdentity;

  constructor(options: GitLabSourceControlOptions = {}) {
    this.#api = new GitLabApi(ADAPTER, options);
    this.#gitBase = (options.gitBase ?? this.#api.base).replace(/\/$/, '');
    this.#identity = options.committer ?? { name: 'Cradleworks', email: 'factory@cradleworks.invalid' };
  }

  // --- working copies (git) ------------------------------------------------

  async clone(repo: RepoRef, into: string, options: { ref?: string; depth?: number } = {}): Promise<WorkingCopy> {
    const path = parseProjectPath(repo.id, ADAPTER, 'clone');
    if (existsSync(into) && readdirSync(into).length > 0) throw fail('invalid_input', 'clone', `${into} is not empty`);
    const args = ['clone', '--quiet'];
    if (options.depth !== undefined) args.push('--depth', String(options.depth), '--no-single-branch');
    if (options.ref !== undefined) args.push('--branch', options.ref);
    await this.#git([...args, `${this.#gitBase}/${path}.git`, into], 'clone', undefined, true);
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
    return { sha, url: `${this.#api.base}/${copy.repo.id}/-/commit/${sha}` };
  }

  async push(copy: WorkingCopy, branch: string, options: { replace?: boolean } = {}): Promise<void> {
    const plus = options.replace ? '+' : '';
    await this.#git(['push', '--quiet', 'origin', `${plus}refs/heads/${branch}:refs/heads/${branch}`], 'push', copy.path, true);
  }

  // --- merge requests (REST) ------------------------------------------------

  async openPR(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const path = parseProjectPath(input.repo.id, ADAPTER, 'openPR');
    const p = projectId(path);
    // GitLab answers a missing source branch with a generic error; check first, so it reads as one.
    await this.#api.request('openPR', 'GET', `/projects/${p}/repository/branches/${encodeURIComponent(input.head)}`).catch((e: unknown) => {
      if (e instanceof AdapterError && e.code === 'not_found') throw fail('invalid_input', 'openPR', `branch ${input.head} does not exist`);
      throw e;
    });
    const mr = await this.#api.request<RawMR>('openPR', 'POST', `/projects/${p}/merge_requests`, {
      source_branch: input.head,
      target_branch: input.base,
      title: input.draft ? `Draft: ${input.title}` : input.title,
      description: input.body,
      ...(input.labels?.length ? { labels: input.labels.join(',') } : {}),
    });
    return { id: `${path}!${mr.iid}`, url: mr.web_url };
  }

  async getPRStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    const { path, iid } = parseMR(ref, 'getPRStatus');
    const base = `/projects/${projectId(path)}/merge_requests/${iid}`;
    const mr = await this.#api.request<RawMR>('getPRStatus', 'GET', base);
    const reviews = await this.#reviews(base, mr.updated_at);
    return {
      ref: { id: ref.id, url: mr.web_url },
      state: mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'open' : 'closed',
      headSha: mr.sha,
      baseBranch: mr.target_branch,
      mergeable: mr.state !== 'opened' ? false : mergeable(mr),
      checks: checksOf(mr.head_pipeline?.status),
      reviews,
    };
  }

  async merge(ref: PullRequestRef, options: { method: MergeMethod; expectedHeadSha: string }): Promise<CommitRef> {
    const { path, iid } = parseMR(ref, 'merge');
    const base = `/projects/${projectId(path)}/merge_requests/${iid}`;
    const current = await this.#api.request<RawMR>('merge', 'GET', base);
    if (current.state !== 'opened') throw fail('conflict', 'merge', `merge request is ${current.state}`);
    if (current.sha !== options.expectedHeadSha) throw fail('conflict', 'merge', `the head moved to ${current.sha.slice(0, 12)}`);
    if (current.has_conflicts || current.detailed_merge_status === 'conflict') throw fail('merge_conflict', 'merge', `the change conflicts with ${current.target_branch}`);
    // GitLab merges with the project's merge method; squash is per request. Rebase is the project's setting.
    const merged = await this.#api.request<RawMR>('merge', 'PUT', `${base}/merge`, {
      sha: options.expectedHeadSha,
      squash: options.method === 'squash',
      should_remove_source_branch: false,
    });
    const sha = merged.merge_commit_sha ?? merged.squash_commit_sha ?? merged.sha;
    return { sha, url: `${this.#api.base}/${path}/-/commit/${sha}` };
  }

  async comment(ref: PullRequestRef, body: string): Promise<CommentRef> {
    const { path, iid } = parseMR(ref, 'comment');
    const note = await this.#api.request<{ id: number }>('comment', 'POST', `/projects/${projectId(path)}/merge_requests/${iid}/notes`, { body });
    return { id: String(note.id), url: `${ref.url}#note_${note.id}` };
  }

  // --- internals --------------------------------------------------------------

  /** Approvals, plus reviewers who asked for changes (GitLab 17+; older instances have only approvals). */
  async #reviews(base: string, at: string): Promise<Review[]> {
    const out: Review[] = [];
    const approvals = await this.#api.request<{ approved_by?: Array<{ user: { username: string; name?: string } }> }>('getPRStatus', 'GET', `${base}/approvals`).catch(() => ({ approved_by: [] }));
    for (const a of approvals.approved_by ?? []) out.push({ author: { name: a.user.name ?? a.user.username, handle: a.user.username }, verdict: 'approved', body: '', at });
    const reviewers = await this.#api
      .request<Array<{ user: { username: string; name?: string }; state: string; created_at?: string }>>('getPRStatus', 'GET', `${base}/reviewers`)
      .catch(() => []);
    for (const r of reviewers) {
      if (r.state === 'requested_changes') out.push({ author: { name: r.user.name ?? r.user.username, handle: r.user.username }, verdict: 'changes_requested', body: '', at: r.created_at ?? at });
    }
    return out;
  }

  async #git(args: string[], operation: string, cwd: string | undefined, authenticated = false): Promise<string> {
    const auth = authenticated && /^https?:/.test(this.#gitBase) ? { host: `${this.#gitBase}/`, token: await this.#api.token(operation) } : undefined;
    try {
      return await git(args, { cwd, identity: this.#identity, ...(auth ? { auth } : {}) });
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      const code: AdapterErrorCode = /not found|does not exist|does not appear to be a git repository/i.test(error.stderr)
        ? 'not_found'
        : /authentication|403|denied|HTTP Basic/i.test(error.stderr)
          ? 'unauthorized'
          : /rejected|non-fast-forward|fetch first/i.test(error.stderr)
            ? 'conflict'
            : 'unknown';
      throw fail(code, operation, error.message, error);
    }
  }
}

export function mergeable(mr: Pick<RawMR, 'detailed_merge_status' | 'merge_status'>): boolean | 'unknown' {
  const s = mr.detailed_merge_status ?? mr.merge_status ?? '';
  if (s === 'mergeable' || s === 'can_be_merged') return true;
  if (['checking', 'unchecked', 'preparing', 'approvals_syncing', 'cannot_be_merged_recheck', ''].includes(s)) return 'unknown';
  return false;
}

export function checksOf(pipeline: string | undefined): ChecksState {
  if (!pipeline) return 'none';
  if (pipeline === 'success' || pipeline === 'skipped') return 'passing';
  if (pipeline === 'failed' || pipeline === 'canceled') return 'failing';
  return 'pending';
}

function parseMR(ref: PullRequestRef, operation: string): { path: string; iid: number } {
  const m = /^(.+)!(\d+)$/.exec(ref.id);
  if (!m) throw fail('invalid_input', operation, `merge request id must be "group/name!iid", got "${ref.id}"`);
  return { path: parseProjectPath(m[1]!, ADAPTER, operation), iid: Number(m[2]) };
}

function fail(code: AdapterErrorCode, operation: string, message: string, cause?: unknown): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation, cause });
}

/**
 * The project behind a git remote on `webBase`'s host (https or ssh), or undefined.
 * Subgroups are kept: "https://gitlab.com/acme/platform/shop.git" → "acme/platform/shop".
 */
export function gitlabRepoFromRemote(remoteUrl: string, webBase = 'https://gitlab.com'): RepoRef | undefined {
  const host = new URL(webBase).host.replace(/[.]/g, '\\.');
  const re = new RegExp(`^(?:https://${host}/|git@${host}:|ssh://git@${host}(?::\\d+)?/)((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+?)(?:\\.git)?/?$`);
  const m = re.exec(remoteUrl.trim());
  return m ? gitlabRepoRef(m[1]!, webBase) : undefined;
}

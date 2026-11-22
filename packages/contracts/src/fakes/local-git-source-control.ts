// SourceControl over plain git: bare repositories on disk act as the remote, and pull
// requests are kept in a JSON file inside each bare repository. For tests and local
// end-to-end runs; no network, no accounts.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AdapterError,
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
import { git, GitError, gitStatus } from './git.ts';

const ADAPTER = 'local-git';
const PR_FILE = 'cradleworks-pull-requests.json';

interface StoredPullRequest {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
  state: 'open' | 'merged' | 'closed';
  mergedSha?: string;
  comments: Array<{ id: string; body: string }>;
  reviews: Review[];
}

/** A repo reference for a bare repository at `barePath`. */
export function localRepoRef(barePath: string): RepoRef {
  const path = resolve(barePath);
  return { id: path, url: pathToFileURL(path).href };
}

export class LocalGitSourceControl implements SourceControl {
  readonly id = ADAPTER;

  async clone(repo: RepoRef, into: string, options: { ref?: string; depth?: number } = {}): Promise<WorkingCopy> {
    if (existsSync(into) && readdirSync(into).length > 0) throw fail('invalid_input', 'clone', `${into} is not empty`);
    const args = ['clone', '--quiet'];
    if (options.depth !== undefined) args.push('--depth', String(options.depth), '--no-single-branch');
    if (options.ref !== undefined) args.push('--branch', options.ref);
    await this.#git([...args, pathToFileURL(this.#bare(repo)).href, into], 'clone');
    return { repo, path: resolve(into) };
  }

  async createBranch(copy: WorkingCopy, name: string, from?: string): Promise<void> {
    if ((await gitStatus(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], copy.path)) === 0) {
      throw fail('conflict', 'createBranch', `branch ${name} already exists`);
    }
    await this.#git(['checkout', '--quiet', '-b', name, ...(from ? [from] : [])], 'createBranch', copy.path);
  }

  async commit(copy: WorkingCopy, message: string, options: { author?: Identity; paths?: string[] } = {}): Promise<CommitRef> {
    await this.#git(['add', '-A', '--', ...(options.paths ?? ['.'])], 'commit', copy.path);
    if ((await gitStatus(['diff', '--cached', '--quiet'], copy.path)) === 0) {
      throw fail('invalid_input', 'commit', 'nothing to commit');
    }
    const author = options.author ? ['--author', `${options.author.name} <${options.author.email ?? 'factory@cradleworks.invalid'}>`] : [];
    await this.#git(['commit', '--quiet', '-m', message, ...author], 'commit', copy.path);
    const sha = (await this.#git(['rev-parse', 'HEAD'], 'commit', copy.path)).trim();
    return { sha };
  }

  async push(copy: WorkingCopy, branch: string, options: { replace?: boolean } = {}): Promise<void> {
    const plus = options.replace ? '+' : '';
    await this.#git(['push', '--quiet', 'origin', `${plus}refs/heads/${branch}:refs/heads/${branch}`], 'push', copy.path);
  }

  async openPR(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const bare = this.#bare(input.repo);
    for (const branch of [input.head, input.base]) {
      if ((await this.#remoteSha(bare, branch)) === undefined) throw fail('invalid_input', 'openPR', `branch ${branch} does not exist`);
    }
    const prs = readPRs(bare);
    if (prs.some((pr) => pr.state === 'open' && pr.head === input.head && pr.base === input.base)) {
      throw fail('conflict', 'openPR', `an open pull request already exists for ${input.head} into ${input.base}`);
    }
    const number = prs.reduce((max, pr) => Math.max(max, pr.number), 0) + 1;
    prs.push({
      number,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft ?? false,
      labels: input.labels ?? [],
      state: 'open',
      comments: [],
      reviews: [],
    });
    writePRs(bare, prs);
    return prRef(bare, number);
  }

  async getPRStatus(pr: PullRequestRef): Promise<PullRequestStatus> {
    const { bare, stored } = this.#find(pr, 'getPRStatus');
    const headSha = stored.state === 'merged' ? (stored.mergedSha ?? '') : ((await this.#remoteSha(bare, stored.head)) ?? '');
    let mergeable: boolean | 'unknown' = false;
    if (stored.state === 'open') {
      const code = await gitStatus(['--git-dir', bare, 'merge-tree', '--write-tree', `refs/heads/${stored.base}`, `refs/heads/${stored.head}`]);
      mergeable = code === 0 ? true : code === 1 ? false : 'unknown';
    }
    return {
      ref: prRef(bare, stored.number),
      state: stored.state,
      headSha,
      baseBranch: stored.base,
      mergeable,
      checks: 'none',
      reviews: structuredClone(stored.reviews),
    };
  }

  async merge(pr: PullRequestRef, options: { method: MergeMethod; expectedHeadSha: string }): Promise<CommitRef> {
    const { bare, stored } = this.#find(pr, 'merge');
    if (stored.state !== 'open') throw fail('conflict', 'merge', `pull request is ${stored.state}`);
    const head = await this.#remoteSha(bare, stored.head);
    if (head !== options.expectedHeadSha) {
      throw fail('conflict', 'merge', `head is ${head ?? 'gone'}, expected ${options.expectedHeadSha}`);
    }

    const work = mkdtempSync(join(tmpdir(), 'cw-merge-'));
    try {
      await this.#git(['clone', '--quiet', pathToFileURL(bare).href, work], 'merge');
      await this.#git(['checkout', '--quiet', stored.base], 'merge', work);
      const message = `${stored.title} (#${stored.number})`;
      try {
        if (options.method === 'merge') {
          await git(['merge', '--no-ff', '-m', message, `origin/${stored.head}`], work);
        } else if (options.method === 'squash') {
          await git(['merge', '--squash', `origin/${stored.head}`], work);
          await git(['commit', '--quiet', '-m', message], work);
        } else {
          await git(['checkout', '--quiet', '-B', 'cw-rebase', `origin/${stored.head}`], work);
          await git(['rebase', '--quiet', stored.base], work);
          await git(['checkout', '--quiet', stored.base], work);
          await git(['merge', '--ff-only', 'cw-rebase'], work);
        }
      } catch (error) {
        throw fail('conflict', 'merge', `cannot ${options.method} cleanly`, error);
      }
      await this.#git(['push', '--quiet', 'origin', `HEAD:refs/heads/${stored.base}`], 'merge', work);
      const sha = (await this.#git(['rev-parse', 'HEAD'], 'merge', work)).trim();

      const prs = readPRs(bare);
      const target = prs.find((p) => p.number === stored.number)!;
      target.state = 'merged';
      target.mergedSha = sha;
      writePRs(bare, prs);
      return { sha };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async comment(pr: PullRequestRef, body: string): Promise<CommentRef> {
    const { bare, stored } = this.#find(pr, 'comment');
    const prs = readPRs(bare);
    const target = prs.find((p) => p.number === stored.number)!;
    const id = `${stored.number}-${target.comments.length + 1}`;
    target.comments.push({ id, body });
    writePRs(bare, prs);
    return { id: `${bare}#comment-${id}`, url: `${pathToFileURL(bare).href}#comment-${id}` };
  }

  /** Test helper: records a review, as a person would in a hosted system. */
  addReview(pr: PullRequestRef, review: Review): void {
    const { bare, stored } = this.#find(pr, 'addReview');
    const prs = readPRs(bare);
    prs.find((p) => p.number === stored.number)!.reviews.push(review);
    writePRs(bare, prs);
  }

  /** Test helper: comments posted on a pull request. */
  commentsOn(pr: PullRequestRef): string[] {
    return this.#find(pr, 'commentsOn').stored.comments.map((c) => c.body);
  }

  #bare(repo: RepoRef): string {
    const path = resolve(repo.id);
    if (!existsSync(join(path, 'HEAD'))) throw fail('not_found', 'repo', `no bare repository at ${path}`);
    return path;
  }

  #find(pr: PullRequestRef, operation: string): { bare: string; stored: StoredPullRequest } {
    const [barePath, number] = splitPrId(pr.id);
    if (barePath === undefined || number === undefined) throw fail('not_found', operation, `bad pull request id ${pr.id}`);
    const bare = this.#bare({ id: barePath, url: '' });
    const stored = readPRs(bare).find((p) => p.number === number);
    if (!stored) throw fail('not_found', operation, `no pull request #${number}`);
    return { bare, stored };
  }

  async #remoteSha(bare: string, branch: string): Promise<string | undefined> {
    try {
      return (await git(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async #git(args: string[], operation: string, cwd?: string): Promise<string> {
    try {
      return (await git(args, cwd)).stdout;
    } catch (error) {
      if (error instanceof GitError) throw fail('unknown', operation, error.message, error);
      throw error;
    }
  }
}

function prRef(bare: string, number: number): PullRequestRef {
  return { id: `${bare}#${number}`, url: `${pathToFileURL(bare).href}#pull-${number}` };
}

function splitPrId(id: string): [string | undefined, number | undefined] {
  const hash = id.lastIndexOf('#');
  if (hash < 0) return [undefined, undefined];
  const number = Number(id.slice(hash + 1));
  return [id.slice(0, hash), Number.isInteger(number) && number > 0 ? number : undefined];
}

function readPRs(bare: string): StoredPullRequest[] {
  const file = join(bare, PR_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoredPullRequest[]) : [];
}

function writePRs(bare: string, prs: StoredPullRequest[]): void {
  writeFileSync(join(bare, PR_FILE), JSON.stringify(prs, null, 2));
}

function fail(code: AdapterError['code'], operation: string, message: string, cause?: unknown): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation, cause });
}

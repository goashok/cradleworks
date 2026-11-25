import type { CommentRef, Identity, PullRequestRef, RepoRef, Timestamp } from './common.ts';

/** A local checkout the factory can read and write. */
export interface WorkingCopy {
  repo: RepoRef;
  /** Absolute path on the host. */
  path: string;
}

export interface CommitRef {
  sha: string;
  url?: string;
}

export interface OpenPullRequestInput {
  repo: RepoRef;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
}

export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented';

export interface Review {
  author: Identity;
  verdict: ReviewVerdict;
  body: string;
  at: Timestamp;
}

/**
 * The combined state of the checks and statuses on a pull request's head. `unknown` when the
 * credentials may not read them, as with a token scoped too narrowly to see them.
 */
export type ChecksState = 'none' | 'pending' | 'passing' | 'failing' | 'unknown';

export interface PullRequestStatus {
  ref: PullRequestRef;
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  baseBranch: string;
  /** `unknown` while the external system is still computing it. */
  mergeable: boolean | 'unknown';
  checks: ChecksState;
  /** Reviews in time order; gates read the latest verdict per reviewer. */
  reviews: Review[];
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface SourceControl {
  /** Registry id of this adapter. */
  readonly id: string;

  clone(repo: RepoRef, into: string, options?: { ref?: string; depth?: number }): Promise<WorkingCopy>;
  createBranch(copy: WorkingCopy, name: string, from?: string): Promise<void>;
  /** Commits all staged and unstaged changes, or only `paths` when given. */
  commit(copy: WorkingCopy, message: string, options?: { author?: Identity; paths?: string[] }): Promise<CommitRef>;
  /**
   * Pushes the branch to the same name. With `replace`, an existing remote branch is
   * overwritten; the core only asks for that on its own branches: one with no PR yet, or one
   * rebuilt on the current base after its change conflicted with it.
   */
  push(copy: WorkingCopy, branch: string, options?: { replace?: boolean }): Promise<void>;
  openPR(input: OpenPullRequestInput): Promise<PullRequestRef>;
  getPRStatus(pr: PullRequestRef): Promise<PullRequestStatus>;
  /**
   * Refuses (AdapterError `conflict`) if the head moved past `expectedHeadSha`, and with
   * `merge_conflict` if the change conflicts with the base branch.
   */
  merge(pr: PullRequestRef, options: { method: MergeMethod; expectedHeadSha: string }): Promise<CommitRef>;
  comment(pr: PullRequestRef, body: string): Promise<CommentRef>;
}

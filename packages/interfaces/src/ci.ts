import type { ExternalRef, RepoRef, Timestamp } from './common.ts';

export interface CIRunRef extends ExternalRef {}

export type CIRunState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';

export interface CIJob {
  name: string;
  state: CIRunState;
}

export interface CIRunStatus {
  ref: CIRunRef;
  state: CIRunState;
  /** Commit the run built. */
  sha: string;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  jobs: CIJob[];
}

export interface CIArtifact {
  name: string;
  sizeBytes: number;
}

export interface CI {
  readonly id: string;

  /** Starts a pipeline on a branch or commit. Some systems also start runs on push; see `findRuns`. */
  trigger(input: { repo: RepoRef; ref: string; pipeline?: string }): Promise<CIRunRef>;
  /** Runs for a commit, newest first, including ones started by a push. */
  findRuns(repo: RepoRef, sha: string): Promise<CIRunRef[]>;
  getRunStatus(run: CIRunRef): Promise<CIRunStatus>;
  getArtifacts(run: CIRunRef): Promise<CIArtifact[]>;
  /** Downloads one artifact into `toDir` and returns the path written. */
  downloadArtifact(run: CIRunRef, name: string, toDir: string): Promise<string>;
  getLogs(run: CIRunRef, options?: { job?: string; tailLines?: number }): Promise<string>;
}

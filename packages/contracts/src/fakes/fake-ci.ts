// CI that reports whatever a test tells it to: runs are registered per commit and move
// through states on demand. For orchestrator tests and the CI contract suite.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError, type CI, type CIArtifact, type CIRunRef, type CIRunState, type CIRunStatus, type RepoRef } from '@cradleworks/interfaces';

interface FakeRun {
  ref: CIRunRef;
  repoId: string;
  sha: string;
  /** States reported on successive getRunStatus calls; the last one sticks. */
  states: CIRunState[];
  jobs: Array<{ name: string; failed: boolean; log: string }>;
  artifacts: Record<string, string>;
  polls: number;
}

export interface FakeRunSpec {
  /** Final state; `pendingPolls` polls report `running` first. */
  state: CIRunState;
  pendingPolls?: number;
  jobs?: Array<{ name: string; failed?: boolean; log?: string }>;
  artifacts?: Record<string, string>;
}

export class FakeCI implements CI {
  readonly id = 'fake-ci';
  readonly #runs: FakeRun[] = [];
  /** Called for every findRuns, so a test can start runs when a commit is pushed. */
  onFind?: (repo: RepoRef, sha: string) => void;

  addRun(repo: RepoRef, sha: string, spec: FakeRunSpec): CIRunRef {
    const id = `run-${this.#runs.length + 1}`;
    const ref = { id, url: `https://ci.invalid/${id}` };
    const pending = Array.from({ length: spec.pendingPolls ?? 0 }, (): CIRunState => 'running');
    this.#runs.push({
      ref,
      repoId: repo.id,
      sha,
      states: [...pending, spec.state],
      jobs: (spec.jobs ?? [{ name: 'build' }]).map((j) => ({ name: j.name, failed: j.failed ?? false, log: j.log ?? `${j.name} ok` })),
      artifacts: spec.artifacts ?? {},
      polls: 0,
    });
    return ref;
  }

  async trigger(input: { repo: RepoRef; ref: string }): Promise<CIRunRef> {
    return this.addRun(input.repo, input.ref, { state: 'passed' });
  }

  async findRuns(repo: RepoRef, sha: string): Promise<CIRunRef[]> {
    this.onFind?.(repo, sha);
    return this.#runs
      .filter((r) => r.repoId === repo.id && r.sha === sha)
      .reverse()
      .map((r) => r.ref);
  }

  async getRunStatus(ref: CIRunRef): Promise<CIRunStatus> {
    const run = this.#find(ref, 'getRunStatus');
    const state = run.states[Math.min(run.polls, run.states.length - 1)]!;
    run.polls += 1;
    const done = state !== 'running' && state !== 'queued';
    return {
      ref: run.ref,
      state,
      sha: run.sha,
      jobs: run.jobs.map((j) => ({ name: j.name, state: done ? (j.failed ? 'failed' : 'passed') : 'running' })),
    };
  }

  async getArtifacts(ref: CIRunRef): Promise<CIArtifact[]> {
    const run = this.#find(ref, 'getArtifacts');
    return Object.entries(run.artifacts).map(([name, text]) => ({ name, sizeBytes: Buffer.byteLength(text) }));
  }

  async downloadArtifact(ref: CIRunRef, name: string, toDir: string): Promise<string> {
    const text = this.#find(ref, 'downloadArtifact').artifacts[name];
    if (text === undefined) throw new AdapterError('not_found', `no artifact ${name}`, { adapter: this.id, operation: 'downloadArtifact' });
    const path = join(toDir, name);
    writeFileSync(path, text);
    return path;
  }

  async getLogs(ref: CIRunRef, options: { job?: string; tailLines?: number } = {}): Promise<string> {
    const run = this.#find(ref, 'getLogs');
    const jobs = options.job ? run.jobs.filter((j) => j.name === options.job) : run.jobs;
    const lines = jobs.flatMap((j) => j.log.split('\n'));
    return lines.slice(-(options.tailLines ?? lines.length)).join('\n');
  }

  #find(ref: CIRunRef, operation: string): FakeRun {
    const run = this.#runs.find((r) => r.ref.id === ref.id);
    if (!run) throw new AdapterError('not_found', `no run ${ref.id}`, { adapter: this.id, operation });
    return run;
  }
}

// CI on GitHub Actions, over the REST API. Runs are found by commit, so the runs a push
// starts are seen without triggering anything; `trigger` dispatches a named workflow.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError, type CI, type CIArtifact, type CIJob, type CIRunRef, type CIRunState, type CIRunStatus, type RepoRef } from '@cradleworks/interfaces';
import { defaultTokenProvider, type TokenProvider } from './auth.ts';
import { httpError } from './github-source-control.ts';

const ADAPTER = 'github-actions';

export interface GitHubActionsOptions {
  token?: TokenProvider;
  /** REST API root. Default https://api.github.com */
  apiBase?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  clock?: () => number;
}

interface RawRun {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  run_started_at?: string | null;
  updated_at?: string;
  created_at: string;
}

interface RawJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export class GitHubActionsCI implements CI {
  readonly id = ADAPTER;
  readonly #tokenProvider: TokenProvider;
  readonly #api: string;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  #token: Promise<string> | undefined;

  constructor(options: GitHubActionsOptions = {}) {
    this.#tokenProvider = options.token ?? defaultTokenProvider;
    this.#api = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
  }

  /** Dispatches workflow `pipeline` (its file name, e.g. ci.yml) on `ref` and returns the run it started. */
  async trigger(input: { repo: RepoRef; ref: string; pipeline?: string }): Promise<CIRunRef> {
    if (!input.pipeline) throw fail('invalid_input', 'trigger', 'GitHub Actions needs the workflow file name as `pipeline`');
    const { owner, name } = parseRepo(input.repo, 'trigger');
    const since = new Date(this.#clock() - 5_000).toISOString();
    await this.#request('trigger', 'POST', `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(input.pipeline)}/dispatches`, { ref: input.ref });
    for (let i = 0; i < 20; i++) {
      const { workflow_runs } = await this.#request<{ workflow_runs: RawRun[] }>(
        'trigger',
        'GET',
        `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(input.pipeline)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(input.ref)}&per_page=5`,
      );
      const run = workflow_runs.find((r) => r.created_at >= since);
      if (run) return runRef(owner, name, run);
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw fail('timeout', 'trigger', `workflow ${input.pipeline} was dispatched but no run appeared`);
  }

  async findRuns(repo: RepoRef, sha: string): Promise<CIRunRef[]> {
    const { owner, name } = parseRepo(repo, 'findRuns');
    const { workflow_runs } = await this.#request<{ workflow_runs: RawRun[] }>('findRuns', 'GET', `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`);
    return workflow_runs
      .filter((r) => r.head_sha === sha)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) => runRef(owner, name, r));
  }

  async getRunStatus(ref: CIRunRef): Promise<CIRunStatus> {
    const { owner, name, id } = parseRun(ref, 'getRunStatus');
    const base = `/repos/${owner}/${name}/actions/runs/${id}`;
    const [run, { jobs }] = await Promise.all([this.#request<RawRun>('getRunStatus', 'GET', base), this.#request<{ jobs: RawJob[] }>('getRunStatus', 'GET', `${base}/jobs?per_page=100`)]);
    return {
      ref: runRef(owner, name, run),
      state: toState(run.status, run.conclusion),
      sha: run.head_sha,
      ...(run.run_started_at ? { startedAt: run.run_started_at } : {}),
      ...(run.status === 'completed' && run.updated_at ? { endedAt: run.updated_at } : {}),
      jobs: jobs.map((j): CIJob => ({ name: j.name, state: toState(j.status, j.conclusion) })),
    };
  }

  async getArtifacts(ref: CIRunRef): Promise<CIArtifact[]> {
    const { owner, name, id } = parseRun(ref, 'getArtifacts');
    const { artifacts } = await this.#request<{ artifacts: Array<{ name: string; size_in_bytes: number }> }>('getArtifacts', 'GET', `/repos/${owner}/${name}/actions/runs/${id}/artifacts?per_page=100`);
    return artifacts.map((a) => ({ name: a.name, sizeBytes: a.size_in_bytes }));
  }

  /** Writes the artifact as GitHub serves it: a zip file named `<name>.zip`. */
  async downloadArtifact(ref: CIRunRef, artifactName: string, toDir: string): Promise<string> {
    const { owner, name, id } = parseRun(ref, 'downloadArtifact');
    const { artifacts } = await this.#request<{ artifacts: Array<{ id: number; name: string }> }>('downloadArtifact', 'GET', `/repos/${owner}/${name}/actions/runs/${id}/artifacts?per_page=100`);
    const artifact = artifacts.find((a) => a.name === artifactName);
    if (!artifact) throw fail('not_found', 'downloadArtifact', `run ${id} has no artifact ${artifactName}`);
    const bytes = await this.#raw('downloadArtifact', `/repos/${owner}/${name}/actions/artifacts/${artifact.id}/zip`);
    const path = join(toDir, `${artifactName.replace(/[^A-Za-z0-9._-]/g, '_')}.zip`);
    writeFileSync(path, Buffer.from(bytes));
    return path;
  }

  /** One job's log, or every failed job's (every job's if none failed), with timestamps removed. */
  async getLogs(ref: CIRunRef, options: { job?: string; tailLines?: number } = {}): Promise<string> {
    const { owner, name, id } = parseRun(ref, 'getLogs');
    const { jobs } = await this.#request<{ jobs: RawJob[] }>('getLogs', 'GET', `/repos/${owner}/${name}/actions/runs/${id}/jobs?per_page=100`);
    let chosen = options.job ? jobs.filter((j) => j.name === options.job) : jobs.filter((j) => toState(j.status, j.conclusion) === 'failed');
    if (options.job && chosen.length === 0) throw fail('not_found', 'getLogs', `run ${id} has no job named ${options.job}`);
    if (chosen.length === 0) chosen = jobs;
    const parts: string[] = [];
    for (const job of chosen) {
      const text = new TextDecoder().decode(await this.#raw('getLogs', `/repos/${owner}/${name}/actions/jobs/${job.id}/logs`));
      const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
      parts.push(...(chosen.length > 1 ? [`== ${job.name} ==`] : []), ...lines);
    }
    const all = parts.join('\n').trimEnd().split('\n');
    return (options.tailLines ? all.slice(-options.tailLines) : all).join('\n');
  }

  async #request<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#send(operation, method, path, body);
    const text = await response.text();
    const data: unknown = text ? safeJson(text) : undefined;
    if (response.ok) return data as T;
    throw retag(httpError(response, data, operation));
  }

  async #raw(operation: string, path: string): Promise<ArrayBuffer> {
    const response = await this.#send(operation, 'GET', path);
    if (response.ok) return response.arrayBuffer();
    const text = await response.text();
    throw retag(httpError(response, text ? safeJson(text) : undefined, operation));
  }

  async #send(operation: string, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#getToken();
    try {
      return await this.#fetch(`${this.#api}${path}`, {
        method,
        redirect: 'follow',
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
  }

  #getToken(): Promise<string> {
    this.#token ??= this.#tokenProvider().catch((cause: unknown) => {
      this.#token = undefined;
      throw new AdapterError('unauthorized', cause instanceof Error ? cause.message : String(cause), { adapter: ADAPTER, operation: 'auth', cause });
    });
    return this.#token;
  }
}

export function toState(status: string, conclusion: string | null): CIRunState {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  switch (conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'error';
  }
}

function runRef(owner: string, name: string, run: RawRun): CIRunRef {
  return { id: `${owner}/${name}/actions/runs/${run.id}`, url: run.html_url };
}

function parseRepo(repo: RepoRef, operation: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo.id);
  if (!m) throw fail('invalid_input', operation, `repository id must be "owner/name", got "${repo.id}"`);
  return { owner: m[1]!, name: m[2]! };
}

function parseRun(ref: CIRunRef, operation: string): { owner: string; name: string; id: string } {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/(\d+)$/.exec(ref.id);
  if (!m) throw fail('invalid_input', operation, `run id must be "owner/name/actions/runs/<n>", got "${ref.id}"`);
  return { owner: m[1]!, name: m[2]!, id: m[3]! };
}

function retag(error: AdapterError): AdapterError {
  return new AdapterError(error.code, error.message, { adapter: ADAPTER, operation: error.operation, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fail(code: AdapterError['code'], operation: string, message: string): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation });
}

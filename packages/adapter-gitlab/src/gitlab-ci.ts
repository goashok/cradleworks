// CI on GitLab CI/CD pipelines. A push starts a pipeline when the project has a .gitlab-ci.yml,
// so Verify finds it by commit; `trigger` starts one by hand. CIRunRef ids are "group/name@pipeline".

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError, type CI, type CIArtifact, type CIJob, type CIRunRef, type CIRunState, type CIRunStatus, type RepoRef } from '@cradleworks/interfaces';
import { GitLabApi, parseProjectPath, projectId, type GitLabOptions } from './api.ts';

const ADAPTER = 'gitlab-ci';

interface RawPipeline {
  id: number;
  web_url: string;
  status: string;
  sha: string;
  started_at?: string | null;
  finished_at?: string | null;
}

interface RawJob {
  id: number;
  name: string;
  status: string;
  artifacts_file?: { filename: string; size: number } | null;
  artifacts?: Array<{ file_type: string; size: number; filename: string }>;
}

export class GitLabCI implements CI {
  readonly id = ADAPTER;
  readonly #api: GitLabApi;

  constructor(options: GitLabOptions = {}) {
    this.#api = new GitLabApi(ADAPTER, options);
  }

  async trigger(input: { repo: RepoRef; ref: string; pipeline?: string }): Promise<CIRunRef> {
    const path = parseProjectPath(input.repo.id, ADAPTER, 'trigger');
    const p = await this.#api.request<RawPipeline>('trigger', 'POST', `/projects/${projectId(path)}/pipeline?ref=${encodeURIComponent(input.ref)}`);
    return { id: `${path}@${p.id}`, url: p.web_url };
  }

  async findRuns(repo: RepoRef, sha: string): Promise<CIRunRef[]> {
    const path = parseProjectPath(repo.id, ADAPTER, 'findRuns');
    const runs = await this.#api.request<RawPipeline[]>('findRuns', 'GET', `/projects/${projectId(path)}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc&per_page=100`);
    return runs.map((p) => ({ id: `${path}@${p.id}`, url: p.web_url }));
  }

  async getRunStatus(run: CIRunRef): Promise<CIRunStatus> {
    const { path, id } = parseRun(run, 'getRunStatus');
    const base = `/projects/${projectId(path)}/pipelines/${id}`;
    const p = await this.#api.request<RawPipeline>('getRunStatus', 'GET', base);
    const jobs = await this.#jobs(path, id, 'getRunStatus');
    // A job retried in the same pipeline appears twice; the newest attempt counts.
    const latest = new Map<string, RawJob>();
    for (const j of jobs) if (!latest.has(j.name) || latest.get(j.name)!.id < j.id) latest.set(j.name, j);
    return {
      ref: { id: run.id, url: p.web_url },
      state: stateOf(p.status),
      sha: p.sha,
      ...(p.started_at ? { startedAt: p.started_at } : {}),
      ...(p.finished_at ? { endedAt: p.finished_at } : {}),
      jobs: [...latest.values()].map((j): CIJob => ({ name: j.name, state: stateOf(j.status) })),
    };
  }

  async getArtifacts(run: CIRunRef): Promise<CIArtifact[]> {
    const { path, id } = parseRun(run, 'getArtifacts');
    return (await this.#jobs(path, id, 'getArtifacts')).filter((j) => j.artifacts_file).map((j) => ({ name: j.name, sizeBytes: j.artifacts_file!.size }));
  }

  async downloadArtifact(run: CIRunRef, name: string, toDir: string): Promise<string> {
    const { path, id } = parseRun(run, 'downloadArtifact');
    const job = (await this.#jobs(path, id, 'downloadArtifact')).find((j) => j.name === name && j.artifacts_file);
    if (!job) throw new AdapterError('not_found', `no artifact ${name} on ${run.id}`, { adapter: ADAPTER, operation: 'downloadArtifact' });
    const response = await this.#api.raw('downloadArtifact', 'GET', `/projects/${projectId(path)}/jobs/${job.id}/artifacts`);
    if (!response.ok) throw new AdapterError(response.status === 404 ? 'not_found' : 'unavailable', `GitLab ${response.status} downloading ${name}`, { adapter: ADAPTER, operation: 'downloadArtifact' });
    mkdirSync(toDir, { recursive: true });
    const file = join(toDir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.zip`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    return file;
  }

  async getLogs(run: CIRunRef, options: { job?: string; tailLines?: number } = {}): Promise<string> {
    const { path, id } = parseRun(run, 'getLogs');
    const jobs = await this.#jobs(path, id, 'getLogs');
    const wanted = options.job ? jobs.filter((j) => j.name === options.job) : jobs.filter((j) => j.status === 'failed');
    if (options.job && wanted.length === 0) throw new AdapterError('not_found', `no job ${options.job} in ${run.id}`, { adapter: ADAPTER, operation: 'getLogs' });
    const tail = options.tailLines ?? 200;
    const parts: string[] = [];
    for (const j of wanted.sort((a, b) => b.id - a.id).slice(0, 3)) {
      const response = await this.#api.raw('getLogs', 'GET', `/projects/${projectId(path)}/jobs/${j.id}/trace`);
      const text = response.ok ? stripAnsi(await response.text()) : `(log unavailable: GitLab ${response.status})`;
      parts.push(text);
    }
    return parts.join('\n').split('\n').slice(-tail).join('\n');
  }

  async #jobs(path: string, pipeline: number, operation: string): Promise<RawJob[]> {
    return this.#api.all<RawJob>(operation, `/projects/${projectId(path)}/pipelines/${pipeline}/jobs?include_retried=true`, 5);
  }
}

export function stateOf(status: string): CIRunState {
  switch (status) {
    case 'success':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'canceled':
    case 'canceling':
    case 'skipped':
      return 'cancelled';
    case 'created':
    case 'waiting_for_resource':
    case 'waiting_for_callback':
    case 'preparing':
    case 'pending':
    case 'scheduled':
    case 'manual':
      return 'queued';
    default:
      return 'error';
  }
}

function parseRun(run: CIRunRef, operation: string): { path: string; id: number } {
  const m = /^(.+)@(\d+)$/.exec(run.id);
  if (!m) throw new AdapterError('invalid_input', `pipeline id must be "group/name@id", got "${run.id}"`, { adapter: ADAPTER, operation });
  return { path: parseProjectPath(m[1]!, ADAPTER, operation), id: Number(m[2]) };
}

function stripAnsi(text: string): string {
  // GitLab traces carry colour codes and section markers.
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/section_(start|end):\d+:[^\r\n]*\r?/g, '').replace(/\r(?!\n)/g, '\n');
}

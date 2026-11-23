// An in-process stand-in for the GitLab REST API, for tests: a `fetch` that answers the
// endpoints the adapters use. Projects are real bare git repositories in a folder, so clone,
// push and merge go through git; issues, notes, members and pipelines live in memory.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface Note {
  id: number;
  body: string;
  created_at: string;
  system: boolean;
  author: { username: string; name: string };
}
interface Issue {
  iid: number;
  title: string;
  description: string;
  state: 'opened' | 'closed';
  labels: string[];
  created_at: string;
  author: { username: string; name: string };
  notes: Note[];
}
interface MR {
  iid: number;
  source_branch: string;
  target_branch: string;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged';
  merge_commit_sha?: string;
  notes: Note[];
  approved_by: string[];
}
export interface FakeJob {
  name: string;
  status: string;
  log?: string;
  artifact?: { filename: string; content: string };
}
interface Pipeline {
  id: number;
  sha: string;
  ref: string;
  status: string;
  jobs: Array<FakeJob & { id: number }>;
}
interface Project {
  path: string;
  bare: string;
  issues: Issue[];
  mrs: MR[];
  pipelines: Pipeline[];
  /** user id → access level */
  members: Map<number, number>;
}

const WEB = 'https://gitlab.example';

export class FakeGitLab {
  readonly root: string;
  /** The `gitBase` to give the adapters: projects clone from here. */
  readonly gitBase: string;
  readonly baseUrl = WEB;
  /** The user the token belongs to. */
  readonly me = { id: 1, username: 'factory-bot', name: 'Factory Bot' };
  readonly #projects = new Map<string, Project>();
  readonly #users = new Map<string, number>([['factory-bot', 1]]);
  #ids = 100;
  #clock = Date.parse('2026-01-01T00:00:00Z');

  constructor(root = mkdtempSync(join(tmpdir(), 'fake-gitlab-'))) {
    this.root = root;
    this.gitBase = `file://${root}`;
  }

  /** A project whose `main` holds a committed README.md. */
  addProject(path: string): void {
    const bare = join(this.root, `${path}.git`);
    mkdirSync(bare, { recursive: true });
    git(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'fake-gitlab-seed-'));
    git(['init', '--quiet', '--initial-branch=main', seed]);
    writeFileSync(join(seed, 'README.md'), `# ${path}\n`);
    git(['add', '.'], seed);
    git(['commit', '--quiet', '-m', 'Initial commit'], seed);
    git(['push', '--quiet', bare, 'main'], seed);
    rmSync(seed, { recursive: true, force: true });
    this.#projects.set(path, { path, bare, issues: [], mrs: [], pipelines: [], members: new Map([[1, 40]]) });
  }

  addUser(username: string, accessLevel?: number, project?: string): number {
    const id = this.#users.get(username) ?? ++this.#ids;
    this.#users.set(username, id);
    if (accessLevel !== undefined && project) this.#project(project).members.set(id, accessLevel);
    return id;
  }

  addIssue(project: string, input: { title: string; description?: string; labels?: string[]; author?: string }): number {
    const p = this.#project(project);
    const iid = p.issues.length + 1;
    const author = input.author ?? 'someone';
    p.issues.push({ iid, title: input.title, description: input.description ?? '', state: 'opened', labels: input.labels ?? [], created_at: this.#now(), author: { username: author, name: author }, notes: [] });
    return iid;
  }

  addNote(project: string, iid: number, body: string, author = 'someone'): void {
    this.#project(project).issues.find((i) => i.iid === iid)!.notes.push(this.#note(body, author));
  }

  addPipeline(project: string, input: { sha: string; status: string; ref?: string; jobs: FakeJob[] }): number {
    const id = ++this.#ids;
    this.#project(project).pipelines.push({ id, sha: input.sha, ref: input.ref ?? 'main', status: input.status, jobs: input.jobs.map((j) => ({ ...j, id: ++this.#ids })) });
    return id;
  }

  /** Commits one file straight to a branch, as a person would; returns the commit. */
  pushCommit(project: string, branch: string, file: string, content: string): string {
    const p = this.#project(project);
    const work = mkdtempSync(join(tmpdir(), 'fake-gitlab-push-'));
    git(['clone', '--quiet', p.bare, work]);
    if (branch !== 'main') git(['checkout', '--quiet', '-B', branch], work);
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), content);
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', `Change ${file}`], work);
    git(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`], work);
    const sha = git(['rev-parse', 'HEAD'], work).trim();
    rmSync(work, { recursive: true, force: true });
    return sha;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    if (!headers.get('PRIVATE-TOKEN')) return json(401, { message: '401 Unauthorized' });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const q = url.searchParams;
    for (const [k, v] of q) if (!(k in body)) body[k] = v;
    const parts = url.pathname.replace(/^\/api\/v4\//, '').split('/').map(decodeURIComponent);
    try {
      return this.#route(method, parts, body, q);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { message: error.message });
      throw error;
    }
  };

  #route(method: string, parts: string[], body: Record<string, unknown>, q: URLSearchParams): Response {
    const route = `${method} ${parts.map((s, i) => (i === 1 && parts[0] === 'projects' ? ':p' : /^\d+$/.test(s) ? ':n' : s)).join('/')}`;
    if (route === 'GET users') {
      const id = this.#users.get(String(q.get('username')));
      return json(200, id ? [{ id, username: q.get('username') }] : []);
    }
    if (parts[0] !== 'projects') throw new HttpError(404, '404 Not Found');
    const p = this.#projects.get(parts[1]!);
    if (!p) throw new HttpError(404, '404 Project Not Found');
    const n = Number(parts[3]);
    const page = <T>(items: T[]) => {
      const per = Number(q.get('per_page') ?? 20);
      const at = (Number(q.get('page') ?? 1) - 1) * per;
      return json(200, items.slice(at, at + per));
    };

    if (method === 'GET' && parts[2] === 'repository' && parts[3] === 'branches' && parts.length > 4) {
      const name = parts.slice(4).join('/');
      const sha = this.#sha(p, name);
      if (!sha) throw new HttpError(404, '404 Branch Not Found');
      return json(200, { name, commit: { id: sha } });
    }

    switch (route) {
      // --- merge requests
      case 'POST projects/:p/merge_requests': {
        const source = String(body.source_branch);
        if (!this.#sha(p, source)) throw new HttpError(400, 'Invalid source branch');
        if (p.mrs.some((m) => m.state === 'opened' && m.source_branch === source)) {
          throw new HttpError(409, `Another open merge request already exists for this source branch: !${p.mrs.find((m) => m.source_branch === source)!.iid}`);
        }
        const mr: MR = { iid: p.mrs.length + 1, source_branch: source, target_branch: String(body.target_branch), title: String(body.title), description: String(body.description ?? ''), state: 'opened', notes: [], approved_by: [] };
        p.mrs.push(mr);
        return json(201, this.#mrJson(p, mr));
      }
      case 'GET projects/:p/merge_requests/:n':
        return json(200, this.#mrJson(p, this.#mr(p, n)));
      case 'GET projects/:p/merge_requests/:n/approvals':
        return json(200, { approved_by: this.#mr(p, n).approved_by.map((u) => ({ user: { username: u, name: u } })) });
      case 'GET projects/:p/merge_requests/:n/reviewers':
        this.#mr(p, n);
        return json(200, []);
      case 'POST projects/:p/merge_requests/:n/notes': {
        const note = this.#note(String(body.body), this.me.username);
        this.#mr(p, n).notes.push(note);
        return json(201, note);
      }
      case 'PUT projects/:p/merge_requests/:n/merge': {
        const mr = this.#mr(p, n);
        if (mr.state !== 'opened') throw new HttpError(405, '405 Method Not Allowed');
        const head = this.#sha(p, mr.source_branch);
        if (body.sha && body.sha !== head) throw new HttpError(409, 'SHA does not match HEAD of source branch');
        mr.merge_commit_sha = this.#mergeBranch(p, mr, body.squash === true);
        mr.state = 'merged';
        return json(200, this.#mrJson(p, mr));
      }
      // --- issues
      case 'GET projects/:p/issues': {
        const labels = (q.get('labels') ?? '').split(',').filter(Boolean);
        const state = q.get('state');
        return page(p.issues.filter((i) => (!state || i.state === state) && labels.every((l) => i.labels.includes(l))).map((i) => this.#issueJson(p, i)));
      }
      case 'GET projects/:p/issues/:n':
        return json(200, this.#issueJson(p, this.#issue(p, n)));
      case 'PUT projects/:p/issues/:n': {
        const issue = this.#issue(p, n);
        const remove = String(body.remove_labels ?? '').split(',').filter(Boolean);
        const add = String(body.add_labels ?? '').split(',').filter(Boolean);
        issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !issue.labels.includes(l))];
        if (body.state_event === 'close') issue.state = 'closed';
        if (remove.length || add.length) issue.notes.push({ ...this.#note('changed labels', this.me.username), system: true });
        return json(200, this.#issueJson(p, issue));
      }
      case 'GET projects/:p/issues/:n/notes':
        return page(this.#issue(p, n).notes);
      case 'POST projects/:p/issues/:n/notes': {
        const note = this.#note(String(body.body), this.me.username);
        this.#issue(p, n).notes.push(note);
        return json(201, note);
      }
      case 'GET projects/:p/members/all/:n': {
        const user = Number(parts[4]);
        const level = p.members.get(user);
        if (level === undefined) throw new HttpError(404, '404 Not found');
        return json(200, { id: user, access_level: level });
      }
      // --- pipelines
      case 'GET projects/:p/pipelines':
        return json(200, p.pipelines.filter((x) => !q.get('sha') || x.sha === q.get('sha')).sort((a, b) => b.id - a.id).map((x) => this.#pipelineJson(p, x)));
      case 'POST projects/:p/pipeline': {
        const ref = String(body.ref);
        const sha = this.#sha(p, ref);
        if (!sha) throw new HttpError(400, 'Reference not found');
        const id = this.addPipeline(p.path, { sha, ref, status: 'pending', jobs: [{ name: 'test', status: 'pending' }] });
        return json(201, this.#pipelineJson(p, this.#pipeline(p, id)));
      }
      case 'GET projects/:p/pipelines/:n':
        return json(200, this.#pipelineJson(p, this.#pipeline(p, n)));
      case 'GET projects/:p/pipelines/:n/jobs':
        return page(this.#pipeline(p, n).jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, artifacts_file: j.artifact ? { filename: j.artifact.filename, size: j.artifact.content.length } : null })));
      case 'GET projects/:p/jobs/:n/trace': {
        const job = p.pipelines.flatMap((x) => x.jobs).find((j) => j.id === n);
        if (!job) throw new HttpError(404, '404 Not found');
        return new Response(job.log ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      case 'GET projects/:p/jobs/:n/artifacts': {
        const job = p.pipelines.flatMap((x) => x.jobs).find((j) => j.id === n);
        if (!job?.artifact) throw new HttpError(404, '404 Not found');
        return new Response(job.artifact.content, { status: 200, headers: { 'Content-Type': 'application/zip' } });
      }
      default:
        throw new HttpError(404, `404 Not Found (${route})`);
    }
  }

  #project(path: string): Project {
    const p = this.#projects.get(path);
    if (!p) throw new Error(`no project ${path}`);
    return p;
  }
  #mr(p: Project, iid: number): MR {
    const mr = p.mrs.find((m) => m.iid === iid);
    if (!mr) throw new HttpError(404, '404 Not found');
    return mr;
  }
  #issue(p: Project, iid: number): Issue {
    const i = p.issues.find((x) => x.iid === iid);
    if (!i) throw new HttpError(404, '404 Not found');
    return i;
  }
  #pipeline(p: Project, id: number): Pipeline {
    const x = p.pipelines.find((y) => y.id === id);
    if (!x) throw new HttpError(404, '404 Not found');
    return x;
  }
  #sha(p: Project, ref: string): string | undefined {
    try {
      return git(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], p.bare).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  #now(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }
  #note(body: string, author: string): Note {
    return { id: ++this.#ids, body, created_at: this.#now(), system: false, author: { username: author, name: author } };
  }
  #mrJson(p: Project, mr: MR) {
    const sha = this.#sha(p, mr.source_branch) ?? '';
    const pipeline = p.pipelines.filter((x) => x.sha === sha).sort((a, b) => b.id - a.id)[0];
    return {
      iid: mr.iid,
      web_url: `${WEB}/${p.path}/-/merge_requests/${mr.iid}`,
      state: mr.state,
      sha,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      detailed_merge_status: mr.state === 'opened' ? 'mergeable' : 'not_open',
      updated_at: this.#now(),
      head_pipeline: pipeline ? { status: pipeline.status } : null,
      merge_commit_sha: mr.merge_commit_sha ?? null,
    };
  }
  #issueJson(p: Project, i: Issue) {
    return { iid: i.iid, web_url: `${WEB}/${p.path}/-/issues/${i.iid}`, title: i.title, description: i.description, state: i.state, created_at: i.created_at, author: i.author, labels: i.labels };
  }
  #pipelineJson(p: Project, x: Pipeline) {
    return { id: x.id, web_url: `${WEB}/${p.path}/-/pipelines/${x.id}`, status: x.status, sha: x.sha, ref: x.ref };
  }
  #mergeBranch(p: Project, mr: MR, squash: boolean): string {
    const work = mkdtempSync(join(tmpdir(), 'fake-gitlab-merge-'));
    try {
      git(['clone', '--quiet', '--branch', mr.target_branch, p.bare, work]);
      if (squash) {
        git(['merge', '--quiet', '--squash', `origin/${mr.source_branch}`], work);
        git(['commit', '--quiet', '-m', mr.title], work);
      } else {
        git(['merge', '--quiet', '--no-ff', '-m', `Merge branch '${mr.source_branch}'`, `origin/${mr.source_branch}`], work);
      }
      git(['push', '--quiet', 'origin', `HEAD:refs/heads/${mr.target_branch}`], work);
      return git(['rev-parse', 'HEAD'], work).trim();
    } catch {
      throw new HttpError(406, 'Branch cannot be merged');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fake', GIT_AUTHOR_EMAIL: 'fake@example.invalid', GIT_COMMITTER_NAME: 'Fake', GIT_COMMITTER_EMAIL: 'fake@example.invalid' },
  });
}

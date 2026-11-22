// Hard rules: what no factory.yaml can turn off.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBareRepo,
  InMemoryStateStore,
  LocalGitSourceControl,
  localRepoRef,
  ProcessSandbox,
  ScriptedAgentRuntime,
  type ScriptStep,
} from '@cradleworks/contracts/fakes';
import type { AgentRunRequest, NetworkDecision } from '@cradleworks/interfaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/types.ts';
import { assertFactoryBranch, assertMergeTarget, protectedPathsIn, scanDiffForSecrets } from './hard-rules.ts';
import { Orchestrator, type Project } from './index.ts';

// Built at run time, so nothing that looks like a key is ever committed.
const PRIVATE_KEY = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');

describe('protected paths', () => {
  it('matches the built-in and added paths, wherever they sit, and nothing else', () => {
    const changed = ['.factory/factory.yaml', 'docs/CODEOWNERS', 'src/factory/index.ts', 'ci/pipeline.yml', 'svc/ci/run.sh', 'README.md'];
    expect(protectedPathsIn(changed)).toEqual(['.factory/factory.yaml', 'docs/CODEOWNERS']);
    expect(protectedPathsIn(changed, ['ci/'])).toEqual(['.factory/factory.yaml', 'docs/CODEOWNERS', 'ci/pipeline.yml', 'svc/ci/run.sh']);
  });
});

describe('branch and merge rules', () => {
  it('pushes only factory branches and merges only into the expected base', () => {
    expect(() => assertFactoryBranch('factory/abc123')).not.toThrow();
    for (const b of ['main', 'release/1.0', 'factory/../main', 'factory/', 'refs/heads/main']) expect(() => assertFactoryBranch(b)).toThrow(/hard rule/);
    expect(() => assertMergeTarget('main', 'main')).not.toThrow();
    expect(() => assertMergeTarget('release', 'main')).toThrow(/merges only into "main"/);
  });
});

describe('secret scan', () => {
  const diff = (file: string, ...lines: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +3,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;

  it('finds keys and secret files by line, never quoting the value', () => {
    const findings = scanDiffForSecrets(diff('deploy/notes.md', 'hello', PRIVATE_KEY) + diff('.env', 'A=1') + diff('db.ts', 'const url = "db://app:s3cretpassw0rd@db:5432/x";'));
    expect(findings).toEqual([
      { file: 'deploy/notes.md', line: 4, kind: 'private key' },
      { file: '.env', line: 0, kind: 'environment file' },
      { file: 'db.ts', line: 3, kind: 'password in a URL' },
    ]);
    expect(JSON.stringify(findings)).not.toContain('s3cret');
  });

  it('ignores removed lines, example env files and placeholders, and takes extra patterns', () => {
    const removed = `--- a/k.txt\n+++ b/k.txt\n@@ -1 +0,0 @@\n-${PRIVATE_KEY}\n`;
    expect(scanDiffForSecrets(removed + diff('.env.example', 'A=') + diff('db.ts', 'const url = `db://app:${PASSWORD}@db/x`;'))).toEqual([]);
    expect(scanDiffForSecrets(diff('a.ts', 'token = "zz_1234567890"'), [{ kind: 'test token', pattern: /\bzz_\d{10}\b/ }])).toEqual([{ file: 'a.ts', line: 3, kind: 'test token' }]);
  });
});

const config: ProjectConfig = {
  project: 'shop',
  adapters: { scm: 'local-git', ci: 'none', tracker: 'none', sandbox: 'process', runtime: 'scripted' },
  runtime: { agent: 'scripted', model: 'm', roles: {} },
  stack: { image: 'unused', commands: { build: 'true', test: 'true' } },
  context: { include: ['.'], rules: [] },
  gates: { specApproval: 'skipped', planCheck: 'skipped', changeApproval: 'ai', autoMerge: true },
  budgets: { perTaskUsd: 5, maxReworkLoops: 1 },
  specs: 'factory',
  concurrency: 1,
  verify: { tester: false },
  relatedRepos: [],
  network: { mode: 'none', allow: [] },
};

/** A process sandbox that reports network decisions, as a sandbox with an egress proxy does. */
class LoggedSandbox extends ProcessSandbox {
  async networkLog(): Promise<NetworkDecision[]> {
    return [
      { at: '2026-11-22T12:00:00Z', method: 'GATEWAY', host: 'model.example', port: 443, decision: 'allow', path: '/v1/messages' },
      { at: '2026-11-22T12:00:01Z', method: 'CONNECT', host: 'paste.example', port: 443, decision: 'deny', reason: 'not on the allow-list' },
    ];
  }
}

describe('hard rules in a build', () => {
  let root: string;
  let bare: string;
  let project: Project;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cw-hard-'));
    bare = join(root, 'shop.git');
    await createBareRepo(bare, { 'README.md': '# Shop\n' });
    project = { repo: localRepoRef(bare), config };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  let store: InMemoryStateStore;
  function orchestrator(writes: ScriptStep[]) {
    store = new InMemoryStateStore();
    const pass: ScriptStep = { kind: 'message', text: '```json\n{"verdict":"pass","risk":"low","reasons":["Fine."]}\n```' };
    const runtime = new ScriptedAgentRuntime((req: AgentRunRequest) => (req.profile.role === 'reviewer' ? [pass] : [...writes, { kind: 'message', text: 'Done.' }]));
    let ids = 0;
    return new Orchestrator({
      store,
      sourceControl: new LocalGitSourceControl(),
      sandbox: new LoggedSandbox(join(root, 'sandboxes')),
      runtime,
      workRoot: join(root, 'work'),
      newId: (kind) => `${kind}_${String(++ids).padStart(8, '0')}`,
      ciWait: { appearSeconds: 0, finishSeconds: 1, pollSeconds: 0 },
      hardRules: { protectedPaths: ['ci/'], deniedCommands: ['git push', 'ssh'] },
    });
  }
  const branches = () => execFileSync('git', ['--git-dir', bare, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n').filter(Boolean);

  it('holds a change to protected files for a person, even with the ai gate and auto-merge on', async () => {
    const o = orchestrator([{ kind: 'write', path: 'ci/pipeline.yml', content: 'steps: []\n' }]);
    const { workItemId, taskId } = await o.submitTask({ project, title: 'Speed up CI', body: 'Trim the pipeline.', requester: 'alex' });
    const held = await o.runTask(project, workItemId, taskId);
    expect(held).toMatchObject({ state: 'ready', awaitingApproval: true });
    expect((await o.getWorkItem(workItemId))!.tasks[0]!.protectedPaths).toEqual(['ci/pipeline.yml']);

    // A person approves, but nothing merges until someone asks for it.
    expect(await o.approveTask(project, workItemId, taskId, { by: 'sam' })).toEqual({});
    expect((await o.runTask(project, workItemId, taskId)).state).toBe('ready');
    expect((await o.approveTask(project, workItemId, taskId, { by: 'sam', merge: true })).merged).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses denied commands on every run, and logs each refusal', async () => {
    const withDeny = { ...project, config: { ...config, commands: { deny: ['curl'] } } };
    const o = orchestrator([
      { kind: 'command', command: 'git push origin main' },
      { kind: 'command', command: 'curl https://example.com' },
      { kind: 'command', command: 'git status' },
      { kind: 'write', path: 'notes.md', content: 'hi\n' },
    ]);
    const { workItemId, taskId } = await o.submitTask({ project: withDeny, title: 'Add notes', body: 'Write them.', requester: 'alex' });
    await o.runTask(withDeny, workItemId, taskId);
    const wi = (await o.getWorkItem(workItemId))!;
    const build = wi.runs.find((r) => r.station === 'build')!;
    const denied = (await store.readStream(build.id)).filter((e) => e.type === 'command_denied').map((e) => (e.payload as { detail: string }).detail);
    expect(denied).toEqual(['git push origin main', 'curl https://example.com']);
    const network = (await store.readStream(build.id)).find((e) => e.type === 'network_decisions')?.payload as { allowed: number; denied: number };
    expect(network).toMatchObject({ allowed: 1, denied: 1 });
  });

  it('pushes nothing when the change adds a secret, and says where without quoting it', async () => {
    const o = orchestrator([{ kind: 'write', path: 'keys/deploy.txt', content: `${PRIVATE_KEY}\nAAAA\n` }]);
    const { workItemId, taskId } = await o.submitTask({ project, title: 'Add deploy notes', body: 'Write them.', requester: 'alex' });
    const outcome = await o.runTask(project, workItemId, taskId);
    expect(outcome.state).toBe('escalated');
    expect(outcome.reason).toBe('secret scan: the change adds what looks like a secret (private key in keys/deploy.txt:1), so nothing was pushed. Remove it (load it from the environment or a secret store instead) and retry.');
    expect(branches()).toEqual(['main']);
  });
});

// GitLab-specific behaviour the shared contracts do not pin down.

import { expectAdapterError } from '@cradleworks/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGitLab } from './fake-gitlab.ts';
import { checksOf, mergeable } from './gitlab-source-control.ts';
import { stateOf } from './gitlab-ci.ts';
import { GitLabIssuesTracker, GitLabSourceControl, gitlabRepoFromRemote, tokenFromEnv } from './index.ts';

const token = async () => 'glpat-test';
let gl: FakeGitLab | undefined;
afterEach(() => gl?.cleanup());

describe('remotes', () => {
  it('reads project paths, subgroups included, from https and ssh remotes', () => {
    expect(gitlabRepoFromRemote('https://gitlab.com/acme/platform/shop.git')?.id).toBe('acme/platform/shop');
    expect(gitlabRepoFromRemote('git@gitlab.com:acme/shop.git')?.id).toBe('acme/shop');
    expect(gitlabRepoFromRemote('ssh://git@git.corp.example:2222/team/app', 'https://git.corp.example')?.id).toBe('team/app');
    expect(gitlabRepoFromRemote('https://elsewhere.example/acme/shop.git')).toBeUndefined();
    expect(gitlabRepoFromRemote('https://gitlab.com/shop.git')).toBeUndefined();
  });
});

describe('tracker', () => {
  it('reports a note added after the first poll, once, and skips system notes', async () => {
    gl = new FakeGitLab();
    gl.addProject('acme/shop');
    const iid = gl.addIssue('acme/shop', { title: 'T', labels: ['factory'] });
    gl.addNote('acme/shop', iid, 'already here');
    const tracker = new GitLabIssuesTracker({ token, baseUrl: gl.baseUrl, fetch: gl.fetch, pollSeconds: 0.02 });
    const abort = new AbortController();
    const seen: string[] = [];
    const deadline = setTimeout(() => abort.abort(), 3000);
    for await (const e of tracker.watch({ project: 'acme/shop', labels: ['factory'] }, abort.signal)) {
      seen.push(e.type);
      if (e.type === 'item_ready') {
        await tracker.setStatus(e.item, 'specifying'); // a system note
        gl.addNote('acme/shop', iid, '/approve spec');
      }
      if (e.type === 'comment_added') abort.abort();
    }
    clearTimeout(deadline);
    expect(seen).toEqual(['item_ready', 'comment_added']);
  });

  it('keeps one status label and leaves other labels alone', async () => {
    gl = new FakeGitLab();
    gl.addProject('acme/shop');
    const iid = gl.addIssue('acme/shop', { title: 'T', labels: ['factory', 'backend'] });
    const tracker = new GitLabIssuesTracker({ token, baseUrl: gl.baseUrl, fetch: gl.fetch });
    const item = { id: `acme/shop#${iid}`, url: '' };
    await tracker.setStatus(item, 'specifying');
    await tracker.setStatus(item, 'in_progress');
    expect((await tracker.getItem(item)).labels.sort()).toEqual(['backend', 'factory', 'factory:in_progress']);
  });

  it('does not let a reporter or an unknown user decide gates', async () => {
    gl = new FakeGitLab();
    gl.addProject('acme/shop');
    gl.addUser('reporter', 20, 'acme/shop');
    gl.addUser('dev', 30, 'acme/shop');
    const tracker = new GitLabIssuesTracker({ token, baseUrl: gl.baseUrl, fetch: gl.fetch });
    const item = { id: 'acme/shop#1', url: '' };
    expect(await tracker.canApprove(item, 'dev')).toBe(true);
    expect(await tracker.canApprove(item, 'reporter')).toBe(false);
    expect(await tracker.canApprove(item, 'nobody')).toBe(false);
    expect(await tracker.canApprove(item, 'bad name;')).toBe(false);
  });
});

describe('source control', () => {
  it('opens drafts as "Draft:" and reports approvals as reviews', async () => {
    gl = new FakeGitLab();
    gl.addProject('acme/shop');
    gl.pushCommit('acme/shop', 'feature', 'f.txt', 'f\n');
    const scm = new GitLabSourceControl({ token, baseUrl: gl.baseUrl, gitBase: gl.gitBase, fetch: gl.fetch });
    const pr = await scm.openPR({ repo: { id: 'acme/shop', url: '' }, head: 'feature', base: 'main', title: 'Add f', body: '', draft: true });
    expect(pr.id).toBe('acme/shop!1');
    const status = await scm.getPRStatus(pr);
    expect(status).toMatchObject({ state: 'open', mergeable: true, checks: 'none', reviews: [] });
  });

  it('maps GitLab failures to adapter errors', async () => {
    gl = new FakeGitLab();
    gl.addProject('acme/shop');
    const scm = new GitLabSourceControl({ token, baseUrl: gl.baseUrl, gitBase: gl.gitBase, fetch: gl.fetch });
    await expectAdapterError(scm.getPRStatus({ id: 'nope/missing!1', url: '' }), 'not_found');
    await expectAdapterError(scm.getPRStatus({ id: 'acme/shop#1', url: '' }), 'invalid_input');
    const noToken = new GitLabSourceControl({ token: tokenFromEnv({}), baseUrl: gl.baseUrl, fetch: gl.fetch });
    await expectAdapterError(noToken.getPRStatus({ id: 'acme/shop!1', url: '' }), 'unauthorized');
    const work = mkdtempSync(join(tmpdir(), 'gl-'));
    try {
      await expectAdapterError(scm.clone({ id: 'acme/none', url: '' }, join(work, 'c')), 'not_found');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('reads merge, check and pipeline states', () => {
    expect(mergeable({ detailed_merge_status: 'mergeable' })).toBe(true);
    expect(mergeable({ detailed_merge_status: 'checking' })).toBe('unknown');
    expect(mergeable({ detailed_merge_status: 'broken_status' })).toBe(false);
    expect(mergeable({ merge_status: 'can_be_merged' })).toBe(true);
    expect([checksOf(undefined), checksOf('running'), checksOf('success'), checksOf('failed')]).toEqual(['none', 'pending', 'passing', 'failing']);
    expect(['success', 'failed', 'manual', 'canceled', 'weird'].map(stateOf)).toEqual(['passed', 'failed', 'queued', 'cancelled', 'error']);
  });
});

// The shared contract suites against the GitLab adapters, talking to an in-process stand-in
// for the GitLab API (fake-gitlab.ts) with real git repositories behind it. A run against a
// real instance waits for a GitLab account (M6-7).

import { describeCIContract, describeSourceControlContract, describeTrackerContract } from '@cradleworks/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitLab } from './fake-gitlab.ts';
import { GitLabCI, GitLabIssuesTracker, GitLabSourceControl, gitlabRepoRef } from './index.ts';

const token = async () => 'glpat-test';

describeSourceControlContract('GitLab (stand-in)', async () => {
  const gl = new FakeGitLab();
  gl.addProject('acme/platform/shop');
  const workDir = mkdtempSync(join(tmpdir(), 'gitlab-contract-'));
  return {
    adapter: new GitLabSourceControl({ token, baseUrl: gl.baseUrl, gitBase: gl.gitBase, fetch: gl.fetch }),
    repo: gitlabRepoRef('acme/platform/shop', gl.baseUrl),
    workDir,
    missingPR: { id: 'acme/platform/shop!9999', url: `${gl.baseUrl}/acme/platform/shop/-/merge_requests/9999` },
    cleanup: async () => {
      rmSync(workDir, { recursive: true, force: true });
      gl.cleanup();
    },
  };
});

describeTrackerContract('GitLab issues (stand-in)', async () => {
  const gl = new FakeGitLab();
  gl.addProject('acme/shop');
  gl.addUser('maintainer', 40, 'acme/shop');
  gl.addUser('guest', 10, 'acme/shop');
  const iid = gl.addIssue('acme/shop', { title: 'Add a health endpoint', description: 'GET /health returns 200', labels: ['factory'] });
  return {
    adapter: new GitLabIssuesTracker({ token, baseUrl: gl.baseUrl, fetch: gl.fetch, pollSeconds: 0.05 }),
    project: 'acme/shop',
    item: { id: `acme/shop#${iid}`, url: `${gl.baseUrl}/acme/shop/-/issues/${iid}` },
    label: 'factory',
    approver: 'maintainer',
    stranger: 'guest',
    missing: { id: 'acme/shop#9999', url: '' },
    watchSeconds: 5,
    cleanup: async () => gl.cleanup(),
  };
});

describeCIContract('GitLab CI (stand-in)', async () => {
  const gl = new FakeGitLab();
  gl.addProject('acme/shop');
  const passingSha = gl.pushCommit('acme/shop', 'ok', 'a.txt', 'a\n');
  const failingSha = gl.pushCommit('acme/shop', 'broken', 'b.txt', 'b\n');
  const unbuiltSha = gl.pushCommit('acme/shop', 'quiet', 'c.txt', 'c\n');
  gl.addPipeline('acme/shop', { sha: passingSha, status: 'success', jobs: [{ name: 'build', status: 'success', log: 'ok\n', artifact: { filename: 'artifacts.zip', content: 'report' } }, { name: 'test', status: 'success' }] });
  gl.addPipeline('acme/shop', {
    sha: failingSha,
    status: 'failed',
    jobs: [
      { name: 'build', status: 'success' },
      { name: 'test', status: 'failed', log: `\x1b[0Ksection_start:1:step_script\r\x1b[0K${'line\n'.repeat(300)}\x1b[31mFAILED: CW-MARKER-42\x1b[0m\n` },
    ],
  });
  return {
    adapter: new GitLabCI({ token, baseUrl: gl.baseUrl, fetch: gl.fetch }),
    repo: gitlabRepoRef('acme/shop', gl.baseUrl),
    passingSha,
    failingSha,
    failingJob: 'test',
    failureMarker: 'FAILED: CW-MARKER-42',
    unbuiltSha,
    waitSeconds: 5,
    artifact: { name: 'build', containsText: 'report' },
    cleanup: async () => gl.cleanup(),
  };
});

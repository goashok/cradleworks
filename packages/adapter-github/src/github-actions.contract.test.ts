// The CI contract against real GitHub Actions. Opt in with CRADLEWORKS_GITHUB_CI_CONTRACT=1.
// It uses the private scratch repo of the SourceControl contract (created if missing): two
// throwaway branches get a small workflow, one commit that passes and one that fails.
// Runs take a minute or two and use a few Actions minutes.

import { describeCIContract } from '@cradleworks/contracts';
import { describe, expect, it } from 'vitest';
import { defaultTokenProvider, GitHubActionsCI, githubRepoRef } from './index.ts';
import { toState } from './github-actions-ci.ts';

const SCRATCH = process.env.CRADLEWORKS_GITHUB_SCRATCH_REPO ?? 'cradleworks-contract-scratch';
const MARKER = 'CRADLEWORKS_CI_CONTRACT_FAILURE';

const WORKFLOW = `name: cw-contract
on:
  push:
    branches: ['cw-ci-*']
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          if [ -f FAIL ]; then echo "${MARKER}"; exit 1; fi
          echo ok > report.txt
      - if: \${{ hashFiles('report.txt') != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: report
          path: report.txt
`;

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cradleworks' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : undefined) as T };
}

async function ensureScratchRepo(token: string): Promise<string> {
  const { data: user } = await api<{ login: string }>(token, 'GET', '/user');
  if ((await api(token, 'GET', `/repos/${user.login}/${SCRATCH}`)).status === 404) {
    await api(token, 'POST', '/user/repos', { name: SCRATCH, private: true, auto_init: true, description: 'Scratch repo for Cradleworks contract tests. Safe to delete.' });
    for (let i = 0; i < 20 && (await api(token, 'GET', `/repos/${user.login}/${SCRATCH}/branches/main`)).status !== 200; i++) await new Promise((r) => setTimeout(r, 1000));
  }
  return user.login;
}

async function branchWithFile(token: string, base: string, fromSha: string, branch: string, path: string, content: string): Promise<string> {
  const ref = await api(token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
  if (ref.status !== 201) throw new Error(`cannot create ${branch}: ${ref.status}`);
  const put = await api<{ commit: { sha: string } }>(token, 'PUT', `${base}/contents/${path}`, { message: `add ${path}`, branch, content: Buffer.from(content).toString('base64') });
  if (put.status !== 201) throw new Error(`cannot write ${path} on ${branch}: ${put.status}`);
  return put.data.commit.sha;
}

if (process.env.CRADLEWORKS_GITHUB_CI_CONTRACT === '1') {
  describeCIContract(
    `GitHub Actions (${SCRATCH})`,
    async () => {
      const token = await defaultTokenProvider();
      const owner = await ensureScratchRepo(token);
      const base = `/repos/${owner}/${SCRATCH}`;
      const { data: main } = await api<{ commit: { sha: string } }>(token, 'GET', `${base}/branches/main`);
      const id = Date.now().toString(36);
      const passing = `cw-ci-${id}-pass`;
      const failing = `cw-ci-${id}-fail`;
      const passingSha = await branchWithFile(token, base, main.commit.sha, passing, '.github/workflows/cw-contract.yml', WORKFLOW);
      const failingSha = await branchWithFile(token, base, passingSha, failing, 'FAIL', 'fail\n');
      return {
        adapter: new GitHubActionsCI({ token: async () => token }),
        repo: githubRepoRef(owner, SCRATCH),
        passingSha,
        failingSha,
        failingJob: 'check',
        failureMarker: MARKER,
        unbuiltSha: main.commit.sha,
        waitSeconds: 600,
        artifact: { name: 'report', containsText: 'ok' },
        cleanup: async () => {
          for (const b of [passing, failing]) await api(token, 'DELETE', `${base}/git/refs/heads/${b}`);
        },
      };
    },
    { timeoutMs: 180_000 },
  );
}

describe('GitHub Actions state mapping', () => {
  it('maps statuses and conclusions onto CI states', () => {
    expect(toState('queued', null)).toBe('queued');
    expect(toState('in_progress', null)).toBe('running');
    expect(toState('completed', 'success')).toBe('passed');
    expect(toState('completed', 'skipped')).toBe('passed');
    expect(toState('completed', 'failure')).toBe('failed');
    expect(toState('completed', 'timed_out')).toBe('failed');
    expect(toState('completed', 'cancelled')).toBe('cancelled');
    expect(toState('completed', 'action_required')).toBe('error');
  });
});

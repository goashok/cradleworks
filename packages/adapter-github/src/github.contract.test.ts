// The SourceControl contract against real GitHub. Opt in with CRADLEWORKS_GITHUB_CONTRACT=1;
// it uses a private scratch repo on the signed-in account, created on first run and reused.

import { describeSourceControlContract } from '@cradleworks/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { defaultTokenProvider, GitHubSourceControl, githubRepoRef } from './index.ts';

const SCRATCH = process.env.CRADLEWORKS_GITHUB_SCRATCH_REPO ?? 'cradleworks-contract-scratch';
const BRANCH_PREFIXES = ['cw-test-', 'cw-dup-'];

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
  const existing = await api(token, 'GET', `/repos/${user.login}/${SCRATCH}`);
  if (existing.status === 404) {
    const created = await api(token, 'POST', '/user/repos', {
      name: SCRATCH,
      private: true,
      auto_init: true,
      description: 'Scratch repo for Cradleworks contract tests. Safe to delete.',
    });
    if (created.status !== 201) throw new Error(`cannot create scratch repo: ${created.status} ${JSON.stringify(created.data)}`);
    for (let i = 0; i < 20; i++) {
      if ((await api(token, 'GET', `/repos/${user.login}/${SCRATCH}/branches/main`)).status === 200) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return user.login;
}

/** Closes the suite's open pull requests and deletes its branches. */
async function tidy(token: string, owner: string): Promise<void> {
  const { data: pulls } = await api<Array<{ number: number; head: { ref: string } }>>(token, 'GET', `/repos/${owner}/${SCRATCH}/pulls?state=open&per_page=100`);
  for (const p of pulls) {
    if (BRANCH_PREFIXES.some((prefix) => p.head.ref.startsWith(prefix))) {
      await api(token, 'PATCH', `/repos/${owner}/${SCRATCH}/pulls/${p.number}`, { state: 'closed' });
    }
  }
  const { data: refs } = await api<Array<{ ref: string }>>(token, 'GET', `/repos/${owner}/${SCRATCH}/git/matching-refs/heads/cw-`);
  for (const r of refs ?? []) {
    const branch = r.ref.replace('refs/heads/', '');
    if (BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
      await api(token, 'DELETE', `/repos/${owner}/${SCRATCH}/git/refs/heads/${branch}`);
    }
  }
}

if (process.env.CRADLEWORKS_GITHUB_CONTRACT === '1') {
  describeSourceControlContract(
    `GitHub (${SCRATCH})`,
    async () => {
      const token = await defaultTokenProvider();
      const owner = await ensureScratchRepo(token);
      const workDir = mkdtempSync(join(tmpdir(), 'cw-gh-contract-'));
      return {
        adapter: new GitHubSourceControl({ token: async () => token }),
        repo: githubRepoRef(owner, SCRATCH),
        workDir,
        missingPR: { id: `${owner}/${SCRATCH}#999999`, url: '' },
        cleanup: async () => {
          await tidy(token, owner);
          rmSync(workDir, { recursive: true, force: true });
        },
      };
    },
    { timeoutMs: 90_000 },
  );
} else {
  describe.skip('SourceControl contract: GitHub', () => {
    it('runs with CRADLEWORKS_GITHUB_CONTRACT=1 and a GitHub sign-in', () => {});
  });
}

// The Tracker contract against real GitHub Issues. Opt in with CRADLEWORKS_GITHUB_CONTRACT=1.
// It opens an issue in the private scratch repo of the SourceControl contract and closes it after.

import { describeTrackerContract } from '@cradleworks/contracts';
import { describe, it } from 'vitest';
import { defaultTokenProvider } from './index.ts';
import { GitHubIssuesTracker } from './github-issues-tracker.ts';

const SCRATCH = process.env.CRADLEWORKS_GITHUB_SCRATCH_REPO ?? 'cradleworks-contract-scratch';

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cradleworks' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : undefined) as T };
}

if (process.env.CRADLEWORKS_GITHUB_CONTRACT === '1') {
  describeTrackerContract(
    `GitHub Issues (${SCRATCH})`,
    async () => {
      const token = await defaultTokenProvider();
      const { data: user } = await api<{ login: string }>(token, 'GET', '/user');
      const label = `cw-contract-${Date.now().toString(36)}`;
      const created = await api<{ number: number; html_url: string }>(token, 'POST', `/repos/${user.login}/${SCRATCH}/issues`, {
        title: 'Tracker contract test',
        body: 'Opened by the Cradleworks tracker contract. Safe to close.',
        labels: [label],
      });
      if (created.status !== 201) throw new Error(`cannot open an issue: ${created.status}`);
      const item = { id: `${user.login}/${SCRATCH}#${created.data.number}`, url: created.data.html_url };
      return {
        adapter: new GitHubIssuesTracker({ token: async () => token, pollSeconds: 2 }),
        project: `${user.login}/${SCRATCH}`,
        item,
        label,
        approver: user.login,
        stranger: 'octocat',
        missing: { id: `${user.login}/${SCRATCH}#999999`, url: '' },
        watchSeconds: 20,
        cleanup: async () => {
          await api(token, 'PATCH', `/repos/${user.login}/${SCRATCH}/issues/${created.data.number}`, { state: 'closed' });
          await api(token, 'DELETE', `/repos/${user.login}/${SCRATCH}/labels/${label}`);
          for (const s of ['specifying', 'in_progress']) await api(token, 'DELETE', `/repos/${user.login}/${SCRATCH}/labels/factory:${s}`);
        },
      };
    },
    { timeoutMs: 60_000 },
  );
} else {
  describe.skip('Tracker contract: GitHub Issues', () => {
    it('runs with CRADLEWORKS_GITHUB_CONTRACT=1 and a GitHub sign-in', () => {});
  });
}

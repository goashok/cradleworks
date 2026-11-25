import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRequestRef, RepoRef, SourceControl } from '@cradleworks/interfaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectAdapterError } from './assert.ts';

export interface SourceControlFixture {
  adapter: SourceControl;
  /** A repository the suite may write to; `main` holds a committed README.md. */
  repo: RepoRef;
  /** An empty directory the suite may clone into. */
  workDir: string;
  /** A well-formed reference to a pull request that does not exist. */
  missingPR: PullRequestRef;
  cleanup(): Promise<void>;
}

export interface ContractOptions {
  /** Per-test timeout; real services need more than the default. */
  timeoutMs?: number;
}

export function describeSourceControlContract(
  name: string,
  setup: () => Promise<SourceControlFixture>,
  options: ContractOptions = {},
): void {
  describe(`SourceControl contract: ${name}`, { timeout: options.timeoutMs ?? 30_000 }, () => {
    let f: SourceControlFixture;
    let n = 0;
    const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++n}`;
    const cloneDir = () => {
      const dir = join(f.workDir, unique('clone'));
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    beforeAll(async () => {
      f = await setup();
    }, options.timeoutMs ?? 30_000);
    afterAll(async () => f?.cleanup());

    /** Clones, branches, writes one file, commits and pushes. */
    async function pushedBranch(file = 'change.txt', content = 'hello\n') {
      const copy = await f.adapter.clone(f.repo, cloneDir());
      const branch = unique('cw-test');
      await f.adapter.createBranch(copy, branch);
      writeFileSync(join(copy.path, file), content);
      const commit = await f.adapter.commit(copy, `Add ${file}`);
      await f.adapter.push(copy, branch);
      return { copy, branch, commit };
    }

    async function openedPR(file?: string) {
      const pushed = await pushedBranch(file);
      const pr = await f.adapter.openPR({ repo: f.repo, head: pushed.branch, base: 'main', title: `Test ${pushed.branch}`, body: 'Contract test' });
      return { ...pushed, pr };
    }

    it('clones the default branch', async () => {
      const copy = await f.adapter.clone(f.repo, cloneDir());
      expect(copy.repo.id).toBe(f.repo.id);
      expect(existsSync(join(copy.path, 'README.md'))).toBe(true);
    });

    it('refuses to clone into a non-empty directory', async () => {
      const dir = cloneDir();
      writeFileSync(join(dir, 'occupied'), 'x');
      await expectAdapterError(f.adapter.clone(f.repo, dir), 'invalid_input');
    });

    it('replaces a pushed branch only when asked', async () => {
      const first = await pushedBranch('first.txt');
      const copy = await f.adapter.clone(f.repo, cloneDir());
      await f.adapter.createBranch(copy, first.branch);
      writeFileSync(join(copy.path, 'second.txt'), 'second\n');
      await f.adapter.commit(copy, 'Add second.txt');
      await expect(f.adapter.push(copy, first.branch)).rejects.toThrow();
      await f.adapter.push(copy, first.branch, { replace: true });
      const check = await f.adapter.clone(f.repo, cloneDir(), { ref: first.branch });
      expect(existsSync(join(check.path, 'second.txt'))).toBe(true);
      expect(existsSync(join(check.path, 'first.txt'))).toBe(false);
    });

    it('refuses to create a branch that exists', async () => {
      const copy = await f.adapter.clone(f.repo, cloneDir());
      const branch = unique('cw-dup');
      await f.adapter.createBranch(copy, branch);
      await expectAdapterError(f.adapter.createBranch(copy, branch), 'conflict');
    });

    it('refuses an empty commit', async () => {
      const copy = await f.adapter.clone(f.repo, cloneDir());
      await expectAdapterError(f.adapter.commit(copy, 'nothing'), 'invalid_input');
    });

    it('commits, pushes and opens a pull request that reports its head', async () => {
      const { commit, branch, pr } = await openedPR();
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(pr.id).not.toBe('');
      expect(pr.url).not.toBe('');
      const status = await f.adapter.getPRStatus(pr);
      expect(status).toMatchObject({ state: 'open', headSha: commit.sha, baseBranch: 'main' });
      expect([true, false, 'unknown']).toContain(status.mergeable);
      expect(['none', 'pending', 'passing', 'failing']).toContain(status.checks);
      expect(Array.isArray(status.reviews)).toBe(true);
      expect(branch).not.toBe('main');
    });

    it('refuses a second open pull request for the same branch', async () => {
      const { branch } = await openedPR();
      await expectAdapterError(f.adapter.openPR({ repo: f.repo, head: branch, base: 'main', title: 'again', body: '' }), 'conflict');
    });

    it('refuses a pull request from a branch that does not exist', async () => {
      await expectAdapterError(
        f.adapter.openPR({ repo: f.repo, head: unique('cw-missing'), base: 'main', title: 'x', body: '' }),
        'invalid_input',
      );
    });

    it('comments on a pull request', async () => {
      const { pr } = await openedPR();
      const comment = await f.adapter.comment(pr, 'Evidence bundle goes here');
      expect(comment.id).not.toBe('');
    });

    it('merges only at the expected head, then reports merged', async () => {
      const file = `${unique('merged')}.txt`;
      const { pr, commit } = await openedPR(file);
      await expectAdapterError(f.adapter.merge(pr, { method: 'squash', expectedHeadSha: '0'.repeat(40) }), 'conflict');

      const merged = await f.adapter.merge(pr, { method: 'squash', expectedHeadSha: commit.sha });
      expect(merged.sha).toMatch(/^[0-9a-f]{40}$/);
      expect((await f.adapter.getPRStatus(pr)).state).toBe('merged');
      await expectAdapterError(f.adapter.merge(pr, { method: 'squash', expectedHeadSha: commit.sha }), 'conflict');

      const fresh = await f.adapter.clone(f.repo, cloneDir());
      expect(readFileSync(join(fresh.path, file), 'utf8')).toBe('hello\n');
    });

    it('refuses with merge_conflict a change that conflicts with what merged into the base', async () => {
      const file = `${unique('both')}.txt`;
      const first = await pushedBranch(file, 'first\n');
      const second = await pushedBranch(file, 'second\n');
      const pr1 = await f.adapter.openPR({ repo: f.repo, head: first.branch, base: 'main', title: `Test ${first.branch}`, body: 'Contract test' });
      const pr2 = await f.adapter.openPR({ repo: f.repo, head: second.branch, base: 'main', title: `Test ${second.branch}`, body: 'Contract test' });
      await f.adapter.merge(pr1, { method: 'squash', expectedHeadSha: first.commit.sha });
      await expectAdapterError(f.adapter.merge(pr2, { method: 'squash', expectedHeadSha: second.commit.sha }), 'merge_conflict');
      expect((await f.adapter.getPRStatus(pr2)).state).toBe('open');
    });

    it('reports an unknown pull request as not found', async () => {
      await expectAdapterError(f.adapter.getPRStatus(f.missingPR), 'not_found');
    });
  });
}

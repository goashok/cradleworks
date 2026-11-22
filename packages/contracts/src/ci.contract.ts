import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CI, CIRunStatus, RepoRef } from '@cradleworks/interfaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectAdapterError } from './assert.ts';
import type { ContractOptions } from './source-control.contract.ts';

/**
 * A CI system with two commits already pushed: one whose pipeline passes and one whose
 * pipeline fails in a job named `failingJob`, printing `failureMarker` in its log.
 */
export interface CIFixture {
  adapter: CI;
  repo: RepoRef;
  passingSha: string;
  failingSha: string;
  failingJob: string;
  failureMarker: string;
  /** A commit no pipeline ran for. */
  unbuiltSha: string;
  /** How long to wait for a run to finish. */
  waitSeconds: number;
  /** An artifact the passing run uploads, if the system supports artifacts. */
  artifact?: { name: string; containsText: string };
  cleanup(): Promise<void>;
}

const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'error']);

async function settle(ci: CI, repo: RepoRef, sha: string, waitSeconds: number): Promise<CIRunStatus> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const [run] = await ci.findRuns(repo, sha);
    if (run) {
      const status = await ci.getRunStatus(run);
      if (TERMINAL.has(status.state)) return status;
    }
    if (Date.now() > deadline) throw new Error(`no finished run for ${sha} after ${waitSeconds}s`);
    await new Promise((r) => setTimeout(r, Math.min(10_000, waitSeconds * 50)));
  }
}

export function describeCIContract(name: string, setup: () => Promise<CIFixture>, options: ContractOptions = {}): void {
  describe(`CI contract: ${name}`, { timeout: options.timeoutMs ?? 30_000 }, () => {
    let f: CIFixture;
    let passed: CIRunStatus;
    let failed: CIRunStatus;
    beforeAll(async () => {
      f = await setup();
      [passed, failed] = await Promise.all([settle(f.adapter, f.repo, f.passingSha, f.waitSeconds), settle(f.adapter, f.repo, f.failingSha, f.waitSeconds)]);
    }, (options.timeoutMs ?? 30_000) * 4);
    afterAll(async () => f?.cleanup());

    it('finds runs for a commit and reports a passing one', () => {
      expect(passed.state).toBe('passed');
      expect(passed.sha).toBe(f.passingSha);
      expect(passed.jobs.length).toBeGreaterThan(0);
      expect(passed.jobs.every((j) => j.state === 'passed' || j.state === 'cancelled')).toBe(true);
      expect(passed.ref.url).toMatch(/^\w+:/);
    });

    it('reports a failing run and the job that failed', () => {
      expect(failed.state).toBe('failed');
      expect(failed.jobs.find((j) => j.name === f.failingJob)?.state).toBe('failed');
    });

    it("returns a failed job's log", async () => {
      const log = await f.adapter.getLogs(failed.ref, { job: f.failingJob, tailLines: 200 });
      expect(log).toContain(f.failureMarker);
      expect(log.split('\n').length).toBeLessThanOrEqual(200);
    });

    it('finds no runs for a commit nothing built', async () => {
      expect(await f.adapter.findRuns(f.repo, f.unbuiltSha)).toEqual([]);
    });

    it('refuses an unknown run as not_found', async () => {
      await expectAdapterError(f.adapter.getRunStatus({ id: `${passed.ref.id}999999`, url: passed.ref.url }), 'not_found');
    });

    it('lists and downloads artifacts', async (ctx) => {
      if (!f.artifact) return ctx.skip();
      const listed = await f.adapter.getArtifacts(passed.ref);
      expect(listed.map((a) => a.name)).toContain(f.artifact.name);
      const dir = mkdtempSync(join(tmpdir(), 'cw-ci-artifact-'));
      try {
        const path = await f.adapter.downloadArtifact(passed.ref, f.artifact.name, dir);
        expect(readFileSync(path).length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

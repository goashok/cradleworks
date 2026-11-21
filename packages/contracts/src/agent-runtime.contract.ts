import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, AgentProfile, AgentRunRequest, AgentRuntime, SandboxHandle } from '@cradleworks/interfaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectAdapterError } from './assert.ts';
import type { ContractOptions } from './source-control.contract.ts';

export interface AgentRuntimeFixture {
  runtime: AgentRuntime;
  profile: AgentProfile;
  /** A fresh sandbox per call; the fixture cleans them up. */
  newSandbox(): Promise<SandboxHandle>;
  tasks: {
    /** An input that makes the agent write `content` to `path` and finish. */
    writeFile: { input: string; path: string; content: string };
    /** An input that keeps the agent busy for well over 10 seconds. */
    slow: { input: string };
  };
  cleanup(): Promise<void>;
}

export function describeAgentRuntimeContract(name: string, setup: () => Promise<AgentRuntimeFixture>, options: ContractOptions = {}): void {
  describe(`AgentRuntime contract: ${name}`, { timeout: options.timeoutMs ?? 60_000 }, () => {
    let f: AgentRuntimeFixture;
    let n = 0;

    beforeAll(async () => {
      f = await setup();
    }, options.timeoutMs ?? 60_000);
    afterAll(async () => f?.cleanup());

    const request = async (input: string, overrides: Partial<AgentRunRequest> = {}): Promise<AgentRunRequest> => ({
      runId: `run-${Date.now().toString(36)}-${++n}`,
      profile: f.profile,
      sandbox: await f.newSandbox(),
      rolePrompt: 'You are the implementer. Do exactly what the task says and nothing else.',
      input,
      contextFiles: [],
      tools: { allow: [], deny: [] },
      limits: { maxWallSeconds: 300 },
      ...overrides,
    });

    async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
      const out: AgentEvent[] = [];
      for await (const event of events) out.push(event);
      return out;
    }

    it('emits a well-formed event stream ending in one done event', async () => {
      const req = await request(f.tasks.writeFile.input);
      const run = await f.runtime.start(req);
      expect(run.runId).toBe(req.runId);
      const events = await collect(run.events);

      expect(events.length).toBeGreaterThan(0);
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('done');
      events.forEach((e, i) => {
        expect(e.runId).toBe(req.runId);
        expect(e.seq).toBe(i + 1);
        expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      });
      const done = events.at(-1);
      expect(done?.type === 'done' && done.outcome).toBe('succeeded');
    });

    it('does the work in the sandbox and reports the file change', async () => {
      const { input, path, content } = f.tasks.writeFile;
      const req = await request(input);
      const events = await collect((await f.runtime.start(req)).events);
      expect(readFileSync(join(req.sandbox.workspacePath, path), 'utf8').trim()).toBe(content.trim());
      expect(events.some((e) => e.type === 'file_change' && e.path === path)).toBe(true);
    });

    it('reports usage as a non-decreasing running total that matches getUsage', async () => {
      const run = await f.runtime.start(await request(f.tasks.writeFile.input));
      const events = await collect(run.events);
      const totals = events.flatMap((e) => (e.type === 'usage' || e.type === 'done' ? [e.total] : []));
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i]!.costUsd).toBeGreaterThanOrEqual(totals[i - 1]!.costUsd);
        expect(totals[i]!.inputTokens + totals[i]!.outputTokens).toBeGreaterThanOrEqual(totals[i - 1]!.inputTokens + totals[i - 1]!.outputTokens);
      }
      const done = events.at(-1);
      expect(done?.type).toBe('done');
      if (done?.type === 'done') expect(await run.getUsage()).toEqual(done.total);
    });

    it('stops on request', async () => {
      const run = await f.runtime.start(await request(f.tasks.slow.input));
      setTimeout(() => void run.stop('contract test'), 500);
      const done = (await collect(run.events)).at(-1);
      expect(done?.type === 'done' && done.outcome).toBe('stopped');
    });

    it('stops at the wall-clock limit', async () => {
      const run = await f.runtime.start(await request(f.tasks.slow.input, { limits: { maxWallSeconds: 2 } }));
      const done = (await collect(run.events)).at(-1);
      expect(done?.type === 'done' && done.outcome).toBe('timed_out');
    });

    it('refuses to start the same run twice', async () => {
      const req = await request(f.tasks.writeFile.input);
      const first = await f.runtime.start(req);
      await expectAdapterError(f.runtime.start(req), 'conflict');
      await collect(first.events);
    });
  });
}

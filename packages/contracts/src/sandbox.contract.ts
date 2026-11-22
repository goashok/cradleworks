import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox, SandboxHandle, SandboxSpec, WorkingCopy } from '@cradleworks/interfaces';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectAdapterError } from './assert.ts';
import type { ContractOptions } from './source-control.contract.ts';

export interface SandboxFixture {
  adapter: Sandbox;
  /** A local git checkout; `baseRef` holds a committed README.md. */
  source: WorkingCopy;
  baseRef: string;
  /** An image with a POSIX shell, `cat` and `sleep`. */
  image: string;
  cleanup(): Promise<void>;
}

export function describeSandboxContract(name: string, setup: () => Promise<SandboxFixture>, options: ContractOptions = {}): void {
  describe(`Sandbox contract: ${name}`, { timeout: options.timeoutMs ?? 30_000 }, () => {
    let f: SandboxFixture;
    const open: SandboxHandle[] = [];
    let n = 0;

    beforeAll(async () => {
      f = await setup();
    }, options.timeoutMs ?? 30_000);
    afterEach(async () => {
      for (const s of open.splice(0)) await f.adapter.destroy(s);
    });
    afterAll(async () => f?.cleanup());

    const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => {
      const taskId = `task-${Date.now().toString(36)}-${++n}`;
      return {
        taskId,
        source: f.source,
        baseRef: f.baseRef,
        branch: `factory/${taskId}`,
        image: f.image,
        network: { mode: 'none', allow: [] },
        ...overrides,
      };
    };
    const create = async (overrides?: Partial<SandboxSpec>) => {
      const s = await f.adapter.create(spec(overrides));
      open.push(s);
      return s;
    };
    const sh = (s: SandboxHandle, script: string, opts = {}) => f.adapter.exec(s, ['sh', '-c', script], opts);

    it('creates a checkout of the base ref on the task branch', async () => {
      const s = await create();
      expect(s.workspacePath).not.toBe('');
      expect(existsSync(join(s.workspacePath, 'README.md'))).toBe(true);
      const branch = execFileSync('git', ['-C', s.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      expect(branch).toBe(s.branch);
    });

    it('refuses a second sandbox for the same task', async () => {
      const first = spec();
      open.push(await f.adapter.create(first));
      await expectAdapterError(f.adapter.create({ ...first, branch: `${first.branch}-2` }), 'conflict');
    });

    it('runs argv commands and returns exit code and output without throwing', async () => {
      const s = await create();
      const result = await sh(s, 'echo out; echo err >&2; exit 3');
      expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('applies cwd, spec env, call env and stdin', async () => {
      const s = await create({ env: { FROM_SPEC: 'spec' } });
      expect((await sh(s, 'mkdir -p sub')).exitCode).toBe(0);
      const result = await sh(s, 'pwd; echo "$FROM_SPEC $FROM_CALL"', { cwd: 'sub', env: { FROM_CALL: 'call' } });
      const [pwd, vars] = result.stdout.trim().split('\n');
      expect(pwd).toMatch(/\/sub$/);
      expect(vars).toBe('spec call');
      expect((await f.adapter.exec(s, ['cat'], { stdin: 'piped' })).stdout).toBe('piped');
    });

    it('stops a command at its timeout', async () => {
      const s = await create();
      const result = await sh(s, 'sleep 10', { timeoutSeconds: 1 });
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(8000);
    });

    it('streams output from a spawned command as it arrives', async () => {
      const s = await create({ env: { FROM_SPEC: 'spec' } });
      const started = Date.now();
      const proc = await f.adapter.spawn(s, ['sh', '-c', 'echo "first $FROM_SPEC"; read line; echo "got $line"; sleep 2; echo last; echo oops >&2; exit 4'], { stdin: 'piped\n' });
      const seen: Array<{ line: string; ms: number }> = [];
      for await (const line of proc.lines) seen.push({ line, ms: Date.now() - started });
      expect(seen.map((l) => l.line)).toEqual(['first spec', 'got piped', 'last']);
      expect(seen[0]!.ms).toBeLessThan(seen[2]!.ms - 1000); // the first line came well before the end
      expect(await proc.result).toMatchObject({ exitCode: 4, stdout: '', stderr: 'oops\n', timedOut: false });
    });

    it('kills a spawned command and what it started, and applies its timeout', async () => {
      const s = await create();
      const proc = await f.adapter.spawn(s, ['sh', '-c', 'sh -c "sleep 30; echo child-survived" & echo started; sleep 30']);
      const it = proc.lines[Symbol.asyncIterator]();
      expect((await it.next()).value).toBe('started');
      await proc.kill();
      const rest: string[] = [];
      for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
      const killed = await proc.result;
      expect(killed.exitCode).not.toBe(0);
      expect(rest).toEqual([]);
      await proc.kill(); // safe after it ended

      const timed = await f.adapter.spawn(s, ['sleep', '30'], { timeoutSeconds: 1 });
      for await (const _ of timed.lines) void _;
      expect(await timed.result).toMatchObject({ timedOut: true });
    });

    it('shares the checkout with the host', async () => {
      const s = await create();
      await sh(s, 'echo made > made.txt');
      expect(readFileSync(join(s.workspacePath, 'made.txt'), 'utf8')).toBe('made\n');
      writeFileSync(join(s.workspacePath, 'from-host.txt'), 'host');
      expect((await sh(s, 'cat from-host.txt')).stdout).toBe('host');
    });

    it('copies files in and out', async () => {
      const s = await create();
      const dir = mkdtempSync(join(tmpdir(), 'cw-copy-'));
      try {
        writeFileSync(join(dir, 'in.txt'), 'payload');
        await f.adapter.copyIn(s, join(dir, 'in.txt'), 'copied.txt');
        expect((await sh(s, 'cat copied.txt')).stdout).toBe('payload');
        await f.adapter.copyOut(s, 'copied.txt', join(dir, 'out.txt'));
        expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('payload');
        await expectAdapterError(f.adapter.copyIn(s, join(dir, 'in.txt'), '../escape.txt'), 'invalid_input');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps sandboxes apart', async () => {
      const a = await create();
      const b = await create();
      await sh(a, 'echo a > only-a.txt');
      expect((await sh(b, 'test -e only-a.txt')).exitCode).not.toBe(0);
    });

    it('applies a network policy change, or refuses one it cannot enforce', async () => {
      const s = await create();
      await f.adapter.setNetworkPolicy(s, { mode: 'none', allow: [] });
      // An adapter may lack a way to filter traffic; it must then refuse, never widen access silently.
      await f.adapter.setNetworkPolicy(s, { mode: 'allowlist', allow: ['registry.example.invalid'] }).catch((error: unknown) => {
        expect(error).toMatchObject({ name: 'AdapterError', code: 'invalid_input' });
      });
    });

    it('destroys cleanly, twice, and refuses use afterwards', async () => {
      const s = await f.adapter.create(spec());
      await f.adapter.destroy(s);
      await f.adapter.destroy(s);
      expect(existsSync(s.workspacePath)).toBe(false);
      await expectAdapterError(f.adapter.exec(s, ['true']), 'not_found');
    });
  });
}

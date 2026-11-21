// Sandbox that gives each task its own git worktree and runs commands as plain host
// processes. FOR TESTS ONLY: it isolates checkouts, not processes, and records the
// network policy without enforcing it.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  AdapterError,
  type ExecOptions,
  type ExecResult,
  type NetworkPolicy,
  type Sandbox,
  type SandboxHandle,
  type SandboxSpec,
} from '@cradleworks/interfaces';
import { git, GitError } from './git.ts';

const ADAPTER = 'process';
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

interface Entry {
  handle: SandboxHandle;
  sourcePath: string;
  env: Record<string, string>;
  network: NetworkPolicy;
}

export class ProcessSandbox implements Sandbox {
  readonly id = ADAPTER;
  readonly #root: string;
  readonly #entries = new Map<string, Entry>();

  /** `rootDir` holds one worktree per task. */
  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
    mkdirSync(this.#root, { recursive: true });
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (!/^[A-Za-z0-9._-]+$/.test(spec.taskId)) throw fail('invalid_input', 'create', `unsafe task id ${spec.taskId}`);
    const workspacePath = join(this.#root, spec.taskId);
    if (existsSync(workspacePath)) throw fail('conflict', 'create', `a sandbox for task ${spec.taskId} already exists`);
    try {
      await git(['worktree', 'add', '--quiet', '-b', spec.branch, workspacePath, spec.baseRef], spec.source.path);
    } catch (error) {
      const message = error instanceof GitError ? error.stderr.trim() : String(error);
      throw fail(/already exists/.test(message) ? 'conflict' : 'invalid_input', 'create', message, error);
    }
    const handle: SandboxHandle = {
      id: `${ADAPTER}-${spec.taskId}`,
      taskId: spec.taskId,
      branch: spec.branch,
      workspacePath,
      sandboxPath: workspacePath,
    };
    this.#entries.set(handle.id, { handle, sourcePath: spec.source.path, env: { ...(spec.env ?? {}) }, network: spec.network });
    return { ...handle };
  }

  async exec(sandbox: SandboxHandle, command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const entry = this.#entry(sandbox, 'exec');
    const [file, ...args] = command;
    if (file === undefined) throw fail('invalid_input', 'exec', 'command must not be empty');
    const cwd = this.#inside(entry, options.cwd ?? '.', 'exec');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: entry.handle.workspacePath, ...entry.env, ...(options.env ?? {}) };

    return new Promise<ExecResult>((resolvePromise, reject) => {
      const started = Date.now();
      const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let timedOut = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if ((outBytes += chunk.length) <= MAX_OUTPUT_BYTES) out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if ((errBytes += chunk.length) <= MAX_OUTPUT_BYTES) err.push(chunk);
      });
      const timer =
        options.timeoutSeconds !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, options.timeoutSeconds * 1000)
          : undefined;
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(fail('invalid_input', 'exec', `cannot run ${file}: ${error.message}`, error));
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        resolvePromise({
          exitCode: code ?? (signal ? 128 + 9 : 1),
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          durationMs: Date.now() - started,
          timedOut,
        });
      });
      child.stdin.end(options.stdin ?? '');
    });
  }

  async copyIn(sandbox: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void> {
    const entry = this.#entry(sandbox, 'copyIn');
    cpSync(hostPath, this.#inside(entry, sandboxPath, 'copyIn'), { recursive: true });
  }

  async copyOut(sandbox: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void> {
    const entry = this.#entry(sandbox, 'copyOut');
    cpSync(this.#inside(entry, sandboxPath, 'copyOut'), hostPath, { recursive: true });
  }

  async setNetworkPolicy(sandbox: SandboxHandle, policy: NetworkPolicy): Promise<void> {
    this.#entry(sandbox, 'setNetworkPolicy').network = policy;
  }

  async destroy(sandbox: SandboxHandle): Promise<void> {
    const entry = this.#entries.get(sandbox.id);
    if (!entry) return;
    this.#entries.delete(sandbox.id);
    try {
      await git(['worktree', 'remove', '--force', entry.handle.workspacePath], entry.sourcePath);
    } catch {
      rmSync(entry.handle.workspacePath, { recursive: true, force: true });
      await git(['worktree', 'prune'], entry.sourcePath).catch(() => undefined);
    }
  }

  /** Test helper: the policy last set for a sandbox. */
  networkPolicyOf(sandbox: SandboxHandle): NetworkPolicy | undefined {
    return this.#entries.get(sandbox.id)?.network;
  }

  #entry(sandbox: SandboxHandle, operation: string): Entry {
    const entry = this.#entries.get(sandbox.id);
    if (!entry) throw fail('not_found', operation, `no sandbox ${sandbox.id}`);
    return entry;
  }

  /** Resolves a path inside the sandbox, refusing anything that escapes it. */
  #inside(entry: Entry, path: string, operation: string): string {
    const root = entry.handle.workspacePath;
    const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw fail('invalid_input', operation, `${path} is outside the sandbox`);
    return full;
  }
}

function fail(code: AdapterError['code'], operation: string, message: string, cause?: unknown): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation, cause });
}

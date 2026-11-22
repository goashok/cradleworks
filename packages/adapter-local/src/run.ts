// Runs a host program (git or the docker CLI) and collects its output. Never throws on a
// non-zero exit: callers decide what a failure means.

import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  /** Called once when the timeout fires, before the client process is killed. */
  onTimeout?: () => Promise<void>;
}

export function runProgram(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    child.stdout.on('data', (c: Buffer) => {
      if ((outBytes += c.length) <= MAX_OUTPUT_BYTES) out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if ((errBytes += c.length) <= MAX_OUTPUT_BYTES) err.push(c);
    });
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            void (options.onTimeout?.() ?? Promise.resolve()).finally(() => child.kill('SIGKILL'));
          }, options.timeoutMs)
        : undefined;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 137 : 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
}

export interface StreamingProgram {
  lines: AsyncIterable<string>;
  result: Promise<RunResult>;
  kill(): Promise<void>;
}

/** Starts a program and yields its stdout line by line. stderr is collected into `result`. */
export function streamProgram(file: string, args: string[], options: RunOptions & { onKill?: () => Promise<void> } = {}): StreamingProgram {
  const started = Date.now();
  const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const err: Buffer[] = [];
  let errBytes = 0;
  let timedOut = false;
  let ended = false;
  child.stderr.on('data', (c: Buffer) => {
    if ((errBytes += c.length) <= MAX_OUTPUT_BYTES) err.push(c);
  });

  const kill = async () => {
    if (ended) return;
    await (options.onKill?.() ?? Promise.resolve()).catch(() => undefined);
    child.kill('SIGKILL');
  };
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          void kill();
        }, options.timeoutMs)
      : undefined;

  const result = new Promise<RunResult>((resolve, reject) => {
    child.on('error', (error) => {
      ended = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      ended = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 137 : 1), stdout: '', stderr: Buffer.concat(err).toString('utf8'), durationMs: Date.now() - started, timedOut });
    });
  });
  // Do not leave an unhandled rejection if the caller only reads `lines`.
  result.catch(() => undefined);

  child.stdin.on('error', () => undefined);
  child.stdin.end(options.stdin ?? '');

  async function* lines(): AsyncGenerator<string> {
    let pending = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending += chunk.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        yield pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
      }
    }
    if (pending !== '') yield pending;
  }
  return { lines: lines(), result, kill };
}

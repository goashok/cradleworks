// Thin wrapper over the git CLI for the local fakes and test fixtures.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const IDENTITY = ['-c', 'user.name=Cradleworks Test', '-c', 'user.email=test@cradleworks.invalid', '-c', 'init.defaultBranch=main'];

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly exitCode: number | undefined;
  readonly stderr: string;
  constructor(args: string[], exitCode: number | undefined, stderr: string) {
    super(`git ${args.join(' ')} failed (${exitCode ?? 'signal'}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export async function git(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', [...IDENTITY, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    throw new GitError(args, typeof e.code === 'number' ? e.code : undefined, e.stderr ?? String(error));
  }
}

/** Exit code of a git command that signals its answer by exit status (0 or 1). */
export async function gitStatus(args: string[], cwd?: string): Promise<number> {
  try {
    await git(args, cwd);
    return 0;
  } catch (error) {
    if (error instanceof GitError && error.exitCode !== undefined) return error.exitCode;
    throw error;
  }
}

/**
 * Creates a bare repository at `barePath` whose `main` holds `files`.
 * Used as the "remote" by the local source-control fake.
 */
export async function createBareRepo(barePath: string, files: Record<string, string>): Promise<void> {
  mkdirSync(dirname(barePath), { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', barePath]);
  const seed = mkdtempSync(join(tmpdir(), 'cw-seed-'));
  try {
    await git(['clone', barePath, seed]);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, name)), { recursive: true });
      writeFileSync(join(seed, name), content);
    }
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'Initial commit'], seed);
    await git(['push', 'origin', 'HEAD:main'], seed);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
}

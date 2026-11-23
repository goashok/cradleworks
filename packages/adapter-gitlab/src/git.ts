// git CLI with the token passed through environment variables, so it is never written
// into a clone's config or shown in its remote URL.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitCommandError extends Error {
  readonly exitCode: number | undefined;
  readonly stderr: string;
  constructor(args: string[], exitCode: number | undefined, stderr: string) {
    super(`git ${args[0] ?? ''} failed (${exitCode ?? 'signal'}): ${stderr.trim()}`);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitAuth {
  /** e.g. "https://gitlab.com/" */
  host: string;
  token: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export async function git(args: string[], options: { cwd?: string | undefined; auth?: GitAuth; identity: GitIdentity }): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: options.identity.name,
    GIT_AUTHOR_EMAIL: options.identity.email,
    GIT_COMMITTER_NAME: options.identity.name,
    GIT_COMMITTER_EMAIL: options.identity.email,
  };
  if (options.auth) {
    // GitLab takes any user name with a token as the password; `oauth2` is the documented one.
    const basic = Buffer.from(`oauth2:${options.auth.token}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${options.auth.host}.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  try {
    const { stdout } = await run('git', args, { cwd: options.cwd, env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    throw new GitCommandError(args, typeof e.code === 'number' ? e.code : undefined, redact(e.stderr ?? String(error), options.auth?.token));
  }
}

export async function gitExitCode(args: string[], options: { cwd?: string | undefined; identity: GitIdentity }): Promise<number> {
  try {
    await git(args, options);
    return 0;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode !== undefined) return error.exitCode;
    throw error;
  }
}

function redact(text: string, token: string | undefined): string {
  return token ? text.split(token).join('***') : text;
}

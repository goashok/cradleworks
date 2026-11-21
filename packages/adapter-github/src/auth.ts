import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Returns a GitHub token. Called once per adapter and cached. */
export type TokenProvider = () => Promise<string>;

/**
 * v1 sign-in: `GITHUB_TOKEN` if set, else the token of the local `gh` login.
 * A GitHub App provider (short-lived, repo-scoped tokens) replaces this later.
 */
export const defaultTokenProvider: TokenProvider = async () => {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token']);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new Error('No GitHub token: set GITHUB_TOKEN or sign in with `gh auth login`.');
};

import { execFile } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

/**
 * Returns a GitHub token. Adapters call it before every request; a provider caches and
 * refreshes as it needs to.
 */
export type TokenProvider = () => Promise<string>;

/** Keeps the first token a provider gives; for tokens that don't expire on their own. */
function once(provider: TokenProvider): TokenProvider {
  let token: Promise<string> | undefined;
  return () => {
    token ??= provider().catch((error: unknown) => {
      token = undefined;
      throw error;
    });
    return token;
  };
}

/** `GITHUB_TOKEN` if set, else the token of the local `gh` login. */
export const personalTokenProvider: TokenProvider = once(async () => {
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
});

/** What the factory needs, and nothing more: no admin, workflows, secrets or settings. */
export const APP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  actions: 'read',
  metadata: 'read',
} as const;

export interface GitHubAppOptions {
  appId: string;
  /** PEM private key of the app. */
  privateKey: string;
  /** Default: the app's only installation. */
  installationId?: string;
  /** Limit tokens to these repositories (names, without the owner). Default: all the installation can see. */
  repositories?: string[];
  apiBase?: string;
  fetch?: typeof fetch;
  /** Seconds since the epoch. */
  now?: () => number;
}

/**
 * Short-lived installation tokens from a GitHub App: each lasts an hour, carries only
 * `APP_PERMISSIONS`, and sees only the repositories the app is installed on (or the ones
 * listed). Refreshed five minutes before it expires.
 */
export function githubAppTokenProvider(options: GitHubAppOptions): TokenProvider {
  const api = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const http = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let current: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await http(`${api}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${appJwt(options.appId, options.privateKey, now())}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`GitHub App ${method} ${path} answered ${response.status}: ${String(json.message ?? '')}`);
    return json;
  };

  const installation = async (): Promise<string> => {
    if (options.installationId) return options.installationId;
    const list = (await call('GET', '/app/installations')) as unknown as Array<{ id: number }>;
    if (!Array.isArray(list) || list.length !== 1) {
      throw new Error(`the GitHub App has ${Array.isArray(list) ? list.length : 'no'} installations; set CRADLEWORKS_GITHUB_APP_INSTALLATION_ID`);
    }
    return String(list[0]!.id);
  };

  const mint = async (): Promise<string> => {
    const id = await installation();
    const json = await call('POST', `/app/installations/${id}/access_tokens`, {
      permissions: APP_PERMISSIONS,
      ...(options.repositories?.length ? { repositories: options.repositories } : {}),
    });
    const token = String(json.token ?? '');
    if (!token) throw new Error('GitHub App token response had no token');
    current = { token, expiresAt: Math.floor(Date.parse(String(json.expires_at)) / 1000) || now() + 3600 };
    return token;
  };

  return () => {
    if (current && current.expiresAt - now() > 300) return Promise.resolve(current.token);
    pending ??= mint().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** The app's own JWT (RS256), valid ten minutes, backdated a minute for clock drift. */
export function appJwt(appId: string, privateKey: string, nowSeconds: number): string {
  const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64(signature)}`;
}

/**
 * The provider the adapters use: a GitHub App when `CRADLEWORKS_GITHUB_APP_ID` and the key are
 * set, the key as `CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE` or, where secrets are environment
 * variables, `CRADLEWORKS_GITHUB_APP_PRIVATE_KEY` (the PEM itself) (optionally
 * `CRADLEWORKS_GITHUB_APP_INSTALLATION_ID` and `CRADLEWORKS_GITHUB_APP_REPOSITORIES`,
 * comma-separated), else the personal token. Off unless configured.
 */
export function tokenProviderFromEnv(env: NodeJS.ProcessEnv = process.env): TokenProvider {
  const appId = env.CRADLEWORKS_GITHUB_APP_ID?.trim();
  const keyFile = env.CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  // Some hosts store a multi-line value with its newlines written as \n.
  const keyValue = env.CRADLEWORKS_GITHUB_APP_PRIVATE_KEY?.trim().replace(/\\n/g, '\n');
  if (!appId && !keyFile && !keyValue) return personalTokenProvider;
  if (keyFile && keyValue) throw new Error('set CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE or CRADLEWORKS_GITHUB_APP_PRIVATE_KEY, not both');
  if (!appId || !(keyFile || keyValue)) throw new Error('set both CRADLEWORKS_GITHUB_APP_ID and CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE (or CRADLEWORKS_GITHUB_APP_PRIVATE_KEY) to use a GitHub App');
  const installationId = env.CRADLEWORKS_GITHUB_APP_INSTALLATION_ID?.trim();
  const repositories = env.CRADLEWORKS_GITHUB_APP_REPOSITORIES?.split(',').map((r) => r.trim()).filter(Boolean);
  let provider: TokenProvider | undefined;
  return () => {
    // The key is read on first use, so a missing file is reported where a token is needed.
    provider ??= githubAppTokenProvider({ appId, privateKey: keyValue || readFileSync(keyFile!, 'utf8'), ...(installationId ? { installationId } : {}), ...(repositories?.length ? { repositories } : {}) });
    return provider();
  };
}

/** Kept for callers of the v1 name. */
export const defaultTokenProvider: TokenProvider = personalTokenProvider;

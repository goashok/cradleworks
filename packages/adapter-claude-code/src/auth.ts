// Where Claude Code's credentials come from. Two kinds:
//   api_key      an Anthropic API key, billed to the API account
//   oauth_token  a long-lived token from `claude setup-token`, billed to the subscription
// Each is read from its environment variable, else (on macOS) from the login Keychain.

import { execFileSync } from 'node:child_process';

export type ClaudeAuth = { kind: 'api_key'; apiKey: string } | { kind: 'oauth_token'; token: string };

export const KEYCHAIN_SERVICES = {
  api_key: 'cradleworks-anthropic-api-key',
  oauth_token: 'cradleworks-claude-oauth-token',
} as const;

export interface AuthSources {
  env?: Record<string, string | undefined>;
  /** Reads a secret by Keychain service name; undefined when absent. */
  keychain?: (service: string) => string | undefined;
}

export function readKeychain(service: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export function findApiKey(sources: AuthSources = {}): ClaudeAuth | undefined {
  const env = sources.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY || (sources.keychain ?? readKeychain)(KEYCHAIN_SERVICES.api_key);
  return key ? { kind: 'api_key', apiKey: key } : undefined;
}

export function findOAuthToken(sources: AuthSources = {}): ClaudeAuth | undefined {
  const env = sources.env ?? process.env;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || (sources.keychain ?? readKeychain)(KEYCHAIN_SERVICES.oauth_token);
  return token ? { kind: 'oauth_token', token } : undefined;
}

/**
 * `CRADLEWORKS_CLAUDE_AUTH=api_key|subscription` picks one; otherwise an API key wins
 * over a subscription token. Throws with setup instructions when nothing is found.
 */
export function resolveClaudeAuth(sources: AuthSources = {}): ClaudeAuth {
  const env = sources.env ?? process.env;
  const choice = env.CRADLEWORKS_CLAUDE_AUTH;
  if (choice !== undefined && choice !== 'api_key' && choice !== 'subscription') {
    throw new Error(`CRADLEWORKS_CLAUDE_AUTH must be api_key or subscription (got "${choice}")`);
  }
  const found = choice === 'subscription' ? findOAuthToken(sources) : choice === 'api_key' ? findApiKey(sources) : (findApiKey(sources) ?? findOAuthToken(sources));
  if (found) return found;
  throw new Error(
    [
      'No Claude Code credentials found. Either:',
      `  - API key: set ANTHROPIC_API_KEY, or store it with: security add-generic-password -s ${KEYCHAIN_SERVICES.api_key} -a "$USER" -w`,
      `  - Subscription: run \`claude setup-token\`, then set CLAUDE_CODE_OAUTH_TOKEN or store it with: security add-generic-password -s ${KEYCHAIN_SERVICES.oauth_token} -a "$USER" -w`,
    ].join('\n'),
  );
}

export function secretOf(auth: ClaudeAuth): string {
  return auth.kind === 'api_key' ? auth.apiKey : auth.token;
}

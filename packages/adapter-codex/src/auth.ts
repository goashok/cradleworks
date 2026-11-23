// Where the Codex CLI's credential comes from: an OpenAI API key, from
// $CRADLEWORKS_OPENAI_API_KEY or $OPENAI_API_KEY, else (on macOS) the login Keychain.

import { execFileSync } from 'node:child_process';

export interface CodexAuth {
  kind: 'api_key';
  apiKey: string;
}

export const KEYCHAIN_SERVICE = 'cradleworks-openai-api-key';

export interface AuthSources {
  env?: Record<string, string | undefined>;
  keychain?: (service: string) => string | undefined;
}

function readKeychain(service: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export function resolveCodexAuth(sources: AuthSources = {}): CodexAuth {
  const env = sources.env ?? process.env;
  const key = env.CRADLEWORKS_OPENAI_API_KEY || env.OPENAI_API_KEY || (sources.keychain ?? readKeychain)(KEYCHAIN_SERVICE);
  if (!key) {
    throw new Error(`no OpenAI API key for the Codex runtime: set OPENAI_API_KEY, or store it with \`security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w\``);
  }
  return { kind: 'api_key', apiKey: key };
}

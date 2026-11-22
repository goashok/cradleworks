// Rules no factory.yaml can turn off. Projects may add protected paths; they can't remove
// the built-in ones, and nothing here reads a setting that would switch a rule off.

/**
 * Changes to these always need a person at the change gate and are never merged
 * automatically: CI config and the factory's own config are how an agent would widen its
 * own powers. The core knows only the neutral ones; the CLI adds the known CI config files
 * of every supported system, and a project may add more. An entry ending in `/` matches
 * everything under it; any other entry matches that file name anywhere in the repo.
 */
export const PROTECTED_PATHS: readonly string[] = ['.factory/', 'CODEOWNERS'];

export function protectedPathsIn(changed: string[], extra: readonly string[] = []): string[] {
  const rules = [...PROTECTED_PATHS, ...extra];
  return changed.filter((path) =>
    rules.some((rule) => (rule.endsWith('/') ? path.startsWith(rule) || path.includes(`/${rule}`) : path === rule || path.endsWith(`/${rule}`))),
  );
}

/** Branches the factory may push to. It never pushes, force-pushes or deletes anything else. */
const FACTORY_BRANCH = /^factory\/[A-Za-z0-9._-]+$/;

export class HardRuleError extends Error {
  constructor(message: string) {
    super(`hard rule: ${message}`);
    this.name = 'HardRuleError';
  }
}

export function assertFactoryBranch(branch: string): void {
  if (!FACTORY_BRANCH.test(branch)) throw new HardRuleError(`the factory pushes only its own factory/* branches, not "${branch}"`);
}

export function assertMergeTarget(prBase: string, expectedBase: string): void {
  if (prBase !== expectedBase) throw new HardRuleError(`the pull request targets "${prBase}", but this work merges only into "${expectedBase}"`);
}

// --- secrets ----------------------------------------------------------------------

export interface SecretFinding {
  file: string;
  /** Line in the new version of the file; 0 for a finding about the file itself. */
  line: number;
  kind: string;
}

export interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

/** Formats every secret scan looks for; the CLI adds known token formats of hosted services. */
const CONTENT_PATTERNS: readonly SecretPattern[] = [
  { kind: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/ },
  { kind: 'password in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@$]{8,}@[^\s/]+/i },
];

/** Files that hold secrets by convention, wherever their content came from. */
function secretFileKind(path: string): string | undefined {
  const name = path.split('/').pop() ?? path;
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist|defaults)$/.test(name)) return 'environment file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return 'SSH private key file';
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(name)) return 'key or certificate file';
  if (name === '.netrc' || name === '.pgpass' || name === 'credentials.json') return 'credentials file';
  return undefined;
}

/**
 * Looks for secrets in what a unified diff adds (`git diff -U0`): known token and key
 * formats in added lines, and files that hold secrets by convention. Never reports the value.
 */
export function scanDiffForSecrets(diff: string, extra: readonly SecretPattern[] = []): SecretFinding[] {
  const patterns = [...CONTENT_PATTERNS, ...extra];
  const findings: SecretFinding[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      if (file !== '/dev/null') {
        const kind = secretFileKind(file);
        if (kind) findings.push({ file, line: 0, kind });
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && file && file !== '/dev/null') {
      const text = raw.slice(1);
      for (const { kind, pattern } of patterns) if (pattern.test(text)) findings.push({ file, line, kind });
      line++;
    }
  }
  return findings;
}

export function describeSecrets(findings: SecretFinding[]): string {
  const where = findings.slice(0, 5).map((f) => `${f.kind} in ${f.file}${f.line ? `:${f.line}` : ''}`);
  return `the change adds what looks like a secret (${where.join('; ')}${findings.length > 5 ? `; and ${findings.length - 5} more` : ''}), so nothing was pushed. Remove it (load it from the environment or a secret store instead) and retry.`;
}

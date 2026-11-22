// The vendor-specific half of the factory's hard rules. The core holds the mechanism and
// the neutral rules; these lists name real systems, so they live outside it. The CLI always
// passes them in, and nothing in factory.yaml can remove them.

/** CI config files of the systems the factory knows. Changing one needs a person and is never auto-merged. */
export const KNOWN_CI_PATHS: readonly string[] = [
  '.github/',
  '.gitlab-ci.yml',
  '.gitlab/',
  '.circleci/',
  'Jenkinsfile',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.buildkite/',
  '.travis.yml',
  '.drone.yml',
];

/** Token and key formats of hosted services, for the secret scan before every push. */
export const KNOWN_SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{30,}/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/ },
  { kind: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe secret key', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b|_authToken\s*=\s*(?!\$\{)[A-Za-z0-9_-]{20,}/ },
];

/**
 * Commands agents may never run in the sandbox: anything that would push, reach a remote,
 * or use credentials the factory holds. Projects add to this with `sandbox.commands.deny`.
 */
export const DENIED_COMMANDS: readonly string[] = ['git push', 'git remote', 'git config credential', 'git credential', 'gh', 'ssh', 'scp', 'sftp', 'rsync'];

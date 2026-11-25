import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgent } from '@cradleworks/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS_PATH, loadProjectConfig, parseProjectConfig, type ConfigIssue } from './index.ts';
import { readFileSync } from 'node:fs';

const DEFAULTS = { file: 'factory defaults', text: readFileSync(DEFAULTS_PATH, 'utf8') };

// The example from Build spec section 6.
const SPEC_EXAMPLE = `# .factory/factory.yaml
project: reference-orders-service
adapters:
  scm: github            # repo inferred from git remote
  ci: github-actions
  tracker: github-issues
  sandbox: local-docker
  runtime: cli-agent
runtime:
  agent: some-cli-agent
  model: some-model
stack:
  image: eclipse-temurin:21-node20
  build: ./mvnw -q verify
  test: ./mvnw test
  lint: ./mvnw spotless:check
  frontend_test: npm --prefix web test
context:
  include: [src/, web/src/, docs/adr/]
  rules: .factory/rules/*.md
gates:
  spec_approval: human     # human | ai | skip
  plan_check: ai
  change_approval: human
  auto_merge: false
budgets:
  per_task_usd: 5
  per_user_daily_usd: 50
  max_rework_loops: 3
specs: repo              # repo | factory
concurrency: 2
`;

const MINIMAL = `project: notifications
adapters: { scm: s, ci: c, tracker: t, sandbox: x, runtime: r }
runtime: { agent: a, model: m }
stack:
  image: node:22
  build: npm run build
  test: npm test
`;

const project = (text: string) => ({ file: '.factory/factory.yaml', text });

function issuesOf(text: string, defaults = DEFAULTS): ConfigIssue[] {
  try {
    parseProjectConfig(project(text), defaults);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected a ConfigError');
}

describe('valid config', () => {
  it('parses the spec example', () => {
    const config = parseProjectConfig(project(SPEC_EXAMPLE), DEFAULTS);
    expect(config).toMatchObject({
      project: 'reference-orders-service',
      adapters: { scm: 'github', ci: 'github-actions', tracker: 'github-issues', sandbox: 'local-docker', runtime: 'cli-agent' },
      stack: {
        image: 'eclipse-temurin:21-node20',
        commands: { build: './mvnw -q verify', test: './mvnw test', lint: './mvnw spotless:check', frontend_test: 'npm --prefix web test' },
      },
      context: { include: ['src/', 'web/src/', 'docs/adr/'], rules: ['.factory/rules/*.md'] },
      gates: { specApproval: 'human', planCheck: 'ai', changeApproval: 'human', autoMerge: false },
      budgets: { perTaskUsd: 5, perUserDailyUsd: 50, maxReworkLoops: 3 },
      specs: 'repo',
      concurrency: 2,
    });
  });

  it('fills every omitted key from the defaults', () => {
    const config = parseProjectConfig(project(MINIMAL), DEFAULTS);
    expect(config.gates).toEqual({ specApproval: 'human', planCheck: 'ai', changeApproval: 'human', autoMerge: false });
    expect(config.budgets).toEqual({ perTaskUsd: 5, maxReworkLoops: 3 });
    expect(config.context).toEqual({ include: ['.'], rules: ['.factory/rules/*.md'] });
    expect(config.network).toEqual({ mode: 'allowlist', allow: [] });
    expect(config.concurrency).toBe(2);
    expect(config.specs).toBe('repo');
    expect(config.issues).toEqual({ closeWhenDone: true });
  });

  it('lets the project override a single nested key', () => {
    const config = parseProjectConfig(project(`${MINIMAL}gates:\n  change_approval: ai\n  auto_merge: true\n`), DEFAULTS);
    expect(config.gates).toEqual({ specApproval: 'human', planCheck: 'ai', changeApproval: 'ai', autoMerge: true });
  });

  it('turns off closing issues when done', () => {
    expect(parseProjectConfig(project(`${MINIMAL}issues:\n  close_when_done: false\n`), DEFAULTS).issues).toEqual({ closeWhenDone: false });
  });

  it('maps skip to the core gate mode', () => {
    const config = parseProjectConfig(project(`${MINIMAL}gates:\n  plan_check: skip\n`), DEFAULTS);
    expect(config.gates.planCheck).toBe('skipped');
  });

  it('resolves per-role agent overrides', () => {
    const text = MINIMAL.replace('runtime: { agent: a, model: m }', 'runtime: { agent: a, model: m, roles: { reviewer: { model: other } } }');
    const config = parseProjectConfig(project(text), DEFAULTS);
    expect(resolveAgent(config, 'reviewer')).toEqual({ agent: 'a', model: 'other' });
    expect(resolveAgent(config, 'implementer')).toEqual({ agent: 'a', model: 'm' });
  });
});

describe('bad config gives line-numbered errors', () => {
  it('accepts host, host:port and *.domain allow-list entries', () => {
    const text = `${MINIMAL}sandbox:\n  network:\n    mode: allowlist\n    allow:\n      - repo.maven.apache.org\n      - registry.npmjs.org:443\n      - "*.githubusercontent.com"\n`;
    expect(parseProjectConfig(project(text), DEFAULTS).network).toEqual({
      mode: 'allowlist',
      allow: ['repo.maven.apache.org', 'registry.npmjs.org:443', '*.githubusercontent.com'],
    });
  });

  it('points at a malformed allow-list entry', () => {
    const text = `${MINIMAL}sandbox:\n  network:\n    mode: allowlist\n    allow:\n      - repo.maven.apache.org\n      - https://registry.npmjs.org/\n      - "*"\n`;
    expect(issuesOf(text).map((i) => [i.line, i.path, i.message])).toEqual([
      [MINIMAL.split('\n').length + 5, 'sandbox.network.allow.1', 'sandbox.network.allow: "https://registry.npmjs.org/" should be a host name, not a URL'],
      [MINIMAL.split('\n').length + 6, 'sandbox.network.allow.2', 'sandbox.network.allow: "*" is not a valid host name (wildcards are allowed only as a leading "*.")'],
    ]);
  });

  it('points at a bad value, with a suggestion', () => {
    const issues = issuesOf(SPEC_EXAMPLE.replace('spec_approval: human ', 'spec_approval: humans'));
    expect(issues).toEqual([
      {
        file: '.factory/factory.yaml',
        line: 22,
        col: 18,
        path: 'gates.spec_approval',
        message: 'gates.spec_approval must be one of human, ai, skip (got "humans"); did you mean human?',
      },
    ]);
  });

  it('points at an unknown key, with a suggestion', () => {
    const [issue] = issuesOf(SPEC_EXAMPLE.replace('  max_rework_loops: 3', '  max_rework_loop: 3'));
    expect(issue).toMatchObject({ line: 29, col: 3, message: 'unknown key budgets.max_rework_loop; did you mean max_rework_loops?' });
  });

  it('points a missing required key at its parent', () => {
    const [issue] = issuesOf(MINIMAL.replace('  test: npm test\n', ''));
    expect(issue).toMatchObject({ line: 4, col: 1, path: 'stack.test', message: 'stack.test is required' });
  });

  it('reports a missing top-level key at line 1', () => {
    const [issue] = issuesOf(MINIMAL.replace('project: notifications\n', ''));
    expect(issue).toMatchObject({ line: 1, path: 'project', message: 'project is required' });
  });

  it('reports wrong types and ranges', () => {
    const issues = issuesOf(`${MINIMAL}concurrency: 0\nbudgets:\n  per_task_usd: lots\ncontext:\n  include: [src/, 3]\n`);
    expect(issues.map((i) => [i.line, i.message])).toEqual([
      [8, 'concurrency must be at least 1 (got 0)'],
      [10, 'budgets.per_task_usd must be a number (got "lots")'],
      [12, 'context.include[1] must be a non-empty string (got 3)'],
    ]);
  });

  it('reports every problem at once', () => {
    const issues = issuesOf(SPEC_EXAMPLE.replace('specs: repo', 'specs: git').replace('auto_merge: false', 'auto_merge: maybe'));
    expect(issues.map((i) => i.path).sort()).toEqual(['gates.auto_merge', 'specs']);
  });

  it('reports YAML syntax errors with their line', () => {
    const [issue] = issuesOf('project: x\nadapters:\n  scm: [unclosed\n');
    expect(issue?.file).toBe('.factory/factory.yaml');
    expect(issue?.line).toBeGreaterThanOrEqual(3);
  });

  it('refuses duplicate keys', () => {
    const [issue] = issuesOf(`${MINIMAL}concurrency: 2\nconcurrency: 3\n`);
    expect(issue).toMatchObject({ line: 9 });
    expect(issue?.message).toMatch(/unique/i);
  });

  it('refuses a file that is not a mapping', () => {
    expect(issuesOf('- just\n- a list\n')).toMatchObject([{ line: 1, message: 'the file must be a mapping of keys to values' }]);
  });

  it('blames the defaults file when the bad value comes from there', () => {
    const text = DEFAULTS.text.replace('concurrency: 2', 'concurrency: -1');
    expect(text).not.toBe(DEFAULTS.text);
    const [issue] = issuesOf(MINIMAL, { file: 'factory defaults', text });
    expect(issue).toMatchObject({ file: 'factory defaults', path: 'concurrency' });
  });

  it('formats issues as file:line:col', () => {
    expect(() => parseProjectConfig(project(`${MINIMAL}specs: git\n`), DEFAULTS)).toThrow(
      /^\.factory\/factory\.yaml:8:8 {2}specs must be one of repo, factory/,
    );
  });
});

describe('loading from disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const repo = (yaml?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-config-'));
    dirs.push(dir);
    if (yaml !== undefined) {
      mkdirSync(join(dir, '.factory'));
      writeFileSync(join(dir, '.factory', 'factory.yaml'), yaml);
    }
    return dir;
  };

  it('reads .factory/factory.yaml over the shipped defaults', () => {
    expect(loadProjectConfig(repo(SPEC_EXAMPLE)).project).toBe('reference-orders-service');
  });

  it('says which file is missing', () => {
    expect(() => loadProjectConfig(repo())).toThrow(/factory\.yaml {2}file not found/);
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProjectConfig } from '@cradleworks/config';
import { localRepoRef, ProcessSandbox, ScriptedAgentRuntime, type ScriptStep } from '@cradleworks/contracts/fakes';
import type { AgentRunRequest } from '@cradleworks/interfaces';
import { ciCommands, detectStack, renderDockerfile, renderFactoryYaml, type RepoFiles } from './detect.ts';
import { formatInitReport, initProject, type InitDeps } from './init.ts';

const files = (map: Record<string, string>): RepoFiles => ({ paths: Object.keys(map), read: (p) => map[p] });

describe('detectStack', () => {
  it('reads a Node project: package manager, scripts and registry', () => {
    const d = detectStack(files({ 'package.json': JSON.stringify({ name: '@acme/shop', scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } }), 'pnpm-lock.yaml': '', 'src/index.ts': '' }), 'folder');
    expect(d.stack).toBe('Node (pnpm)');
    expect(d.project).toBe('shop');
    expect(d.commands).toEqual({ build: 'pnpm install --frozen-lockfile && pnpm run build', test: 'pnpm test', typecheck: 'pnpm run typecheck', lint: 'pnpm run lint' });
    expect(d.install).toContain('corepack enable');
    expect(d.allow).toEqual(['registry.npmjs.org']);
    expect(d.include).toContain('src/');
    expect(d.incomplete).toBe(false);
  });

  it('skips npm\'s placeholder test script and takes the test command from CI instead', () => {
    const ci = 'jobs:\n  t:\n    steps:\n      - run: npm ci\n      - run: |\n          npx jest --ci\n          echo done\n';
    const d = detectStack(files({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), 'package-lock.json': '', '.github/workflows/ci.yml': ci }), 'app');
    expect(d.commands.build).toBe('npm ci');
    expect(d.commands.test).toBe('npx jest --ci');
  });

  it('reads Python, Go, Rust and Maven projects', () => {
    const py = detectStack(files({ 'pyproject.toml': '[project]\nname = "billing"\n[tool.pytest.ini_options]\n', 'uv.lock': '' }), 'x');
    expect([py.stack, py.project, py.commands.build, py.commands.test]).toEqual(['Python (uv)', 'billing', 'uv sync --frozen', 'uv run pytest']);
    expect(py.allow).toContain('pypi.org');
    const go = detectStack(files({ 'go.mod': 'module github.com/acme/ledger\n\ngo 1.22\n' }), 'x');
    expect([go.project, go.baseImage, go.commands.test]).toEqual(['ledger', 'golang:1.22-bookworm', 'go test ./...']);
    const rust = detectStack(files({ 'Cargo.toml': '[package]\nname = "parser"\n', 'Cargo.lock': '' }), 'x');
    expect(rust.commands.test).toBe('cargo test --locked');
    const java = detectStack(files({ 'pom.xml': '<project><parent><artifactId>spring</artifactId></parent><artifactId>orders</artifactId><properties><java.version>17</java.version></properties></project>', mvnw: '' }), 'x');
    expect([java.project, java.baseImage, java.commands.test]).toEqual(['orders', 'eclipse-temurin:17-jdk-noble', './mvnw -B test']);
  });

  it('says so when it recognises nothing, with commands that fail rather than pass silently', () => {
    const d = detectStack(files({ 'main.c': '' }), 'Tool Kit');
    expect(d.stack).toBeUndefined();
    expect(d.project).toBe('tool-kit');
    expect(d.incomplete).toBe(true);
    expect(d.commands.test).toMatch(/exit 1$/);
    expect(d.notes.join()).toMatch(/no package manifest/);
  });

  it('writes settings the factory accepts, and a Dockerfile with git and the agent CLI', () => {
    const d = detectStack(files({ 'package.json': JSON.stringify({ scripts: { test: 'node --test "a b.js"' } }), 'package-lock.json': '' }), 'app');
    const yaml = renderFactoryYaml(d, { scm: 'github', ci: 'github-actions', tracker: 'github-issues' });
    const config = parseProjectConfig({ file: '.factory/factory.yaml', text: yaml }, { file: 'defaults', text: readFileSync(new URL('../../../../defaults/factory.yaml', import.meta.url), 'utf8') });
    expect(config.stack.commands.test).toBe('npm test');
    expect(config.stack.image).toBe('cradleworks/app-dev:1');
    expect(config.network.allow).toEqual(['registry.npmjs.org']);
    const docker = renderDockerfile(d);
    expect(docker).toMatch(/^FROM node:22/m);
    expect(docker).toMatch(/git ca-certificates/);
    expect(docker).toMatch(/@anthropic-ai\/claude-code@/);
  });

  it('reads run lines from GitHub Actions and GitLab CI', () => {
    expect(ciCommands(files({ '.github/workflows/a.yml': 'steps:\n  - run: make test # all\n  - name: x\n    run: "go vet ./..."\n', '.gitlab-ci.yml': 'test:\n  script:\n    - pytest -q\n' }))).toEqual(['make test', 'go vet ./...', 'pytest -q']);
  });
});

describe('initProject', () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-init-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'start'], { cwd: repo });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (over: Partial<InitDeps> & { built?: string[] } = {}): InitDeps & { built: string[]; removed: string[] } => {
    const built: string[] = [];
    const removed: string[] = [];
    return {
      sandbox: new ProcessSandbox(join(dir, 'sandboxes')),
      runtime: undefined,
      buildImage: async ({ tag }) => (built.push(tag), { ok: true, output: 'built' }),
      removeImage: async (tag) => void removed.push(tag),
      ...over,
      built,
      removed,
    };
  };
  const options = () => ({ root: repo, repo: localRepoRef(repo), adapters: { scm: 'local-git', ci: 'none', tracker: 'none' }, model: 'm', budgetUsd: 2, rounds: 3, commandSeconds: 60 });
  const tracked = () => ({ trackedFiles: execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean) });

  it('without an agent: writes the draft, runs the checks, and leaves no branches or images behind', async () => {
    // npm is not needed for the check: build is replaced by a command that works anywhere.
    const d = deps();
    const report = await initProject(options(), { ...d, buildImage: async (i) => { writeFileSync(join(i.dockerfileDir, '..', 'factory.yaml'), readFileSync(join(i.dockerfileDir, '..', 'factory.yaml'), 'utf8').replace('build: npm install', 'build: "true"')); return d.buildImage(i); } }, tracked());
    expect(report.agent.ran).toBe(false);
    expect(report.files.sort()).toEqual(['.factory/factory.yaml', '.factory/image/Dockerfile', '.factory/rules/conventions.md']);
    expect(report.checks.map((c) => c.name)).toEqual(['image', 'build', 'test']);
    expect(existsSync(join(repo, '.factory', 'factory.yaml'))).toBe(true);
    expect(execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('* main');
    expect(d.removed).toEqual(d.built);
    expect(d.built[0]).toMatch(/^cradleworks\/init-check-/);
  });

  it('with an agent: takes its .factory/ changes, ignores everything else, and gives it the failures', async () => {
    const requests: AgentRunRequest[] = [];
    const script = (r: AgentRunRequest): ScriptStep[] => {
      requests.push(r);
      const yaml = readFileSync(join(r.sandbox.workspacePath, '.factory', 'factory.yaml'), 'utf8');
      // Round 1 breaks the test command; round 2 fixes it after seeing the failure.
      const test = requests.length === 1 ? 'test: sh -c "echo boom; exit 3"' : 'test: "true"';
      return [
        { kind: 'write', path: '.factory/factory.yaml', content: yaml.replace(/build: .*/, 'build: "true"').replace(/test: .*/, test) },
        { kind: 'write', path: '.factory/rules/project.md', content: '# Project\n\n- Real rule.\n' },
        { kind: 'write', path: 'src/hack.js', content: 'outside .factory' },
        { kind: 'write', path: '.factory/secrets.txt', content: 'not a file the factory reads' },
        { kind: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 0.3 },
        { kind: 'message', text: `round ${requests.length}` },
      ];
    };
    const d = deps({ runtime: new ScriptedAgentRuntime(script, { hosts: ['api.example.com'] }) });
    const report = await initProject(options(), d, tracked());
    expect(report.ok).toBe(true);
    expect(report.agent).toMatchObject({ ran: true, rounds: 2 });
    expect(report.agent.costUsd).toBeCloseTo(0.6);
    expect(requests[1]!.input).toMatch(/test failed[\s\S]*boom/);
    expect(requests[0]!.sandbox.workspacePath.startsWith(repo)).toBe(false);
    expect(report.files).toContain('.factory/rules/project.md');
    expect(report.files).not.toContain('.factory/secrets.txt');
    expect(existsSync(join(repo, 'src', 'hack.js'))).toBe(false);
    expect(readFileSync(join(repo, '.factory', 'factory.yaml'), 'utf8')).toMatch(/test: "true"/);
    expect(formatInitReport(report)).toMatch(/checks pass[\s\S]*Agent: 2 rounds, \$0\.60/);
  });

  it('stops at the round limit and reports what still fails', async () => {
    const script = (r: AgentRunRequest): ScriptStep[] => [
      { kind: 'write', path: '.factory/factory.yaml', content: readFileSync(join(r.sandbox.workspacePath, '.factory', 'factory.yaml'), 'utf8').replace(/build: .*/, 'build: "exit 1"') },
      { kind: 'message', text: 'tried' },
    ];
    const report = await initProject({ ...options(), rounds: 2 }, deps({ runtime: new ScriptedAgentRuntime(script) }), tracked());
    expect(report.ok).toBe(false);
    expect(report.agent.rounds).toBe(2);
    expect(report.checks.find((c) => c.name === 'build')?.ok).toBe(false);
    // Build failed, so the test command did not run.
    expect(report.checks.map((c) => c.name)).toEqual(['image', 'build']);
    expect(report.files).toContain('.factory/factory.yaml');
    expect(formatInitReport(report)).toMatch(/not every check passes/);
  });

  it('notes an agent that cannot start, and keeps the checked draft', async () => {
    const runtime = new ScriptedAgentRuntime(() => []);
    runtime.start = async () => {
      throw new Error('No Claude Code credentials found');
    };
    const report = await initProject(options(), deps({ runtime }), tracked());
    expect(report.agent.note).toMatch(/credentials/);
    expect(report.files).toContain('.factory/factory.yaml');
  });
});

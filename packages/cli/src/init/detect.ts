// Works out a first `.factory/` for a repository from its own files, without a model: the
// language and package manager from manifests and lockfiles, the commands from scripts, and the
// commands the repository's CI already runs. `factory init` starts from this draft; the console
// shows it as a starter when no agent can run.

/** What detection reads: the repository's file paths, and a file's text by path. */
export interface RepoFiles {
  paths: string[];
  read(path: string): string | undefined;
}

export interface StackDraft {
  /** Short name for the project, from the folder or the manifest. */
  project: string;
  /** What was found, e.g. "Node (npm)"; undefined when nothing was recognised. */
  stack: string | undefined;
  /** Commands by stack key: build and test always present (possibly as a placeholder). */
  commands: Record<string, string>;
  /** Base image for the sandbox's Dockerfile. */
  baseImage: string;
  /** Dockerfile lines that install the toolchain on top of the base image (after git). */
  install: string[];
  /** Hosts the build and tests need: package registries. */
  allow: string[];
  /** Paths worth giving every agent as context. */
  include: string[];
  /** Things a person should check, in plain words. */
  notes: string[];
  /** True when build or test is a guess that will not work as is. */
  incomplete: boolean;
}

/** The agent version project images install, the same one the factory's own images use. */
export const AGENT_CLI_INSTALL = 'npm install -g @anthropic-ai/claude-code@2.1.319';

const NODE_IMAGE = 'node:22.23.4-bookworm-slim';

const REGISTRIES = {
  npm: ['registry.npmjs.org'],
  yarn: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  pip: ['pypi.org', 'files.pythonhosted.org'],
  go: ['proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com'],
  cargo: ['index.crates.io', 'static.crates.io', 'crates.io'],
  maven: ['repo.maven.apache.org', 'repo1.maven.org'],
  gradle: ['services.gradle.org', 'plugins.gradle.org', 'repo.maven.apache.org', 'repo1.maven.org'],
} as const;

const has = (files: RepoFiles, path: string) => files.paths.includes(path);

/** Shell lines CI runs, from GitHub Actions and GitLab CI files, without the `run:` keys. */
export function ciCommands(files: RepoFiles): string[] {
  const out: string[] = [];
  for (const path of files.paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || p === '.gitlab-ci.yml')) {
    const text = files.read(path) ?? '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]!) ?? /^(\s*)-\s+(.*)$/.exec(path === '.gitlab-ci.yml' ? lines[i]! : '');
      if (!m) continue;
      const value = m[2]!.trim();
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        const indent = m[1]!.length;
        for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > indent); j++) {
          const l = lines[j]!.trim();
          if (l && !l.startsWith('#')) out.push(l);
        }
      } else if (value && !value.startsWith('#')) out.push(value.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, ''));
    }
  }
  return [...new Set(out)];
}

function nodeDraft(files: RepoFiles, draft: StackDraft, ci: string[]) {
  let pkg: { name?: string; scripts?: Record<string, string>; engines?: { node?: string }; packageManager?: string } = {};
  try {
    pkg = JSON.parse(files.read('package.json') ?? '{}');
  } catch {
    draft.notes.push('package.json is not valid JSON, so its scripts were not read');
  }
  const pm = has(files, 'pnpm-lock.yaml') || pkg.packageManager?.startsWith('pnpm') ? 'pnpm' : has(files, 'yarn.lock') || pkg.packageManager?.startsWith('yarn') ? 'yarn' : has(files, 'bun.lockb') || has(files, 'bun.lock') ? 'bun' : 'npm';
  const scripts = pkg.scripts ?? {};
  const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' ? 'test' : `run ${s}`}`);
  const install = { npm: has(files, 'package-lock.json') ? 'npm ci' : 'npm install', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install --frozen-lockfile' }[pm];
  draft.stack = `Node (${pm})`;
  if (pkg.name) draft.project = pkg.name.replace(/^@[^/]+\//, '');
  const build = scripts.build ? `${install} && ${run('build')}` : install;
  draft.commands.build = build;
  if (scripts.test && !/no test specified/.test(scripts.test)) draft.commands.test = run('test');
  for (const [key, names] of [['typecheck', ['typecheck', 'type-check', 'tsc']], ['lint', ['lint']]] as const) {
    const name = names.find((n) => scripts[n]);
    if (name) draft.commands[key] = run(name);
  }
  if (!draft.commands.test) {
    const fromCi = ci.find((c) => /\b(test|jest|vitest|mocha|ava|playwright test)\b/.test(c) && /^(npm|pnpm|yarn|npx|bun)\b/.test(c));
    if (fromCi) draft.commands.test = fromCi;
  }
  draft.baseImage = NODE_IMAGE;
  if (pm === 'pnpm') draft.install.push('corepack enable');
  if (pm === 'yarn') draft.install.push('corepack enable');
  if (pm === 'bun') draft.install.push('npm install -g bun');
  draft.allow.push(...(pm === 'yarn' ? REGISTRIES.yarn : REGISTRIES.npm));
  // The image has Node 22; say so only when the project asks for another major version.
  const wants = /(\d+)/.exec(pkg.engines?.node ?? '')?.[1];
  if (wants && Number(wants) !== 22 && !(/>=?\s*\d/.test(pkg.engines!.node!) && Number(wants) < 22)) draft.notes.push(`package.json asks for Node ${pkg.engines!.node}; the image has Node 22: change the FROM line`);
  draft.include.push('package.json');
}

function pythonDraft(files: RepoFiles, draft: StackDraft, ci: string[]) {
  const pyproject = files.read('pyproject.toml') ?? '';
  const tool = has(files, 'uv.lock') ? 'uv' : has(files, 'poetry.lock') || /\[tool\.poetry\]/.test(pyproject) ? 'poetry' : 'pip';
  draft.stack = `Python (${tool})`;
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  if (name) draft.project = name;
  const usesPytest = /pytest/.test(pyproject) || has(files, 'pytest.ini') || has(files, 'conftest.py') || files.paths.some((p) => /(^|\/)requirements[^/]*\.txt$/.test(p) && /pytest/.test(files.read(p) ?? ''));
  if (tool === 'uv') {
    draft.commands.build = 'uv sync --frozen';
    draft.commands.test = usesPytest ? 'uv run pytest' : 'uv run python -m unittest';
    draft.install.push('pip install --no-cache-dir uv');
  } else if (tool === 'poetry') {
    draft.commands.build = 'poetry install --no-interaction';
    draft.commands.test = usesPytest ? 'poetry run pytest' : 'poetry run python -m unittest';
    draft.install.push('pip install --no-cache-dir poetry');
  } else {
    const reqs = ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt'].filter((p) => has(files, p));
    const venv = 'python -m venv .venv && . .venv/bin/activate';
    draft.commands.build = reqs.length ? `${venv} && pip install ${reqs.map((r) => `-r ${r}`).join(' ')}` : pyproject ? `${venv} && pip install -e .` : `${venv}`;
    draft.commands.test = `. .venv/bin/activate && ${usesPytest ? 'pytest' : 'python -m unittest'}`;
  }
  const lint = ci.find((c) => /^(ruff|flake8|black --check|mypy)\b/.test(c));
  if (lint) draft.commands.lint = lint;
  draft.baseImage = 'python:3.12-slim-bookworm';
  draft.install.push('apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*');
  draft.allow.push(...REGISTRIES.pip);
  draft.include.push(...['pyproject.toml', 'requirements.txt'].filter((p) => has(files, p)));
}

function goDraft(files: RepoFiles, draft: StackDraft) {
  const mod = /^module\s+(\S+)/m.exec(files.read('go.mod') ?? '')?.[1];
  const version = /^go\s+(\d+\.\d+)/m.exec(files.read('go.mod') ?? '')?.[1];
  draft.stack = 'Go';
  if (mod) draft.project = mod.split('/').pop()!;
  draft.commands.build = 'go build ./...';
  draft.commands.test = 'go test ./...';
  draft.commands.lint = 'go vet ./...';
  draft.baseImage = `golang:${version ?? '1.23'}-bookworm`;
  draft.install.push('apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*');
  draft.allow.push(...REGISTRIES.go);
  draft.include.push('go.mod');
}

function rustDraft(files: RepoFiles, draft: StackDraft) {
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(files.read('Cargo.toml') ?? '')?.[1];
  draft.stack = 'Rust (cargo)';
  if (name) draft.project = name;
  draft.commands.build = 'cargo build --locked';
  draft.commands.test = 'cargo test --locked';
  draft.commands.lint = 'cargo clippy --locked -- -D warnings';
  draft.baseImage = 'rust:1-bookworm';
  draft.install.push('rustup component add clippy', 'apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*');
  draft.allow.push(...REGISTRIES.cargo);
  draft.include.push('Cargo.toml');
  if (!has(files, 'Cargo.lock')) {
    draft.commands.build = 'cargo build';
    draft.commands.test = 'cargo test';
    draft.commands.lint = 'cargo clippy -- -D warnings';
  }
}

function jvmDraft(files: RepoFiles, draft: StackDraft) {
  const maven = has(files, 'pom.xml');
  const wrapper = maven ? has(files, 'mvnw') : has(files, 'gradlew');
  const tool = maven ? (wrapper ? './mvnw -B' : 'mvn -B') : wrapper ? './gradlew' : 'gradle';
  draft.stack = maven ? 'Java (Maven)' : 'JVM (Gradle)';
  const artifact = maven ? /<artifactId>([^<]+)<\/artifactId>/.exec((files.read('pom.xml') ?? '').replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1] : undefined;
  if (artifact) draft.project = artifact;
  draft.commands.build = maven ? `${tool} -q -DskipTests package` : `${tool} assemble`;
  draft.commands.test = maven ? `${tool} test` : `${tool} test`;
  const release = maven ? /<(?:maven\.compiler\.release|java\.version)>(\d+)</.exec(files.read('pom.xml') ?? '')?.[1] : undefined;
  draft.baseImage = `eclipse-temurin:${release ?? '21'}-jdk-noble`;
  draft.install.push('apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*');
  if (maven && !wrapper) draft.install.push('apt-get update && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*');
  draft.allow.push(...(maven ? REGISTRIES.maven : REGISTRIES.gradle));
  draft.include.push(maven ? 'pom.xml' : files.paths.find((p) => /^build\.gradle(\.kts)?$/.test(p)) ?? 'build.gradle');
}

/** A first draft of the repository's factory settings. `folder` names the project when nothing else does. */
export function detectStack(files: RepoFiles, folder: string): StackDraft {
  const draft: StackDraft = { project: folder, stack: undefined, commands: {}, baseImage: NODE_IMAGE, install: [], allow: [], include: [], notes: [], incomplete: false };
  const ci = ciCommands(files);
  if (has(files, 'package.json')) nodeDraft(files, draft, ci);
  else if (has(files, 'pyproject.toml') || has(files, 'requirements.txt') || has(files, 'setup.py')) pythonDraft(files, draft, ci);
  else if (has(files, 'go.mod')) goDraft(files, draft);
  else if (has(files, 'Cargo.toml')) rustDraft(files, draft);
  else if (has(files, 'pom.xml') || files.paths.some((p) => /^build\.gradle(\.kts)?$/.test(p))) jvmDraft(files, draft);
  // A second stack beside the first, as a web folder in a Java service: name it so a person adds it.
  const others = [has(files, 'package.json') ? undefined : files.paths.find((p) => /^[^/]+\/package\.json$/.test(p) && !p.startsWith('node_modules/'))].filter(Boolean);
  for (const p of others) draft.notes.push(`${p} looks like a second project in this repository; add its commands to stack if the factory should run them`);
  if (!draft.commands.build) {
    draft.commands.build = 'echo "set stack.build to the command that installs dependencies and builds" && exit 1';
    draft.incomplete = true;
  }
  if (!draft.commands.test) {
    draft.commands.test = 'echo "set stack.test to the command that runs the tests" && exit 1';
    draft.incomplete = true;
  }
  if (!draft.stack) draft.notes.push('no package manifest was recognised, so the commands and image are placeholders');
  for (const dir of ['src', 'lib', 'app', 'test', 'tests', 'docs']) if (files.paths.some((p) => p.startsWith(`${dir}/`))) draft.include.push(`${dir}/`);
  const readme = files.paths.find((p) => /^readme(\.md)?$/i.test(p));
  if (readme) draft.include.push(readme);
  draft.include = [...new Set(draft.include)];
  draft.allow = [...new Set(draft.allow)];
  draft.project = draft.project.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return draft;
}

/** The image tag a project's sandbox is built as. */
export const imageTag = (project: string) => `cradleworks/${project}-dev:1`;

const yamlString = (s: string) => (/^[\w./@:=+-][\w ./@:=+&|;>-]*$/.test(s) && !/: |#/.test(s) ? s : JSON.stringify(s));

/** `.factory/factory.yaml` for a draft: every choice commented, everything else left to the defaults. */
export function renderFactoryYaml(draft: StackDraft, adapters: { scm: string; ci: string; tracker: string }): string {
  const commands = Object.entries(draft.commands);
  return [
    '# Cradleworks settings for this repository, first written by `factory init`.',
    '# Keys not set here come from the factory defaults; `factory config` lists them.',
    `project: ${draft.project}`,
    '',
    'adapters:',
    `  scm: ${adapters.scm}`,
    `  ci: ${adapters.ci}`,
    `  tracker: ${adapters.tracker}`,
    '  sandbox: local-docker   # one container per task, from .factory/image',
    '  runtime: cli-agent',
    '',
    'runtime:',
    '  agent: claude-code',
    '  model: claude-sonnet-5-5',
    '',
    'stack:',
    '  # Built from .factory/image/Dockerfile:',
    `  #   docker build --build-context project=. -t ${imageTag(draft.project)} .factory/image`,
    `  image: ${imageTag(draft.project)}`,
    ...commands.map(([k, v]) => `  ${k}: ${yamlString(v)}`),
    '',
    'context:',
    `  include: [${draft.include.length ? draft.include.join(', ') : '.'}]`,
    '  rules: [.factory/rules/*.md]',
    '',
    'sandbox:',
    '  network:',
    '    mode: allowlist',
    draft.allow.length ? '    allow:' : '    allow: []',
    ...draft.allow.map((h) => `      - ${h}`),
    '',
  ].join('\n');
}

/** `.factory/image/Dockerfile` for a draft: the toolchain, git and the agent CLI. */
export function renderDockerfile(draft: StackDraft): string {
  const node = draft.baseImage.startsWith('node:');
  return [
    `# Sandbox image for ${draft.project}: ${draft.stack ? `${draft.stack}, ` : ''}git and the agent CLI.`,
    `#   docker build --build-context project=. -t ${imageTag(draft.project)} .factory/image`,
    `FROM ${draft.baseImage}`,
    'RUN apt-get update \\',
    ' && apt-get install -y --no-install-recommends git ca-certificates \\',
    ' && rm -rf /var/lib/apt/lists/*',
    ...draft.install.map((l) => `RUN ${l}`),
    `RUN ${AGENT_CLI_INSTALL}${node ? ' \\\n && npm cache clean --force' : ''}`,
    'WORKDIR /workspace',
    '',
  ].join('\n');
}

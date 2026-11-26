// `factory init`: writes a repository's `.factory/` and proves it works. A draft comes from the
// repository's own files (detect.ts); an agent then reads the repository and improves it, in a
// sandbox, writing only under `.factory/`. The factory itself builds the image and runs the
// build and test commands in it, and when they fail the agent gets the output and tries again,
// within a few rounds and a spending cap. Nothing outside `.factory/` is ever taken from the
// sandbox, and nothing is written to the repository until the end.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ConfigError, DEFAULTS_PATH, DENIED_COMMANDS, parseProjectConfig } from '@cradleworks/config';
import type { AgentEvent, AgentProfile, AgentRuntime, NetworkPolicy, RepoRef, Sandbox, SandboxHandle } from '@cradleworks/interfaces';
import { AGENT_CLI_INSTALL, detectStack, imageTag, renderDockerfile, renderFactoryYaml, type RepoFiles, type StackDraft } from './detect.ts';

export interface InitDeps {
  sandbox: Sandbox;
  /** Undefined when no agent can run (no credentials, or `--no-agent`): the draft is checked as is. */
  runtime: AgentRuntime | undefined;
  /** Builds `dockerfileDir`'s Dockerfile with the repository as the `project` build context. */
  buildImage(input: { dockerfileDir: string; projectDir: string; tag: string }): Promise<{ ok: boolean; output: string }>;
  /** Removes an image init built for its checks. */
  removeImage(tag: string): Promise<void>;
  /** What the run is doing, a line at a time, for a person watching. */
  progress?: (line: string) => void;
}

export interface InitOptions {
  /** The repository's root: a git checkout with at least one commit. */
  root: string;
  repo: RepoRef;
  adapters: { scm: string; ci: string; tracker: string };
  /** Model the agent runs on. */
  model: string;
  /** Spending cap across every agent round, in US dollars. */
  budgetUsd: number;
  /** Agent rounds at most, the first included. */
  rounds: number;
  /** Seconds each check command may take. */
  commandSeconds?: number;
  /** Write the files even when the checks fail (they are always reported). Default true. */
  writeOnFailure?: boolean;
}

export interface CheckResult {
  name: string;
  /** The command, or the image tag for the image build. */
  command: string;
  ok: boolean;
  seconds: number;
  /** The end of the output, for the report and for the agent. */
  tail: string;
}

export interface InitReport {
  ok: boolean;
  project: string;
  stack: string | undefined;
  /** Files written, relative to the repository root. */
  files: string[];
  /** The last round's checks. */
  checks: CheckResult[];
  agent: { ran: boolean; rounds: number; costUsd: number; summary?: string; note?: string };
  notes: string[];
}

/** The repository's tracked files, read from the checkout. */
export function checkoutFiles(root: string, paths: string[]): RepoFiles {
  return {
    paths,
    read: (path) => {
      try {
        const full = join(root, path);
        return statSync(full).size > 256 * 1024 ? undefined : readFileSync(full, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** Files under a folder, relative to it, sorted. */
function listFiles(dir: string, under = ''): string[] {
  if (!existsSync(join(dir, under))) return [];
  return readdirSync(join(dir, under), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, join(under, e.name)) : e.isFile() ? [join(under, e.name)] : []))
    .sort();
}

const STARTER_RULES = `# Conventions

What every agent working on this repository is told to follow. Write down what a new
teammate would need to know: where things live, how errors and tests are written, and what
never to do.

- Follow the style of the code around the change.
- Every change comes with tests for it.
`;

/** Checks only take what the factory allows under .factory/: settings, rules and the image folder. */
const ALLOWED = /^(factory\.yaml|rules\/[^/]+\.md|image\/.+)$/;
const MAX_FILE = 64 * 1024;

const tail = (text: string, lines = 40) => text.trimEnd().split('\n').slice(-lines).join('\n').slice(-4000);

export async function initProject(options: InitOptions, deps: InitDeps, git: { trackedFiles: string[] }): Promise<InitReport> {
  const say = deps.progress ?? (() => undefined);
  const folder = options.root.split('/').filter(Boolean).pop() ?? 'project';
  const draft = detectStack(checkoutFiles(options.root, git.trackedFiles), folder);
  const notes = [...draft.notes];
  say(`found ${draft.stack ?? 'no recognised stack'}; drafting .factory/`);

  // The working copy of .factory/ lives here until the end.
  const staging = mkdtempSync(join(tmpdir(), 'factory-init-'));
  const stage = join(staging, '.factory');
  writeDraft(stage, draft, options.adapters);
  // Sandboxes branch from a clone, so the repository itself gets no branches or worktrees.
  const source = join(staging, 'source');
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', options.root, source], { stdio: 'ignore' });
  const where = { ...options, root: source };

  const agent = { ran: false, rounds: 0, costUsd: 0 } as InitReport['agent'];
  // Checks build under tags of their own, so an image a project already uses is never replaced.
  const checkTag = `cradleworks/init-check-${Date.now().toString(36)}`;
  const tags: string[] = [];
  let checks: CheckResult[] = [];
  let built: string | undefined;
  try {
    if (!deps.runtime) agent.note = 'no agent ran: the draft was checked as detected';
    // Round 0 is the draft as detected; each later round is an agent's revision of the last.
    let feedback: string | undefined;
    for (let round = 0; ; round++) {
      if (round > 0) {
        if (!deps.runtime || agent.rounds >= options.rounds || agent.costUsd >= options.budgetUsd) break;
        say(`agent round ${agent.rounds + 1}: ${feedback ? 'fixing what failed' : 'reading the repository and improving the draft'}`);
        const done = await runAgent(where, deps, stage, draft, built, feedback, options.budgetUsd - agent.costUsd).catch((error: unknown) => ({ costUsd: 0, summary: undefined, error: error instanceof Error ? error.message : String(error) }));
        agent.ran = true;
        agent.rounds++;
        agent.costUsd += done.costUsd;
        if (done.summary) agent.summary = done.summary;
        if (done.error) {
          agent.note = `agent round ${agent.rounds}: ${done.error}`;
          break;
        }
      }
      const project = readProject(stage);
      if ('error' in project) {
        checks = [{ name: 'settings', command: '.factory/factory.yaml', ok: false, seconds: 0, tail: project.error }];
      } else {
        const tag = `${checkTag}:${round}`;
        tags.push(tag);
        checks = await runChecks(where, deps, stage, project, tag, say, options.root);
        built = checks.find((c) => c.name === 'image')?.ok ? tag : built;
      }
      const ok = checks.every((c) => c.ok);
      // The first agent round always runs, to read the repository and write its rules; after it,
      // only failures bring another round.
      if (ok && (round > 0 || !deps.runtime)) break;
      feedback = ok ? undefined : checks.filter((c) => !c.ok).map((c) => `${c.name} failed (\`${c.command}\`):\n${c.tail}`).join('\n\n');
    }

    const ok = checks.length > 0 && checks.every((c) => c.ok);
    const final = readProject(stage);
    const files: string[] = [];
    if (ok || options.writeOnFailure !== false) {
      const target = join(options.root, '.factory');
      for (const rel of listFiles(stage)) {
        mkdirSync(dirname(join(target, rel)), { recursive: true });
        cpSync(join(stage, rel), join(target, rel));
        files.push(join('.factory', rel));
      }
    }
    if (draft.incomplete && !agent.ran) notes.push('build or test is a placeholder: set them in .factory/factory.yaml');
    return { ok, project: 'error' in final ? draft.project : final.name, stack: draft.stack, files, checks, agent, notes };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    for (const tag of tags) await deps.removeImage(tag).catch(() => undefined);
  }
}

function writeDraft(stage: string, draft: StackDraft, adapters: InitOptions['adapters']) {
  mkdirSync(join(stage, 'image'), { recursive: true });
  mkdirSync(join(stage, 'rules'), { recursive: true });
  writeFileSync(join(stage, 'factory.yaml'), renderFactoryYaml(draft, adapters));
  writeFileSync(join(stage, 'image', 'Dockerfile'), renderDockerfile(draft));
  writeFileSync(join(stage, 'rules', 'conventions.md'), STARTER_RULES);
}

interface StagedProject {
  name: string;
  image: string;
  commands: Array<[string, string]>;
  network: NetworkPolicy;
}

/** The staged settings, read the way the factory reads them, or why they can't be. */
function readProject(stage: string): StagedProject | { error: string } {
  try {
    const text = readFileSync(join(stage, 'factory.yaml'), 'utf8');
    const config = parseProjectConfig({ file: '.factory/factory.yaml', text }, { file: 'factory defaults', text: readFileSync(DEFAULTS_PATH, 'utf8') });
    const { build, test, ...rest } = config.stack.commands;
    const extra = Object.entries(rest).filter((e): e is [string, string] => typeof e[1] === 'string');
    return { name: config.project, image: config.stack.image, commands: [['build', build], ['test', test], ...extra], network: config.network };
  } catch (error) {
    return { error: error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error) };
  }
}

async function runChecks(options: InitOptions, deps: InitDeps, stage: string, project: StagedProject, tag: string, say: (l: string) => void, projectDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  say('building the image from .factory/image/Dockerfile');
  const started = Date.now();
  const image = await deps.buildImage({ dockerfileDir: join(stage, 'image'), projectDir, tag });
  results.push({ name: 'image', command: '.factory/image/Dockerfile', ok: image.ok, seconds: Math.round((Date.now() - started) / 1000), tail: tail(image.output) });
  if (!image.ok) return results;
  const handle = await openSandbox(options, deps, tag, project.network, 'check');
  try {
    // Build first: the rest depend on it, so a failed build stops the checks there.
    for (const [name, command] of project.commands) {
      say(`running ${name}: ${command}`);
      const t = Date.now();
      const ran = await deps.sandbox.exec(handle, ['sh', '-c', command], { timeoutSeconds: options.commandSeconds ?? 900 });
      const ok = ran.exitCode === 0 && !ran.timedOut;
      results.push({ name, command, ok, seconds: Math.round((Date.now() - t) / 1000), tail: tail(`${ran.stdout}\n${ran.stderr}${ran.timedOut ? '\n(stopped: took too long)' : ''}`) });
      if (!ok && name === 'build') break;
    }
  } finally {
    await deps.sandbox.destroy(handle);
  }
  return results;
}

let sequence = 0;
async function openSandbox(options: InitOptions, deps: InitDeps, image: string, network: NetworkPolicy, tag: string): Promise<SandboxHandle> {
  const id = `init-${Date.now().toString(36)}-${(sequence++).toString(36)}-${tag}`;
  return deps.sandbox.create({ taskId: id, source: { repo: options.repo, path: options.root }, baseRef: 'HEAD', branch: `factory/${id}`, image, network });
}

/** The image an agent runs in when the project's own image doesn't build yet: the agent CLI and git. */
const AGENT_IMAGE = 'cradleworks/init-agent:1';
const AGENT_DOCKERFILE = `FROM node:22.23.4-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \\
 && ${AGENT_CLI_INSTALL} && npm cache clean --force
WORKDIR /workspace
`;

async function runAgent(options: InitOptions, deps: InitDeps, stage: string, draft: StackDraft, built: string | undefined, feedback: string | undefined, budgetUsd: number): Promise<{ costUsd: number; summary?: string; error?: string }> {
  const runtime = deps.runtime!;
  let image = built;
  if (!image) {
    const dir = mkdtempSync(join(tmpdir(), 'factory-init-agent-'));
    try {
      writeFileSync(join(dir, 'Dockerfile'), AGENT_DOCKERFILE);
      const made = await deps.buildImage({ dockerfileDir: dir, projectDir: dir, tag: AGENT_IMAGE });
      if (!made.ok) return { costUsd: 0, error: `the agent's image did not build:\n${tail(made.output, 15)}` };
      image = AGENT_IMAGE;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const profile: AgentProfile = { role: 'implementer', agent: 'claude-code', model: options.model };
  const staged = readProject(stage);
  const allow = [...new Set([...('error' in staged ? draft.allow : staged.network.allow), ...runtime.requiredHosts(profile)])];
  const handle = await openSandbox(options, deps, image, { mode: 'allowlist', allow }, 'agent');
  try {
    const own = join(handle.workspacePath, '.factory');
    rmSync(own, { recursive: true, force: true });
    cpSync(stage, own, { recursive: true });
    const run = await runtime.start({
      runId: `${handle.taskId}-run`,
      profile,
      sandbox: handle,
      rolePrompt: initPrompt(image === AGENT_IMAGE),
      input: initInput(draft, feedback),
      contextFiles: ['.factory/factory.yaml', '.factory/image/Dockerfile', '.factory/rules/conventions.md'],
      tools: { allow: [], deny: [], commands: [...DENIED_COMMANDS, 'docker'] },
      limits: { maxWallSeconds: 900, maxSpendUsd: budgetUsd },
    });
    let done: Extract<AgentEvent, { type: 'done' }> | undefined;
    for await (const event of run.events) {
      if (event.type === 'done') done = event;
      else if (event.type === 'tool_call' && deps.progress) deps.progress(`  agent: ${event.tool}`);
    }
    const costUsd = done?.total.costUsd ?? 0;
    // Take back .factory/ only, and in it only the files the factory reads, at a sane size.
    const taken = listFiles(own).filter((rel) => ALLOWED.test(rel) && statSync(join(own, rel)).size <= MAX_FILE);
    if (!taken.includes('factory.yaml')) return { costUsd, error: 'the agent removed .factory/factory.yaml' };
    rmSync(stage, { recursive: true, force: true });
    for (const rel of taken) {
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      cpSync(join(own, rel), join(stage, rel));
    }
    const ignored = listFiles(own).filter((rel) => !taken.includes(rel));
    const summary = done?.summary ? `${done.summary}${ignored.length ? `\n(left out: ${ignored.map((r) => relative('.', join('.factory', r))).join(', ')})` : ''}` : undefined;
    if (done?.outcome !== 'succeeded') return { costUsd, ...(summary ? { summary } : {}), error: `the agent run ${done?.outcome ?? 'ended without a result'}${done?.error ? `: ${done.error}` : ''}` };
    return { costUsd, ...(summary ? { summary } : {}) };
  } finally {
    await deps.sandbox.destroy(handle);
  }
}

function initPrompt(toolsOnly: boolean): string {
  return `You are setting up Cradleworks, a software factory, on this repository. The factory reads
.factory/ to learn how to work here, then runs AI agents in a container built from
.factory/image/Dockerfile to make changes, and checks every change with the commands in
.factory/factory.yaml. Your job is to make .factory/ correct and useful for this repository.

You may change only these files: .factory/factory.yaml, .factory/image/Dockerfile (and other
files in .factory/image/ the Dockerfile copies), and .factory/rules/*.md. Change nothing else
in the repository; anything outside .factory/ is thrown away.

.factory/factory.yaml:
- stack.build installs dependencies and builds; stack.test runs the tests. Both must exit 0 on
  a clean checkout of the default branch. Any other key under stack is a named command the
  factory also runs (typecheck, lint, e2e_test...). Prefer the commands the repository's own CI
  and README use. Leave out a command that needs services the container doesn't have (a real
  database, a browser) unless the tests start them themselves; say so in your summary.
- stack.image is the tag the factory builds the Dockerfile as; keep it as it is.
- sandbox.network.allow lists the only hosts the container can reach while working: package
  registries the build needs. Keep it short.
- context.include lists the folders and files most worth reading to understand the project.

.factory/image/Dockerfile: the toolchain the commands need, at the versions the repository asks
for, plus git and the line that installs the agent CLI (keep that line). It is built with the
repository as a build context named "project" (COPY --from=project package.json ...), which
lets it install locked dependencies ahead of time so the build needs less network.

.factory/rules/*.md: short rules every agent must follow here, learnt from the code: layout,
conventions, how tests are written and run, what never to do. Facts from this repository only,
a few lines each; no generic advice.

${toolsOnly ? `This container does not have the project's toolchain yet, so you can't run its commands. Read the
repository and write the files; the factory builds the image and runs the commands afterwards.` : `This container is built from .factory/image/Dockerfile, so you can run the commands in it to check
them. You cannot run docker; the factory rebuilds the image after you change the Dockerfile.`}

When you finish, reply with a short summary of what you set and anything a person should check.`;
}

function initInput(draft: StackDraft, feedback: string | undefined): string {
  if (feedback) return `The factory built the image and ran the checks with your files, and these failed. Fix .factory/ so they pass. If a failure is in the project itself (its tests fail on the default branch), don't hide it: leave the command as it should be and say so in your summary.\n\n${feedback}`;
  return [
    `A first draft of .factory/ was written from the repository's files${draft.stack ? ` (found ${draft.stack})` : ' (no stack was recognised)'}. Check it against the repository, correct it, and write .factory/rules/ for this project.`,
    ...(draft.notes.length ? ['', 'Notes from the draft:', ...draft.notes.map((n) => `- ${n}`)] : []),
  ].join('\n');
}

/** The report as a person reads it at the terminal. */
export function formatInitReport(report: InitReport): string {
  const lines = [
    '',
    report.ok ? `.factory/ is set up for ${report.project}, and its checks pass.` : `.factory/ is written for ${report.project}, but not every check passes yet.`,
    ...(report.stack ? [`Stack: ${report.stack}`] : []),
    '',
    'Checks:',
    ...report.checks.map((c) => `  ${c.ok ? 'ok    ' : 'FAILED'} ${c.name.padEnd(10)} ${c.command} (${c.seconds}s)`),
  ];
  const failed = report.checks.find((c) => !c.ok);
  if (failed) lines.push('', `${failed.name} output (last lines):`, ...failed.tail.split('\n').map((l) => `  ${l}`));
  lines.push('', report.agent.ran ? `Agent: ${report.agent.rounds} round${report.agent.rounds === 1 ? '' : 's'}, $${report.agent.costUsd.toFixed(2)}` : `Agent: ${report.agent.note ?? 'did not run'}`);
  if (report.agent.ran && report.agent.note) lines.push(`  ${report.agent.note}`);
  if (report.agent.summary) lines.push(...report.agent.summary.trim().split('\n').map((l) => `  ${l}`));
  if (report.notes.length) lines.push('', 'Check:', ...report.notes.map((n) => `  - ${n}`));
  if (report.files.length) lines.push('', 'Written:', ...report.files.map((f) => `  ${f}`), '', 'Review them, commit them in a pull request, then label an issue "factory".');
  return `${lines.join('\n')}\n`;
}

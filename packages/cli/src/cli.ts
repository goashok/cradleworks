// `factory` command. `run` takes everything it touches as arguments so tests can drive it.

import { execFile } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { ConfigError, loadProjectConfig } from '@cradleworks/config';
import { Orchestrator, WorkItemRepository, type Project, type WorkItem } from '@cradleworks/core';
import type { AgentRuntime } from '@cradleworks/interfaces';
import { findDocker } from '@cradleworks/adapter-local';
import { SqliteStateStore } from '@cradleworks/store-sqlite';
import { defaultRegistry, PLANNED_ADAPTERS, type Registry } from './registry.ts';

export interface CliEnv {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  registry?: Registry;
}

/** Exit codes: 0 ok, 1 the work failed, 2 bad usage or setup. */
export async function run(argv: string[], io: CliEnv): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'submit':
        return await submit(rest, io);
      case 'status':
        return await status(rest, io);
      case 'validate':
        return await validateProject(rest, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return command === undefined ? 2 : 0;
      default:
        io.stderr(`factory: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`factory: ${error.message}\n`);
      return 2;
    }
    if (error instanceof ConfigError) {
      io.stderr(`factory: .factory/factory.yaml has problems:\n${indent(error.message)}\n`);
      return 2;
    }
    throw error;
  }
}

const USAGE = `Usage:
  factory submit <task.md> [--base <branch>]   Build a hand-written task and open a pull request
  factory status [<work-item-id>]              List work items, or show one in detail
  factory validate [<dir>]                     Check a project's .factory/ setup without running anything

Run inside a repository that has a .factory/ folder. Factory state lives in
$CRADLEWORKS_HOME (default ~/.cradleworks).
`;

class UsageError extends Error {}

// --- validate -----------------------------------------------------------------

/** Checks what `submit` would need, without touching git, the network or the state store. */
async function validateProject(args: string[], io: CliEnv): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new UsageError('validate takes at most one folder: factory validate [<dir>]');
  const start = resolve(io.cwd, positionals[0] ?? '.');
  const repoRoot = findProjectRoot(start);
  if (!repoRoot) throw new UsageError(`no .factory/factory.yaml in ${start} or any folder above it`);
  const config = loadProjectConfig(repoRoot); // throws ConfigError with line numbers

  const registry = io.registry ?? defaultRegistry();
  const problems: string[] = [];
  const notes: string[] = [];
  const adapter = (kind: string, id: string, known: string[] | undefined) => {
    if (known === undefined || known.includes(id)) return;
    const planned = PLANNED_ADAPTERS[id];
    if (planned) notes.push(`${kind} adapter "${id}" is not built yet (arrives in ${planned}); submit does not need it`);
    else problems.push(`unknown ${kind} adapter "${id}" (known: ${known.join(', ')})`);
  };
  adapter('scm', config.adapters.scm, Object.keys(registry.sourceControl));
  adapter('sandbox', config.adapters.sandbox, Object.keys(registry.sandbox));
  adapter('runtime', config.adapters.runtime, Object.keys(registry.runtime));
  adapter('ci', config.adapters.ci, undefined);
  adapter('tracker', config.adapters.tracker, undefined);
  for (const id of [config.adapters.ci, config.adapters.tracker]) {
    if (PLANNED_ADAPTERS[id]) notes.push(`adapter "${id}" is not built yet (arrives in ${PLANNED_ADAPTERS[id]}); submit does not need it`);
  }

  for (const pattern of config.context.rules) {
    if (globSync(pattern, { cwd: repoRoot }).length === 0) problems.push(`context.rules: ${pattern} matches no files`);
  }
  for (const path of config.context.include) {
    const found = /[*?[{]/.test(path) ? globSync(path, { cwd: repoRoot }).length > 0 : existsSync(join(repoRoot, path));
    if (!found) problems.push(`context.include: ${path} does not exist`);
  }

  if (config.adapters.sandbox === 'local-docker') {
    const found = await imageExists(config.stack.image);
    if (found === false) notes.push(`stack.image ${config.stack.image} is not built on this machine yet`);
    if (found === undefined) notes.push('could not ask Docker whether stack.image exists');
  }

  const rules = config.context.rules.flatMap((p) => globSync(p, { cwd: repoRoot })).length;
  io.stdout(`${relativeOrSelf(io.cwd, repoRoot)}: project ${config.project}, ${rules} rule file(s), image ${config.stack.image}\n`);
  for (const note of notes) io.stdout(`  note: ${note}\n`);
  for (const problem of problems) io.stderr(`  problem: ${problem}\n`);
  io.stdout(problems.length === 0 ? 'ok\n' : '');
  return problems.length === 0 ? 0 : 2;
}

async function imageExists(image: string): Promise<boolean | undefined> {
  try {
    await promisify(execFile)(findDocker(), ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 15_000 });
    return true;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    return /No such image|not found/i.test(stderr) ? false : undefined;
  }
}

function relativeOrSelf(from: string, to: string): string {
  return to === from ? '.' : to;
}

// --- submit -------------------------------------------------------------------

async function submit(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { base: { type: 'string' } } });
  const [taskPath] = positionals;
  if (!taskPath || positionals.length > 1) throw new UsageError('submit takes exactly one task file: factory submit <task.md>');
  const file = resolve(io.cwd, taskPath);
  if (!existsSync(file)) throw new UsageError(`no task file at ${file}`);
  const task = parseTaskFile(readFileSync(file, 'utf8'), taskPath);

  const ctx = await openProject(io);
  try {
    const project: Project = { ...ctx.project, ...(values.base ? { baseBranch: values.base } : {}) };
    const { workItemId, taskId } = await ctx.orchestrator.submitTask({ project, title: task.title, body: task.body, requester: await requester(ctx.repoRoot, io) });
    io.stdout(`Submitted "${task.title}" as ${workItemId}\nBuilding ${taskId}...\n`);

    const result = await ctx.orchestrator.runBuild(project, workItemId, taskId);
    if (result.outcome === 'pr_opened') {
      io.stdout(`Opened ${result.pr.url}\n  branch ${result.branch}\n  run    ${result.runId}\n`);
      return 0;
    }
    io.stderr(`Build failed: ${result.reason}\n  run ${result.runId}\n`);
    return 1;
  } finally {
    await ctx.close();
  }
}

export function parseTaskFile(text: string, name: string): { title: string; body: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const index = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (index < 0 || lines.slice(0, index).some((line) => line.trim() !== '')) {
    throw new UsageError(`${name} must start with a "# Title" heading`);
  }
  return { title: lines[index]!.replace(/^#\s+/, '').trim(), body: lines.slice(index + 1).join('\n').trim() };
}

// --- status -------------------------------------------------------------------

async function status(args: string[], io: CliEnv): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new UsageError('status takes at most one work item id');
  const home = factoryHome(io);
  const store = new SqliteStateStore({ path: join(home, 'state.db') });
  try {
    const repo = new WorkItemRepository(store);
    const [id] = positionals;
    if (id) {
      const wi = await repo.load(id);
      if (!wi) throw new UsageError(`no work item ${id}`);
      io.stdout(describe(wi));
      return 0;
    }
    const received = await store.query({ types: ['work_item_received'] });
    if (received.length === 0) {
      io.stdout('No work items yet.\n');
      return 0;
    }
    const rows: string[][] = [['WORK ITEM', 'STATE', 'TASKS', 'PROJECT', 'TITLE']];
    for (const event of received.reverse()) {
      const wi = await repo.load(event.streamId);
      if (!wi) continue;
      const done = wi.tasks.filter((t) => t.state === 'merged').length;
      rows.push([wi.id, wi.state, `${done}/${wi.tasks.length}`, wi.projectId, wi.title]);
    }
    io.stdout(table(rows));
    return 0;
  } finally {
    await store.close();
  }
}

function describe(wi: WorkItem): string {
  const lines = [
    `${wi.id}  ${wi.state}`,
    `  title      ${wi.title}`,
    `  project    ${wi.projectId}`,
    `  requester  ${wi.requester}`,
    `  created    ${wi.createdAt}`,
    `  updated    ${wi.updatedAt}`,
    '',
    'Tasks',
  ];
  for (const t of wi.tasks) {
    lines.push(`  ${t.id}  ${t.state}  ${t.title}`);
    if (t.pr) lines.push(`    pr      ${t.pr.url}`);
    if (t.branch) lines.push(`    branch  ${t.branch}`);
    if (t.lastReason) lines.push(`    reason  ${t.lastReason}`);
  }
  lines.push('', 'Runs');
  for (const r of wi.runs) lines.push(`  ${r.id}  ${r.station}  ${r.outcome ?? 'running'}  ${r.startedAt}`);
  lines.push('', 'Gates');
  for (const g of wi.gateDecisions) lines.push(`  ${g.gate}  ${g.verdict} (${g.mode}) by ${g.decidedBy}`);
  return `${lines.join('\n')}\n`;
}

// --- setup --------------------------------------------------------------------

interface ProjectContext {
  repoRoot: string;
  project: Project;
  orchestrator: Orchestrator;
  close(): Promise<void>;
}

async function openProject(io: CliEnv): Promise<ProjectContext> {
  const repoRoot = findProjectRoot(io.cwd);
  if (!repoRoot) throw new UsageError(`no .factory/factory.yaml in ${io.cwd} or any folder above it`);
  const config = loadProjectConfig(repoRoot);
  const registry = io.registry ?? defaultRegistry();
  const home = factoryHome(io);

  const pick = <T>(kind: string, table: Record<string, T>, id: string): T => {
    const entry = table[id];
    if (entry) return entry;
    const planned = PLANNED_ADAPTERS[id];
    throw new UsageError(
      planned ? `${kind} adapter "${id}" is not available yet; it arrives in ${planned}` : `unknown ${kind} adapter "${id}" (known: ${Object.keys(table).join(', ') || 'none'})`,
    );
  };
  const scmEntry = pick('source control', registry.sourceControl, config.adapters.scm);
  const makeSandbox = pick('sandbox', registry.sandbox, config.adapters.sandbox);
  const makeRuntime = pick('runtime', registry.runtime, config.adapters.runtime);

  const remote = await gitOutput(['remote', 'get-url', 'origin'], repoRoot).catch(() => '');
  if (!remote) throw new UsageError(`${repoRoot} has no "origin" remote`);
  const repo = scmEntry.repoFromRemote(remote);
  if (!repo) throw new UsageError(`origin ${remote} is not a ${config.adapters.scm} repository`);

  if (registry.testOnlySandboxes.has(config.adapters.sandbox)) {
    io.stderr(`warning: sandbox "${config.adapters.sandbox}" is for testing only and does not isolate the agent\n`);
  }

  const sandbox = makeSandbox(home);
  let runtime: AgentRuntime;
  try {
    runtime = makeRuntime({ sandbox, env: io.env });
  } catch (error) {
    throw new UsageError(`cannot set up runtime "${config.adapters.runtime}": ${(error as Error).message}`);
  }
  const store = new SqliteStateStore({ path: join(home, 'state.db') });
  const orchestrator = new Orchestrator({
    store,
    sourceControl: scmEntry.create(),
    sandbox,
    runtime,
    workRoot: join(home, 'work'),
  });
  return { repoRoot, project: { repo, config }, orchestrator, close: () => store.close() };
}

export function findProjectRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.factory', 'factory.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function factoryHome(io: CliEnv): string {
  return resolve(io.env.CRADLEWORKS_HOME ?? join(homedir(), '.cradleworks'));
}

async function requester(repoRoot: string, io: CliEnv): Promise<string> {
  const name = await gitOutput(['config', 'user.name'], repoRoot).catch(() => '');
  return name || io.env.USER || userInfo().username;
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await promisify(execFile)('git', args, { cwd });
  return stdout.trim();
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')).join('\n') + '\n';
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

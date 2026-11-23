// `factory` command. `run` takes everything it touches as arguments so tests can drive it.

import { execFile } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { ConfigError, DENIED_COMMANDS, KNOWN_CI_PATHS, KNOWN_SECRET_PATTERNS, loadProjectConfig } from '@cradleworks/config';
import { Orchestrator, TERMINAL_WORK_ITEM_STATES, WorkItemRepository, type Evidence, type Progress, type Project, type Task, type TaskOutcome, type WorkItem, type WorkProgress } from '@cradleworks/core';
import { AGENT_ROLES, type AgentRuntime, type CI, type ItemRef, type Tracker } from '@cradleworks/interfaces';
import { findDocker } from '@cradleworks/adapter-local';
import { SqliteStateStore } from '@cradleworks/store-sqlite';
import { formatLog } from './log.ts';
import { checkRequirements, checkSkills, skillsCommand, type RequirementRunner } from './skills.ts';
import { checkDrill, runDrill } from './drill.ts';
import { AgentsByName } from './agents.ts';
import { defaultRegistry, PLANNED_ADAPTERS, type Registry } from './registry.ts';

export interface CliEnv {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  registry?: Registry;
  /** Aborted to stop `factory watch` after the steps it is in. */
  signal?: AbortSignal;
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
      case 'log':
        return await log(rest, io);
      case 'approve':
        return await approve(rest, io);
      case 'reject':
        return await reject(rest, io);
      case 'retry':
        return await retry(rest, io);
      case 'budget':
        return await budget(rest, io);
      case 'resume':
        return await resume(rest, io);
      case 'cancel':
        return await cancel(rest, io);
      case 'sync':
        return await sync(rest, io);
      case 'watch':
        return await watch(rest, io);
      case 'console':
        return await consoleCommand(rest, io);
      case 'review':
        return await review(rest, io);
      case 'drill':
        return await drillCommand(rest, io);
      case 'skills': {
        const root = findProjectRoot(io.cwd);
        if (!root) throw new UsageError(`no .factory/factory.yaml in ${io.cwd} or any folder above it`);
        return await skillsCommand(rest, io, root, loadProjectConfig(root));
      }
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
  factory watch [<dir>...] [--once] [--interval <seconds>] [--label <name>]
                                    Take issues labelled "factory" (by default) through spec, plan,
                                    build, verify and merge; every 60 s until stopped, or once
  factory submit <task.md> [--base <branch>] [--build-only]
                                    Build a hand-written task, open a pull request, verify it,
                                    rework it until it passes, and stop at the change gate
  factory status [<id>]             List work items, or show one with its evidence
  factory approve <id> [--merge] [--reason <text>]
                                    Pass a ready task through the change gate (and merge it),
                                    or a work item's spec or plan through its gate
  factory reject <id> --reason <text> [--no-run]
                                    Send a ready task back; the reason becomes rework feedback.
                                    On a work item at the spec or plan gate: write a new version
  factory retry <id> [--loops <n>] [--note <text>] [--no-run]
                                    Give an escalated task more attempts
  factory resume <id>               Continue a task from where it stands, or unblock a work item
  factory sync [<id>]               Pick up approvals, requested changes and merges from pull requests
  factory budget [<user>]           What a requester spent today and this month, against the caps
  factory budget extend <id> [--usd <n>] | --user <name> --usd <n> [--month]
                                    Raise a paused task's cap and carry on, or a requester's cap
  factory cancel <id> [--reason <text>]
                                    Cancel a work item
  factory review <change.patch> --title <text> [--task <file.md>] [--base <branch>] [--check <name>] [--json]
                                    Have the reviewer judge a change the factory didn't build, as
                                    Verify's reviewer would; nothing is pushed or merged. Exits 0
                                    on pass, 1 on rework or escalate, 3 if it couldn't review
  factory drill [--check <name>] [--base <branch>] [--json]
                                    Hand the reviewer and each agent check the known-bad and
                                    known-good changes in .factory/drill/. Exits 0 when every
                                    one was judged right, 1 when one was missed, 3 inconclusive
  factory validate [<dir>]          Check a project's .factory/ setup without running anything
  factory skills list | add <git-url|folder> [--path <dir>] [--ref <ref>] [--name <n>] | update <name> [--ref <ref>] | lock <name>
                                    Vendor agent skills into .factory/skills/ and pin them in
                                    .factory/skills.lock; nothing is committed
  factory log <run-id|id> [--full] [--json]
                                    Replay a run's event log: every step, tool call and file change
  factory console [--port <n>]      A local web page of the work, what waits on a person, spend and
                                    run logs, with buttons for approve, send back, retry, extend, cancel

<id> is a work item id (wi_…) or a task id (task_…).

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
  adapter('ci', config.adapters.ci, [...Object.keys(registry.ci), 'none']);
  adapter('tracker', config.adapters.tracker, [...Object.keys(registry.tracker), 'none']);
  const ciEntry = registry.ci[config.adapters.ci];
  if (ciEntry && !ciEntry.scm.includes(config.adapters.scm)) notes.push(`ci "${config.adapters.ci}" does not build ${config.adapters.scm} repositories; Verify will run without CI`);
  const trackerEntry = registry.tracker[config.adapters.tracker];
  if (trackerEntry && !trackerEntry.scm.includes(config.adapters.scm)) problems.push(`tracker "${config.adapters.tracker}" does not track ${config.adapters.scm} repositories`);
  if (config.adapters.tracker === 'none') notes.push('no tracker: submit works, factory watch does not');
  for (const path of config.relatedRepos) {
    const root = findProjectRoot(resolve(repoRoot, path));
    if (!root || root === repoRoot) problems.push(`related_repos: ${path} has no .factory/factory.yaml`);
  }

  for (const pattern of config.context.rules) {
    if (globSync(pattern, { cwd: repoRoot }).length === 0) problems.push(`context.rules: ${pattern} matches no files`);
  }
  for (const path of config.context.include) {
    const found = /[*?[{]/.test(path) ? globSync(path, { cwd: repoRoot }).length > 0 : existsSync(join(repoRoot, path));
    if (!found) problems.push(`context.include: ${path} does not exist`);
  }

  const skills = checkSkills(repoRoot, config);
  problems.push(...skills.problems);
  notes.push(...skills.notes);
  const drill = checkDrill(repoRoot, config);
  problems.push(...drill.problems);
  notes.push(...drill.notes);

  // Prompt additions: one file per role, added to that role's prompt once on the base branch.
  const additions = globSync('.factory/prompts/*.md', { cwd: repoRoot }).sort();
  for (const path of additions) {
    const role = path.slice('.factory/prompts/'.length, -'.md'.length);
    if (!(AGENT_ROLES as readonly string[]).includes(role)) problems.push(`${path}: "${role}" is not a role (roles: ${AGENT_ROLES.join(', ')})`);
    else if (!readFileSync(join(repoRoot, path), 'utf8').trim()) notes.push(`${path} is empty, so the ${role} gets no addition`);
  }

  let runner: RequirementRunner | undefined;
  if (config.adapters.sandbox === 'local-docker') {
    const found = await imageExists(config.stack.image);
    if (found === false) notes.push(`stack.image ${config.stack.image} is not built on this machine yet`);
    if (found === undefined) notes.push('could not ask Docker whether stack.image exists');
    if (found) runner = (command) => inImage(config.stack.image, command);
  } else if (config.adapters.sandbox === 'process') {
    // The test-only sandbox runs on this machine, so this machine is its "image".
    runner = (command) => onHost(command, repoRoot);
  }
  const requirements = await checkRequirements(repoRoot, config, runner);
  problems.push(...requirements.problems);
  notes.push(...requirements.notes);

  const rules = config.context.rules.flatMap((p) => globSync(p, { cwd: repoRoot })).length;
  io.stdout(`${relativeOrSelf(io.cwd, repoRoot)}: project ${config.project}, ${rules} rule file(s), ${additions.length} prompt addition(s), ${skills.count} skill(s), image ${config.stack.image}\n`);
  for (const note of notes) io.stdout(`  note: ${note}\n`);
  for (const problem of problems) io.stderr(`  problem: ${problem}\n`);
  io.stdout(problems.length === 0 ? 'ok\n' : '');
  return problems.length === 0 ? 0 : 2;
}

/** Runs a skill's requirement in a throwaway container of the image, with no network. */
async function inImage(image: string, command: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await promisify(execFile)(findDocker(), ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', command], { timeout: 120_000 });
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: lastLine(error) };
  }
}

async function onHost(command: string, cwd: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await promisify(execFile)('sh', ['-c', command], { cwd, timeout: 120_000 });
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: lastLine(error) };
  }
}

const lastLine = (error: unknown) => {
  const e = error as { stderr?: string; stdout?: string; killed?: boolean; code?: unknown };
  if (e.killed) return 'timed out';
  const text = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim().split('\n').filter(Boolean);
  return (text.at(-1) ?? `exit ${String(e.code ?? '?')}`).slice(0, 200);
};

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

/** `factory review`: the reviewer on a patch, for reviewing by hand and for drills. */
async function review(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { title: { type: 'string' }, task: { type: 'string' }, base: { type: 'string' }, check: { type: 'string' }, json: { type: 'boolean' } },
  });
  const [patchPath] = positionals;
  if (!patchPath || positionals.length > 1) throw new UsageError('review takes exactly one patch file: factory review <change.patch> --title <text>');
  if (!values.title) throw new UsageError('review needs --title: what the change is meant to do');
  const read = (path: string, what: string) => {
    const file = resolve(io.cwd, path);
    if (!existsSync(file)) throw new UsageError(`no ${what} at ${file}`);
    return readFileSync(file, 'utf8');
  };
  const patch = read(patchPath, 'patch file');
  const description = values.task ? read(values.task, 'task file') : '';

  const ctx = await openProject(io);
  try {
    const outcome = await ctx.orchestrator.reviewChange(ctx.project, { title: values.title, description, patch, ...(values.base ? { base: values.base } : {}), ...(values.check ? { check: values.check } : {}) });
    if (values.json) io.stdout(`${JSON.stringify(outcome)}\n`);
    else if (outcome.review) {
      const r = outcome.review;
      io.stdout(`${r.verdict}, ${r.risk} risk (${r.model}, $${outcome.cost.toFixed(2)}, run ${outcome.runId})\n${r.reasons.map((x) => `- ${x}`).join('\n')}\n`);
    } else io.stderr(`factory: could not review: ${outcome.stop ?? outcome.error} (run ${outcome.runId})\n`);
    if (!outcome.review) return 3;
    return outcome.review.verdict === 'pass' ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

async function drillCommand(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { check: { type: 'string' }, base: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError('drill takes no arguments: factory drill [--check <name>] [--base <branch>] [--json]');
  const ctx = await openProject(io);
  try {
    return await runDrill(ctx.repoRoot, ctx.project, (input) => ctx.orchestrator.reviewChange(ctx.project, input), io, {
      ...(values.check ? { check: values.check } : {}),
      ...(values.base ? { base: values.base } : {}),
      json: values.json ?? false,
    });
  } finally {
    await ctx.close();
  }
}

async function submit(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { base: { type: 'string' }, 'build-only': { type: 'boolean' } },
  });
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

    if (values['build-only']) {
      const result = await ctx.orchestrator.runBuild(project, workItemId, taskId);
      printProgress(io, { kind: 'built', outcome: result, attempt: 1 });
      return result.outcome === 'pr_opened' ? 0 : 1;
    }
    const outcome = await ctx.orchestrator.runTask(project, workItemId, taskId, (p) => printProgress(io, p));
    return printOutcome(io, taskId, workItemId, outcome);
  } finally {
    await ctx.close();
  }
}

function printProgress(io: CliEnv, p: Progress): void {
  switch (p.kind) {
    case 'built': {
      const o = p.outcome;
      if (o.outcome === 'pr_opened') {
        io.stdout(o.reworked ? `Pushed rework ${p.attempt - 1} to ${o.pr.url}\n  run    ${o.runId}\n` : `Opened ${o.pr.url}\n  branch ${o.branch}\n  run    ${o.runId}\n`);
        io.stdout('Verifying...\n');
      } else if (o.outcome === 'tests_revised') {
        io.stdout(`The implementer disputed an acceptance test; the tester agreed and revised it:\n${indent(o.reason)}\n  run ${o.runId}\n`);
        io.stdout('Verifying...\n');
      } else if (o.outcome === 'paused') {
        io.stdout(`Paused: ${o.reason.replace(/^budget: /, '')}\n  run ${o.runId}\n`);
      } else if (o.outcome === 'declined' && o.reason.startsWith('paused:')) {
        io.stdout(`Paused: ${o.reason.slice('paused: '.length)}\n  run ${o.runId}\n`);
      } else if (o.outcome === 'declined') {
        io.stdout(`The agent changed nothing and said why:\n${indent(o.reason)}\n  run ${o.runId}\n`);
      } else {
        io.stderr(`Build failed: ${o.reason}\n  run ${o.runId}\n`);
      }
      return;
    }
    case 'verified': {
      const o = p.outcome;
      if (o.evidence) io.stdout(`${indent(evidenceLines(o.evidence).join('\n'))}\n`);
      const word = { pass: 'Passed', rework: 'Sent back for rework', escalate: 'Needs a human' }[o.verdict];
      io.stdout(`${word}: ${o.reason}\n  run    ${o.runId}\n`);
      if (o.verdict === 'rework') io.stdout('Reworking...\n');
      return;
    }
    case 'gate':
      if (p.verdict === 'approved') io.stdout(`Change gate: approved (${p.mode})\n`);
      return;
    case 'merged':
      io.stdout(`Merged ${p.sha.slice(0, 12)}\n`);
      return;
  }
}

/** Exit 0 when the task reached the gate or beyond; 1 when it failed or needs a person. */
function printOutcome(io: CliEnv, taskId: string, workItemId: string, outcome: TaskOutcome): number {
  switch (outcome.state) {
    case 'ready':
      if (outcome.awaitingApproval) io.stdout(`Ready for review: ${outcome.pr?.url ?? ''}\n  approve with  factory approve ${taskId} [--merge]\n  or send back  factory reject ${taskId} --reason "..."\n`);
      else io.stdout(`Approved and ready to merge: ${outcome.pr?.url ?? ''}\n`);
      return 0;
    case 'merged':
      return 0;
    case 'budget_exceeded':
      io.stdout(`Paused for budget: ${(outcome.reason ?? '').replace(/^budget: /, '')}\n  spend so far  factory status ${workItemId}\n  carry on     factory budget extend ${taskId} --usd <amount>\n`);
      return 1;
    case 'escalated':
      io.stdout(`Escalated: ${outcome.reason ?? 'needs a person'}\n  details     factory status ${workItemId}\n  try again   factory retry ${taskId} [--note "..."]\n  give up     factory cancel ${workItemId}\n`);
      return 1;
    default:
      if (outcome.state !== 'failed') io.stdout(`Task is ${outcome.state}${outcome.reason ? `: ${outcome.reason}` : ''}\n`);
      return 1;
  }
}

function evidenceLines(e: Evidence): string[] {
  const mark = (o: string) => ({ passed: '✓', failed: '✗', timed_out: '⏱', skipped: '–' })[o] ?? o;
  const checks = e.checks.map((c) => `${c.name} ${mark(c.outcome)}${c.flaky ? ' (flaky)' : ''}`).join(', ');
  const ci = e.ci.state === 'not_configured' ? 'not configured' : e.ci.state === 'none' ? 'no run' : e.ci.state;
  const review = e.review ? `${e.review.verdict} (${e.review.risk} risk)` : 'not run';
  const lines = [`checks: ${checks || 'none'}   CI: ${ci}   reviewer: ${review}`];
  for (const r of e.review?.reasons ?? []) lines.push(`  - ${r}`);
  return lines;
}

export function parseTaskFile(text: string, name: string): { title: string; body: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const index = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (index < 0 || lines.slice(0, index).some((line) => line.trim() !== '')) {
    throw new UsageError(`${name} must start with a "# Title" heading`);
  }
  return { title: lines[index]!.replace(/^#\s+/, '').trim(), body: lines.slice(index + 1).join('\n').trim() };
}

// --- gate, retry, resume, cancel, sync ---------------------------------------------

async function approve(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { merge: { type: 'boolean' }, reason: { type: 'string' } } });
  const atGate = await decideWorkItemGate(positionals, io, 'approved', values.reason);
  if (atGate !== undefined) return atGate;
  return withTask(positionals, 'approve', io, async (ctx, wi, task) => {
    const by = await requester(ctx.repoRoot, io);
    const result = await ctx.orchestrator.approveTask(ctx.project, wi.id, task.id, { by, ...(values.reason ? { reason: values.reason } : {}), merge: values.merge ?? false });
    io.stdout(result.merged ? `Approved and merged ${result.merged.slice(0, 12)}\n` : `Approved ${task.id}${task.pr ? `; merge it on ${task.pr.url} or with factory approve ${task.id} --merge` : ''}\n`);
    return 0;
  });
}

async function reject(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, 'no-run': { type: 'boolean' } } });
  if (!values.reason?.trim()) throw new UsageError('reject needs --reason "<what to change>"');
  const atGate = await decideWorkItemGate(positionals, io, 'rejected', values.reason);
  if (atGate !== undefined) return atGate;
  return withTask(positionals, 'reject', io, async (ctx, wi, task) => {
    await ctx.orchestrator.rejectTask(wi.id, task.id, { by: await requester(ctx.repoRoot, io), reason: values.reason! });
    io.stdout(`Sent ${task.id} back for rework\n`);
    return values['no-run'] ? 0 : continueTask(ctx, io, wi.id, task.id);
  });
}

async function retry(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { loops: { type: 'string' }, note: { type: 'string' }, 'no-run': { type: 'boolean' } } });
  const loops = values.loops === undefined ? 1 : Number(values.loops);
  if (!Number.isInteger(loops) || loops < 1) throw new UsageError('--loops must be a whole number of at least 1');
  return withTask(positionals, 'retry', io, async (ctx, wi, task) => {
    await ctx.orchestrator.retryTask(wi.id, task.id, { by: await requester(ctx.repoRoot, io), extraLoops: loops, ...(values.note ? { note: values.note } : {}) });
    io.stdout(`Granted ${loops} more attempt${loops > 1 ? 's' : ''} to ${task.id}\n`);
    return values['no-run'] ? 0 : continueTask(ctx, io, wi.id, task.id);
  });
}

async function resume(args: string[], io: CliEnv): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [id] = positionals;
  if (id?.startsWith('wi_') && positionals.length === 1) {
    const ctx = await openProject(io);
    try {
      const wi = await ctx.repository.load(id);
      if (wi?.state === 'blocked') {
        await ctx.orchestrator.resumeWorkItem(id, await requester(ctx.repoRoot, io));
        io.stdout(`Unblocked ${id}; factory watch carries on from ${wi.blockedFrom ?? 'where it stopped'}\n`);
        return 0;
      }
    } finally {
      await ctx.close();
    }
  }
  return withTask(positionals, 'resume', io, (ctx, wi, task) => continueTask(ctx, io, wi.id, task.id));
}

/** `approve`/`reject` on a work item waiting at the spec or plan gate; undefined when it isn't. */
async function decideWorkItemGate(positionals: string[], io: CliEnv, verdict: 'approved' | 'rejected', reason: string | undefined): Promise<number | undefined> {
  const [id] = positionals;
  if (!id?.startsWith('wi_') || positionals.length !== 1) return undefined;
  const ctx = await openProject(io);
  try {
    const wi = await ctx.repository.load(id);
    if (!wi || !(wi.state === 'awaiting_spec_approval' || (wi.state === 'planning' && wi.proposedTasks.length > 0))) return undefined;
    const gate = await ctx.orchestrator.decideWorkItemGate(id, { by: await requester(ctx.repoRoot, io), verdict, ...(reason ? { reason } : {}) });
    const what = gate === 'spec_approval' ? `spec v${wi.spec?.version}` : 'plan';
    io.stdout(verdict === 'approved' ? `Approved the ${what} of ${id}; factory watch carries on from here\n` : `Rejected the ${what} of ${id}; factory watch writes a new version\n`);
    return 0;
  } finally {
    await ctx.close();
  }
}

async function cancel(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [id] = positionals;
  if (!id || positionals.length > 1) throw new UsageError('cancel takes one work item or task id');
  const store = new SqliteStateStore({ path: join(factoryHome(io), 'state.db') });
  try {
    const { wi } = await findTarget(new WorkItemRepository(store), store, id);
    const repo = new WorkItemRepository(store);
    const latest = (await repo.load(wi.id))!;
    await repo.append(latest, [{ type: 'work_item_cancelled', at: new Date().toISOString(), reason: values.reason?.trim() || 'cancelled from the CLI' }]);
    io.stdout(`Cancelled ${wi.id}. Its pull requests stay open; close them on the forge if you want.\n`);
    return 0;
  } finally {
    await store.close();
  }
}

async function sync(args: string[], io: CliEnv): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new UsageError('sync takes at most one id');
  const ctx = await openProject(io);
  try {
    let ids: string[];
    if (positionals[0]) {
      ids = [(await findTarget(ctx.repository, ctx.store, positionals[0])).wi.id];
    } else {
      const received = await ctx.store.query({ types: ['work_item_received'] });
      ids = [];
      for (const e of received) {
        const wi = await ctx.repository.load(e.streamId);
        if (wi && wi.projectId === ctx.project.config.project && !['merged', 'failed', 'cancelled'].includes(wi.state)) ids.push(wi.id);
      }
    }
    let changed = 0;
    for (const id of ids) {
      for (const note of await ctx.orchestrator.syncWorkItem(ctx.project, id)) {
        io.stdout(`${note}\n`);
        changed++;
      }
    }
    if (changed === 0) io.stdout(`Nothing to update (${ids.length} open work item${ids.length === 1 ? '' : 's'} checked)\n`);
    else io.stdout('Continue a task sent back with factory resume <task-id>\n');
    return 0;
  } finally {
    await ctx.close();
  }
}

async function continueTask(ctx: ProjectContext, io: CliEnv, workItemId: string, taskId: string): Promise<number> {
  const outcome = await ctx.orchestrator.runTask(ctx.project, workItemId, taskId, (p) => printProgress(io, p));
  return printOutcome(io, taskId, workItemId, outcome);
}

async function withTask(
  positionals: string[],
  command: string,
  io: CliEnv,
  act: (ctx: ProjectContext, wi: WorkItem, task: Task) => Promise<number>,
): Promise<number> {
  const [id] = positionals;
  if (!id || positionals.length > 1) throw new UsageError(`${command} takes one task or work item id`);
  const ctx = await openProject(io);
  try {
    const { wi, task } = await findTarget(ctx.repository, ctx.store, id);
    if (!task) throw new UsageError(`work item ${wi.id} has ${wi.tasks.length} tasks; name one: ${wi.tasks.map((t) => t.id).join(', ')}`);
    if (wi.projectId !== ctx.project.config.project) throw new UsageError(`${id} belongs to project ${wi.projectId}; run this inside that project`);
    return await act(ctx, wi, task);
  } catch (error) {
    if (error instanceof Error && !(error instanceof UsageError) && /^task .* (is|has not)/.test(error.message)) throw new UsageError(error.message);
    throw error;
  } finally {
    await ctx.close();
  }
}

/** A work item id, or a task id (found by scanning work items: fine at local scale). */
async function findTarget(repository: WorkItemRepository, store: SqliteStateStore, id: string): Promise<{ wi: WorkItem; task?: Task }> {
  if (id.startsWith('wi_')) {
    const wi = await repository.load(id);
    if (!wi) throw new UsageError(`no work item ${id}`);
    return { wi, ...(wi.tasks.length === 1 ? { task: wi.tasks[0]! } : {}) };
  }
  for (const e of await store.query({ types: ['tasks_planned'] })) {
    const planned = (e.payload as { tasks?: Array<{ taskId: string }> }).tasks ?? [];
    if (planned.some((t) => t.taskId === id)) {
      const wi = await repository.load(e.streamId);
      const task = wi?.tasks.find((t) => t.id === id);
      if (wi && task) return { wi, task };
    }
  }
  throw new UsageError(`no task or work item ${id}`);
}

// --- log ----------------------------------------------------------------------

async function log(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { full: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const [id] = positionals;
  if (!id || positionals.length > 1) throw new UsageError('log takes one run or work item id: factory log <id>');
  const store = new SqliteStateStore({ path: join(factoryHome(io), 'state.db') });
  try {
    let runIds = [id];
    if (!id.startsWith('run_')) {
      const wi = await new WorkItemRepository(store).load(id);
      if (!wi) throw new UsageError(`no run or work item ${id}`);
      runIds = wi.runs.map((r) => r.id);
    }
    let found = false;
    for (const runId of runIds) {
      const events = await store.query({ streamIds: [runId] });
      if (events.length === 0) continue;
      found = true;
      if (values.json) {
        for (const e of events) io.stdout(`${JSON.stringify(e)}\n`);
      } else {
        io.stdout(`${runIds.length > 1 || runId !== id ? `${runId}\n` : ''}${formatLog(events, { full: values.full ?? false })}\n`);
      }
    }
    if (!found) throw new UsageError(`no events for ${id}`);
    return 0;
  } finally {
    await store.close();
  }
}

// --- console ------------------------------------------------------------------

async function consoleCommand(args: string[], io: CliEnv): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: 'string' } } });
  const port = values.port === undefined ? 4747 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a port number');
  const { startConsole } = await import('./console.ts');
  // Buttons run the CLI's own commands in this directory, so they keep its rules and permissions.
  const runCommand = async (argv: string[]) => {
    let output = '';
    const code = await run(argv, { ...io, stdout: (s) => (output += s), stderr: (s) => (output += s) });
    return { code, output };
  };
  const { server, url } = await startConsole({ home: factoryHome(io), port, runCommand }, describe);
  io.stdout(`Console at ${url} (this machine only). Stop with Ctrl-C.\n`);
  await new Promise<void>((resolve) => {
    if (io.signal?.aborted) return resolve();
    io.signal?.addEventListener('abort', () => resolve(), { once: true });
    server.on('close', () => resolve());
  });
  server.close();
  return 0;
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
    ...(wi.source.id.startsWith('submitted:') ? [] : [`  issue      ${wi.source.url}`]),
    ...(wi.baseBranch ? [`  base       ${wi.baseBranch}`] : []),
    `  spent      $${(wi.spentUsd ?? 0).toFixed(2)}`,
    `  created    ${wi.createdAt}`,
    `  updated    ${wi.updatedAt}`,
  ];
  if (wi.state === 'blocked') lines.push(`  blocked    ${wi.blockedReason ?? ''}`, `  next       answer on the issue, reply /retry there, or factory resume ${wi.id}`);
  if (wi.specQuestions) {
    lines.push('', 'Questions asked');
    wi.specQuestions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
  }
  if (wi.spec) {
    lines.push('', 'Spec', `  ${wi.spec.specId} version ${wi.spec.version}, ${wi.spec.approved ? 'approved' : 'not approved yet'}`);
    if (wi.state === 'awaiting_spec_approval') lines.push(`  next  /approve or /reject <reason> on the issue, or factory approve|reject ${wi.id}`);
  }
  if (wi.proposedTasks.length > 0) {
    lines.push('', 'Proposed plan');
    for (const t of wi.proposedTasks) lines.push(`  ${t.id}  ${t.size}  ${t.title}${t.repo ? `  (in ${t.repo})` : ''}${t.dependsOn.length ? `  after ${t.dependsOn.join(', ')}` : ''}`);
    lines.push(`  next  /approve or /reject <reason> on the issue, or factory approve|reject ${wi.id}`);
  }
  lines.push('', 'Tasks');
  for (const t of wi.tasks) {
    lines.push(`  ${t.id}  ${t.state}  ${t.title}${t.repo ? `  (in ${t.repo})` : ''}`);
    if (t.dependsOn.length && t.state === 'queued') lines.push(`    after   ${t.dependsOn.join(', ')}`);
    if (t.pr) lines.push(`    pr      ${t.pr.url}`);
    if (t.branch) lines.push(`    branch  ${t.branch}`);
    if (t.protectedPaths?.length) lines.push(`    protected  ${t.protectedPaths.join(', ')} (needs a person to approve and merge)`);
    if (t.spentUsd) lines.push(`    spent   $${t.spentUsd.toFixed(2)}${t.budgetUsd ? ` (cap raised to $${t.budgetUsd.toFixed(2)})` : ''}`);
    if (t.lastReason && t.lastReason !== t.evidence?.reason) lines.push(`    reason  ${t.lastReason}`);
    if (t.reworkLoops + t.gateReworks > 0) lines.push(`    rework  ${t.reworkLoops} from verify, ${t.gateReworks} from the gate (limit ${wi.maxReworkLoops}${t.extraLoops ? ` + ${t.extraLoops} granted` : ''})`);
    if (t.evidence) {
      lines.push(`    verify  ${t.evidence.verdict} at ${t.evidence.sha.slice(0, 12)}: ${t.evidence.reason}`);
      for (const l of evidenceLines(t.evidence)) lines.push(`            ${l}`);
    }
    const next = nextStep(t);
    if (next) lines.push(`    next    ${next}`);
  }
  lines.push('', 'Runs');
  for (const r of wi.runs) {
    const agent = r.agentProfile ? `  ${r.agentProfile.agent}/${r.agentProfile.model}` : '';
    lines.push(`  ${r.id}  ${r.station}  ${r.outcome ?? 'running'}  ${r.startedAt}${agent}`);
  }
  lines.push('', 'Gates');
  for (const g of wi.gateDecisions) lines.push(`  ${g.gate}  ${g.verdict} (${g.mode}) by ${g.decidedBy}`);
  return `${lines.join('\n')}\n`;
}

function nextStep(t: Task): string | undefined {
  switch (t.state) {
    case 'ready':
      return t.changeApproved ? `merge on the pull request, or factory approve ${t.id} --merge` : `factory approve ${t.id} [--merge], or factory reject ${t.id} --reason "..."`;
    case 'escalated':
      return `factory retry ${t.id} [--note "..."]`;
    case 'queued':
      return t.dependsOn.length ? undefined : `factory resume ${t.id}`;
    case 'rework':
    case 'verifying':
      return `factory resume ${t.id}`;
    default:
      return undefined;
  }
}


// --- budget -------------------------------------------------------------------

/**
 * `factory budget [<user>]`: what a requester spent today and this month against the caps.
 * `factory budget extend <task> [--usd <n>]`: raise a paused task's cap and let it carry on.
 * `factory budget extend --user <name> --usd <n> [--month]`: raise a requester's cap for now.
 */
async function budget(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { usd: { type: 'string' }, user: { type: 'string' }, month: { type: 'boolean' }, 'no-run': { type: 'boolean' } } });
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (positionals[0] === 'extend') {
    const usd = values.usd === undefined ? 0 : Number(values.usd);
    if (!Number.isFinite(usd) || usd < 0) throw new UsageError('--usd must be an amount in dollars, 0 or more');
    if (values.user) {
      if (positionals.length > 1) throw new UsageError('budget extend takes a task id or --user, not both');
      if (usd <= 0) throw new UsageError('budget extend --user needs --usd <amount>');
      const ctx = await openProject(io);
      try {
        const period = values.month ? 'month' : 'day';
        await ctx.orchestrator.extendUserBudget({ requester: values.user, period, extraUsd: usd, by: await requester(ctx.repoRoot, io) });
        io.stdout(`Raised ${values.user}'s ${period === 'day' ? 'daily' : 'monthly'} cap by ${money(usd)} for this ${period}. Resume a paused task with factory budget extend <task>\n`);
        return 0;
      } finally {
        await ctx.close();
      }
    }
    return withTask(positionals.slice(1), 'budget extend', io, async (ctx, wi, task) => {
      const limit = await ctx.orchestrator.extendTaskBudget(ctx.project, wi.id, task.id, { by: await requester(ctx.repoRoot, io), extraUsd: usd });
      io.stdout(`${task.id} may now spend ${money(limit)} in all (${money(task.spentUsd ?? 0)} spent)\n`);
      return values['no-run'] ? 0 : continueTask(ctx, io, wi.id, task.id);
    });
  }
  if (positionals.length > 1) throw new UsageError('budget takes at most one requester name');
  const ctx = await openProject(io);
  try {
    const who = positionals[0] ?? (await requester(ctx.repoRoot, io));
    const spend = await ctx.orchestrator.spendOf(who);
    const caps = ctx.project.config.budgets;
    const line = (label: string, spent: number, cap: number | undefined, extra: number) =>
      `  ${label.padEnd(20)}${money(spent)}${cap === undefined ? '  (no cap)' : ` of ${money(cap + extra)}${extra ? ` (${money(cap)} + ${money(extra)} granted)` : ''}`}\n`;
    io.stdout(`${who}\n`);
    io.stdout(line(`today (${spend.day.key})`, spend.day.spentUsd, caps.perUserDailyUsd, spend.day.extraUsd));
    io.stdout(line(`month (${spend.month.key})`, spend.month.spentUsd, caps.perUserMonthlyUsd, spend.month.extraUsd));
    io.stdout(`  ${"per task".padEnd(20)}${money(caps.perTaskUsd)} over all attempts\n`);
    return 0;
  } finally {
    await ctx.close();
  }
}

// --- watch --------------------------------------------------------------------

/**
 * Polls each project's tracker, takes in newly labelled items and moves every open work
 * item from an issue as far as it can go. State is all in the event log, so a restart
 * carries on: runs cut off by the stop are closed, and cut-off builds build again.
 */
async function watch(args: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { once: { type: 'boolean' }, interval: { type: 'string' }, label: { type: 'string' } },
  });
  const interval = values.interval === undefined ? 60 : Number(values.interval);
  if (!Number.isFinite(interval) || interval < 1) throw new UsageError('--interval must be a number of seconds, at least 1');
  const label = values.label?.trim() || 'factory';
  const home = factoryHome(io);
  const dirs = positionals.length ? positionals.map((p) => resolve(io.cwd, p)) : [io.cwd];

  const contexts: ProjectContext[] = [];
  const release = takeWatchLock(home);
  try {
    for (const dir of dirs) {
      const ctx = await openProject(io, dir);
      contexts.push(ctx);
      if (!ctx.tracker) {
        throw new UsageError(
          `${ctx.project.config.project}: factory watch needs a tracker; set adapters.tracker in .factory/factory.yaml (${Object.keys(io.registry?.tracker ?? defaultRegistry().tracker).join(', ')})`,
        );
      }
    }
    for (const ctx of contexts) {
      for (const wi of await openFromTracker(ctx)) {
        for (const note of await ctx.orchestrator.recoverWorkItem(wi.id)) io.stdout(`${labelOf(wi)} recovered: ${note}\n`);
      }
      io.stdout(`Watching ${ctx.project.repo.id} for open issues labelled "${label}"${values.once ? ' (once)' : `, every ${interval}s`}\n`);
    }
    const waiting = new Map<string, string>();
    for (;;) {
      for (const ctx of contexts) {
        if (io.signal?.aborted) break;
        await watchCycle(ctx, label, io, waiting);
      }
      if (values.once || io.signal?.aborted) break;
      await sleep(interval * 1000, io.signal);
      if (io.signal?.aborted) break;
    }
    return 0;
  } finally {
    for (const ctx of contexts) await ctx.close();
    release();
  }
}

async function watchCycle(ctx: ProjectContext, label: string, io: CliEnv, waiting: Map<string, string>): Promise<void> {
  const tracker = ctx.tracker!;
  const project = ctx.project;
  let open: ItemRef[];
  try {
    open = await tracker.listOpen({ project: project.repo.id, labels: [label] });
  } catch (error) {
    io.stderr(`${project.repo.id}: cannot list issues: ${(error as Error).message}\n`);
    return;
  }
  for (const ref of open) {
    const { workItemId, created } = await ctx.orchestrator.receiveItem(project, ref);
    if (created) io.stdout(`${shortLabel(ref.id)} picked up as ${workItemId}\n`);
  }
  const listed = new Set(open.map((r) => r.id));
  const items = await openFromTracker(ctx);
  const work: WorkItem[] = [];
  for (const wi of items) {
    if (listed.has(wi.source.id)) {
      work.push(wi);
      continue;
    }
    // Not listed: closed (cancel the work), or the label was taken off (paused).
    const item = await tracker.getItem(wi.source).catch(() => undefined);
    if (item?.state === 'closed') {
      await ctx.orchestrator.cancelWorkItem(wi.id, 'the issue was closed');
      io.stdout(`${labelOf(wi)} cancelled: the issue was closed\n`);
    }
  }
  await pool(work, project.config.concurrency, async (wi) => {
    const prefix = labelOf(wi);
    try {
      for (const note of await ctx.orchestrator.syncWorkItem(project, wi.id)) io.stdout(`${prefix} ${note}\n`);
      const outcome = await ctx.orchestrator.runWorkItem(project, wi.id, (p) => printWorkProgress(io, prefix, p));
      const now = outcome.waitingFor ? `${outcome.state}, waiting for ${outcome.waitingFor}` : outcome.state;
      if (waiting.get(wi.id) !== now) io.stdout(`${prefix} ${now}\n`);
      waiting.set(wi.id, now);
    } catch (error) {
      io.stderr(`${prefix} stopped on an error: ${(error as Error).message}\n`);
    }
  });
}

async function openFromTracker(ctx: ProjectContext): Promise<WorkItem[]> {
  return (await ctx.orchestrator.listWorkItems(ctx.project.config.project)).filter((wi) => !wi.source.id.startsWith('submitted:') && !TERMINAL_WORK_ITEM_STATES.has(wi.state)).reverse();
}

function printWorkProgress(io: CliEnv, prefix: string, p: WorkProgress): void {
  const say = (text: string) => io.stdout(`${prefix} ${text}\n`);
  switch (p.kind) {
    case 'questions':
      return say(`the spec agent asked ${p.questions.length} question${p.questions.length > 1 ? 's' : ''} on the issue; waiting for an answer`);
    case 'spec':
      return say(`spec v${p.version}: ${p.title} (${p.criteria} acceptance criteria)`);
    case 'decided':
      return say(`${p.gate} ${p.verdict} (${p.mode}) by ${p.by}${p.verdict === 'rejected' ? `: ${p.reason}` : ''}`);
    case 'planned':
      say(`planned ${p.tasks.length} task${p.tasks.length > 1 ? 's' : ''}:`);
      for (const t of p.tasks) io.stdout(`${prefix}   ${t.id}  ${t.title}${t.dependsOn.length ? `  (after ${t.dependsOn.join(', ')})` : ''}\n`);
      return;
    case 'blocked':
      return say(`blocked: ${p.reason}`);
    case 'unblocked':
      return say(`unblocked by ${p.by}`);
    case 'task':
      return printProgress({ ...io, stdout: (text) => io.stdout(text.replace(/^(?=.)/gm, `${prefix} [${p.title}] `)) }, p.progress);
    case 'task_stopped':
      return say(`[${p.title}] ${p.outcome.state}${p.outcome.awaitingApproval ? ', ready for review' : ''}${p.outcome.pr ? `: ${p.outcome.pr.url}` : ''}${p.outcome.reason && p.outcome.state !== 'merged' ? ` (${p.outcome.reason})` : ''}`);
    case 'task_error':
      return say(`[${p.title}] error: ${p.error}`);
    case 'done':
      return;
  }
}

function labelOf(wi: WorkItem): string {
  return wi.source.id.includes('#') ? shortLabel(wi.source.id) : wi.id;
}

function shortLabel(sourceId: string): string {
  return `#${sourceId.split('#').pop()}`;
}

/** One `factory watch` per factory home: two would run the same work twice. */
function takeWatchLock(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'watch.pid');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) throw new UsageError(`another factory watch is running (pid ${pid}); stop it first`);
  }
  writeFileSync(path, `${process.pid}\n`);
  return () => rmSync(path, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
    }),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

// --- setup --------------------------------------------------------------------

interface ProjectContext {
  repoRoot: string;
  project: Project;
  orchestrator: Orchestrator;
  store: SqliteStateStore;
  repository: WorkItemRepository;
  tracker?: Tracker;
  close(): Promise<void>;
}

async function openProject(io: CliEnv, dir: string = io.cwd): Promise<ProjectContext> {
  const repoRoot = findProjectRoot(dir);
  if (!repoRoot) throw new UsageError(`no .factory/factory.yaml in ${dir} or any folder above it`);
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

  const repoOf = async (root: string) => {
    const remote = await gitOutput(['remote', 'get-url', 'origin'], root).catch(() => '');
    if (!remote) throw new UsageError(`${root} has no "origin" remote`);
    const repo = scmEntry.repoFromRemote(remote);
    if (!repo) throw new UsageError(`origin ${remote} of ${root} is not a ${config.adapters.scm} repository`);
    return repo;
  };
  const repo = await repoOf(repoRoot);

  // Related repositories: other projects the planner may give tasks to, on the same source control.
  const related: Record<string, Project> = {};
  for (const path of config.relatedRepos) {
    const root = findProjectRoot(resolve(repoRoot, path));
    if (!root || root === repoRoot) throw new UsageError(`related_repos: ${path} has no .factory/factory.yaml`);
    const relatedConfig = loadProjectConfig(root);
    if (relatedConfig.adapters.scm !== config.adapters.scm) throw new UsageError(`related_repos: ${path} uses scm "${relatedConfig.adapters.scm}"; it must match "${config.adapters.scm}"`);
    if (relatedConfig.project === config.project || related[relatedConfig.project]) throw new UsageError(`related_repos: project name "${relatedConfig.project}" is used twice`);
    related[relatedConfig.project] = { repo: await repoOf(root), config: relatedConfig };
  }

  const trackerEntry = registry.tracker[config.adapters.tracker];
  let tracker: Tracker | undefined;
  if (trackerEntry && trackerEntry.scm.includes(config.adapters.scm)) tracker = trackerEntry.create();

  if (registry.testOnlySandboxes.has(config.adapters.sandbox)) {
    io.stderr(`warning: sandbox "${config.adapters.sandbox}" is for testing only and does not isolate the agent\n`);
  }

  const sandbox = makeSandbox(home);
  let runtime: AgentRuntime;
  try {
    runtime = makeRuntime({ sandbox, env: io.env });
    // Set up every agent the config names now, so a missing credential is reported here,
    // not part way through a run.
    if (runtime instanceof AgentsByName) {
      const agents = new Set([config.runtime.agent, ...Object.values(config.runtime.roles).flatMap((r) => (r?.agent ? [r.agent] : [])), ...(config.verify.agentChecks ?? []).flatMap((c) => (c.agent ? [c.agent] : []))]);
      for (const agent of agents) {
        if (!runtime.runtimeFor(agent)) throw new Error(`no agent "${agent}" (known: ${runtime.agents.join(', ')})`);
      }
    }
  } catch (error) {
    throw new UsageError(`cannot set up runtime "${config.adapters.runtime}": ${(error as Error).message}`);
  }
  const ciEntry = registry.ci[config.adapters.ci];
  let ci: CI | undefined;
  if (ciEntry && ciEntry.scm.includes(config.adapters.scm)) ci = ciEntry.create();
  else if (config.adapters.ci !== 'none') io.stderr(`warning: CI "${config.adapters.ci}" does not build ${config.adapters.scm} repositories; Verify runs without CI\n`);
  const store = new SqliteStateStore({ path: join(home, 'state.db') });
  const orchestrator = new Orchestrator({
    store,
    sourceControl: scmEntry.create(),
    sandbox,
    runtime,
    ...(ci ? { ci } : {}),
    ...(tracker ? { tracker } : {}),
    hardRules: { protectedPaths: KNOWN_CI_PATHS, secretPatterns: KNOWN_SECRET_PATTERNS, deniedCommands: DENIED_COMMANDS },
    workRoot: join(home, 'work'),
  });
  const project: Project = { repo, config, ...(Object.keys(related).length ? { related } : {}) };
  return { repoRoot, project, orchestrator, store, repository: new WorkItemRepository(store), ...(tracker ? { tracker } : {}), close: () => store.close() };
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

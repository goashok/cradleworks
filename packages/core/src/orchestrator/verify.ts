// The Verify station's parts (Build spec, section 8): the project's own checks run in a
// fresh sandbox, CI on the pushed commit, and a reviewer agent. Each part reports a
// result; `combine` turns them into one verdict. Nothing here names a vendor.

import type { CI, CIRunRef, CIRunStatus, RepoRef, Sandbox, SandboxHandle } from '@cradleworks/interfaces';
import type { ProjectConfig } from '../config/types.ts';
import type { CheckResult, CiResult, Evidence, ReviewResult, VerifyVerdict } from '../domain/types.ts';

export const OUTPUT_TAIL_LINES = 60;
const MAX_TAIL_CHARS = 6000;

export interface CheckOptions {
  /** Per command. Default 20 minutes. */
  timeoutSeconds?: number;
}

/** Build first, then lint, test and the project's other commands, in file order. */
export function orderedCommands(config: ProjectConfig): Array<[string, string]> {
  const entries = Object.entries(config.stack.commands).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  const rank = (name: string) => (name === 'build' ? 0 : name === 'lint' ? 1 : name === 'test' ? 2 : 3);
  return entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e[0]) - rank(b.e[0]) || a.i - b.i).map(({ e }) => e);
}

/**
 * Runs every stack command. A failed build skips the rest: nothing after it means anything.
 * A failing command other than build runs once more; passing then marks it flaky, which
 * the reviewer and the evidence report but which does not send the task back.
 */
export async function runChecks(sandbox: Sandbox, handle: SandboxHandle, config: ProjectConfig, options: CheckOptions = {}): Promise<CheckResult[]> {
  const timeoutSeconds = options.timeoutSeconds ?? 1200;
  const results: CheckResult[] = [];
  let buildFailed = false;
  for (const [name, command] of orderedCommands(config)) {
    if (buildFailed) {
      results.push({ name, command, outcome: 'skipped', durationMs: 0 });
      continue;
    }
    let result = await runOne(sandbox, handle, name, command, timeoutSeconds);
    if (result.outcome === 'failed' && name !== 'build') {
      const again = await runOne(sandbox, handle, name, command, timeoutSeconds);
      if (again.outcome === 'passed') result = { ...again, durationMs: result.durationMs + again.durationMs, flaky: true, ...(result.outputTail !== undefined ? { outputTail: result.outputTail } : {}) };
    }
    results.push(result);
    if (name === 'build' && result.outcome !== 'passed') buildFailed = true;
  }
  return results;
}

async function runOne(sandbox: Sandbox, handle: SandboxHandle, name: string, command: string, timeoutSeconds: number): Promise<CheckResult> {
  const r = await sandbox.exec(handle, ['sh', '-c', command], { timeoutSeconds });
  const outcome: CheckResult['outcome'] = r.timedOut ? 'timed_out' : r.exitCode === 0 ? 'passed' : 'failed';
  return {
    name,
    command,
    outcome,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    ...(outcome !== 'passed' ? { outputTail: tail(`${r.stdout}\n${r.stderr}`, OUTPUT_TAIL_LINES) } : {}),
  };
}

export function tail(text: string, lines: number): string {
  const kept = text.trimEnd().split('\n').slice(-lines).join('\n');
  return kept.length > MAX_TAIL_CHARS ? kept.slice(-MAX_TAIL_CHARS) : kept;
}

// --- CI --------------------------------------------------------------------------

export interface CiWaitOptions {
  /** How long to wait for a run to appear for the commit. Default 3 minutes. */
  appearSeconds?: number;
  /** How long to wait for runs to finish. Default 20 minutes. */
  finishSeconds?: number;
  /** Poll interval. Default 15 seconds. */
  pollSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Stops waiting; the result is then `skipped`. */
  signal?: AbortSignal;
}

const CI_DONE = new Set(['passed', 'failed', 'cancelled', 'error']);

/** Waits for every CI run on `sha`. No runs within `appearSeconds` means the project has none for this commit. */
export async function waitForCi(ci: CI | undefined, repo: RepoRef, sha: string, options: CiWaitOptions = {}): Promise<CiResult> {
  if (!ci) return { state: 'not_configured', runs: [] };
  const signal = options.signal;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const timer = setTimeout(r, ms);
        signal?.addEventListener('abort', () => (clearTimeout(timer), r()), { once: true });
      }));
  const stopped = (): CiResult | undefined => (signal?.aborted ? { state: 'skipped', runs: [], note: 'stopped waiting' } : undefined);
  const poll = (options.pollSeconds ?? 15) * 1000;
  const start = Date.now();
  const appearBy = start + (options.appearSeconds ?? 180) * 1000;
  const finishBy = start + (options.finishSeconds ?? 1200) * 1000;
  try {
    let refs: CIRunRef[] = [];
    for (;;) {
      const halt = stopped();
      if (halt) return halt;
      refs = await ci.findRuns(repo, sha);
      if (refs.length > 0 || Date.now() >= appearBy) break;
      await sleep(poll);
    }
    if (refs.length === 0) return { state: 'none', runs: [], note: `no CI run started for ${sha.slice(0, 12)}` };

    let statuses: CIRunStatus[];
    for (;;) {
      const halt = stopped();
      if (halt) return halt;
      statuses = await Promise.all(refs.map((r) => ci.getRunStatus(r)));
      if (statuses.every((s) => CI_DONE.has(s.state))) break;
      if (Date.now() >= finishBy) {
        return { state: 'timed_out', runs: statuses.map(runSummary), note: `CI still running after ${Math.round((finishBy - start) / 60000)} minutes` };
      }
      await sleep(poll);
      // Runs can start late (a second workflow); pick them up while waiting.
      const latest = await ci.findRuns(repo, sha);
      if (latest.length > refs.length) refs = latest;
    }

    const failed = statuses.filter((s) => s.state !== 'passed');
    if (failed.length === 0) return { state: 'passed', runs: statuses.map(runSummary) };
    const logs: string[] = [];
    for (const s of failed) {
      for (const job of s.jobs.filter((j) => j.state === 'failed').slice(0, 3)) {
        const log = await ci.getLogs(s.ref, { job: job.name, tailLines: OUTPUT_TAIL_LINES }).catch((e: unknown) => `(log unavailable: ${(e as Error).message})`);
        logs.push(`### ${job.name}\n${tail(log, OUTPUT_TAIL_LINES)}`);
      }
    }
    return { state: 'failed', runs: statuses.map(runSummary), ...(logs.length ? { failureLogs: logs.join('\n\n') } : {}) };
  } catch (error) {
    return { state: 'error', runs: [], note: `CI could not be read: ${(error as Error).message}` };
  }
}

function runSummary(s: CIRunStatus): CiResult['runs'][number] {
  return { id: s.ref.id, url: s.ref.url, state: s.state, failedJobs: s.jobs.filter((j) => j.state === 'failed').map((j) => j.name) };
}

// --- reviewer ----------------------------------------------------------------------

const UNREADABLE = "The reviewer's verdict could not be read";

/** Added to the reviewer's input when its first verdict couldn't be read. */
export const REVIEW_RETRY_NOTE =
  'Your previous review ended without a verdict that could be read. Review the change again, and end your final message with the JSON object: {"verdict": "pass" | "rework" | "escalate", "risk": "low" | "medium" | "high", "reasons": [...]}.';

export const isUnreadableReview = (r: ReviewResult) => r.verdict === 'escalate' && r.reasons.length === 1 && r.reasons[0]!.startsWith(UNREADABLE);

/**
 * Reads the reviewer's verdict: the last JSON object in its final message, with a
 * `verdict` of pass, rework or escalate. Anything unreadable is an escalation, never a pass.
 */
export function parseReview(text: string | undefined, model: string): ReviewResult {
  const unreadable = (why: string): ReviewResult => ({ verdict: 'escalate', risk: 'high', reasons: [`${UNREADABLE}: ${why}.`], model });
  if (!text || text.trim() === '') return unreadable('it gave no final message');
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  const braces = lastJsonObject(text);
  if (braces) candidates.push(braces);
  for (const raw of candidates.reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const v = value as { verdict?: unknown; risk?: unknown; reasons?: unknown };
    if (v.verdict !== 'pass' && v.verdict !== 'rework' && v.verdict !== 'escalate') continue;
    const risk = v.risk === 'low' || v.risk === 'medium' || v.risk === 'high' ? v.risk : 'medium';
    const reasons = Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim()) : [];
    if (v.verdict !== 'pass' && reasons.length === 0) reasons.push('The reviewer gave no reason.');
    return { verdict: v.verdict, risk, reasons, model };
  }
  return unreadable('no JSON object with a verdict was found');
}

/**
 * The last JSON object in an agent's final message that `accept` takes: fenced blocks
 * first, then the last balanced {…}. Undefined when there is none.
 */
export function extractJson<T>(text: string | undefined, accept: (value: Record<string, unknown>) => T | undefined): T | undefined {
  if (!text) return undefined;
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  const braces = lastJsonObject(text);
  if (braces) candidates.push(braces);
  for (const raw of candidates.reverse()) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const accepted = accept(value as Record<string, unknown>);
        if (accepted !== undefined) return accepted;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function lastJsonObject(text: string): string | undefined {
  const end = text.lastIndexOf('}');
  if (end < 0) return undefined;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{' && --depth === 0) return text.slice(i, end + 1);
  }
  return undefined;
}

// --- verdict ------------------------------------------------------------------------

/** Checks and CI decide first; the reviewer decides only a change that builds and passes. */
export function combine(checks: CheckResult[], ci: CiResult, review: ReviewResult | undefined): { verdict: VerifyVerdict; reason: string } {
  const failedChecks = checks.filter((c) => c.outcome === 'failed' || c.outcome === 'timed_out');
  if (failedChecks.length > 0) return { verdict: 'rework', reason: `check${failedChecks.length > 1 ? 's' : ''} failed: ${failedChecks.map((c) => c.name).join(', ')}` };
  if (ci.state === 'failed') {
    const jobs = ci.runs.flatMap((r) => r.failedJobs);
    return { verdict: 'rework', reason: `CI failed${jobs.length ? `: ${jobs.join(', ')}` : ''}` };
  }
  if (ci.state === 'timed_out' || ci.state === 'error') return { verdict: 'escalate', reason: ci.note ?? `CI ${ci.state}` };
  if (!review) return { verdict: 'escalate', reason: 'the reviewer did not run' };
  if (review.verdict === 'pass' && review.risk === 'high') return { verdict: 'escalate', reason: 'the reviewer passed the change but rated it high risk' };
  const first = review.reasons[0];
  if (review.verdict === 'pass') return { verdict: 'pass', reason: `checks passed, CI ${ciWord(ci)}, reviewer passed (${review.risk} risk)` };
  return { verdict: review.verdict, reason: `reviewer: ${first ?? review.verdict}` };
}

function ciWord(ci: CiResult): string {
  return ci.state === 'passed' ? 'passed' : ci.state === 'none' ? 'not run for this commit' : 'not configured';
}

// --- feedback and evidence -------------------------------------------------------------

/** What the implementer is told when its change comes back. */
export function reworkFeedback(evidence: Evidence | undefined, gateReason: string | undefined, attempt: number, acceptance?: { files: string[]; patch: string }): string {
  const parts = [`## Rework (attempt ${attempt})`, '', 'Your earlier change on this branch was sent back. The branch already has those commits; change what is needed to address every point below, then run the build and tests again.'];
  if (gateReason) parts.push('', '### From the reviewer at the change gate', gateReason);
  if (evidence) {
    for (const c of evidence.checks.filter((c) => c.outcome === 'failed' || c.outcome === 'timed_out')) {
      parts.push('', `### Check \`${c.name}\` ${c.outcome === 'timed_out' ? 'timed out' : `failed (exit ${c.exitCode ?? '?'})`}`, `Command: \`${c.command}\``, '```text', c.outputTail ?? '', '```');
    }
    if (acceptance && evidence.checks.some((c) => c.name === 'acceptance' && (c.outcome === 'failed' || c.outcome === 'timed_out'))) {
      const patch = acceptance.patch.length > 12_000 ? `${acceptance.patch.slice(0, 12_000)}\n… (cut)` : acceptance.patch;
      parts.push(
        '',
        '### The acceptance tests',
        `A separate tester agent wrote these tests from the spec's acceptance criteria, without seeing your change (${acceptance.files.map((f) => `\`${f}\``).join(', ')}). They are not in your branch: make the behaviour they check work. If a test is plainly wrong about the spec, say so in your summary instead of working around it.`,
        '```diff',
        patch,
        '```',
      );
    }
    if (evidence.ci.state === 'failed') parts.push('', '### CI failed', '```text', evidence.ci.failureLogs ?? '(no log)', '```');
    if (evidence.review && evidence.review.verdict !== 'pass') parts.push('', '### Reviewer', ...evidence.review.reasons.map((r) => `- ${r}`));
  }
  return parts.join('\n');
}

const ICON: Record<CheckResult['outcome'], string> = { passed: '✅', failed: '❌', timed_out: '⏱️', skipped: '⏭️' };

/** The evidence as a pull request comment. */
export function evidenceMarkdown(evidence: Evidence, attempt: number): string {
  const verdict = { pass: '✅ Passed', rework: '🔁 Sent back for rework', escalate: '🙋 Needs a human' }[evidence.verdict];
  const lines = [`## Cradleworks verification: ${verdict}`, '', `Commit \`${evidence.sha.slice(0, 12)}\` · attempt ${attempt} · ${evidence.reason}`, '', '| Check | Result | Time |', '| --- | --- | --- |'];
  for (const c of evidence.checks) {
    lines.push(`| \`${c.name}\` | ${ICON[c.outcome]} ${c.outcome.replace('_', ' ')}${c.flaky ? ' (flaky: passed on a second run)' : ''} | ${(c.durationMs / 1000).toFixed(0)} s |`);
  }
  const ci = evidence.ci;
  const ciText =
    ci.state === 'not_configured' ? 'not configured' : ci.state === 'none' ? (ci.note ?? 'no runs') : `${ci.state}${ci.runs.length ? ': ' + ci.runs.map((r) => `[${r.state}](${r.url})`).join(', ') : ''}${ci.note ? ` (${ci.note})` : ''}`;
  lines.push(`| CI | ${ci.state === 'passed' ? '✅' : ci.state === 'failed' ? '❌' : '➖'} ${ciText} | |`);
  if (evidence.review) {
    const r = evidence.review;
    lines.push('', `### Reviewer (${r.model}): ${r.verdict}, ${r.risk} risk`, ...(r.reasons.length ? r.reasons.map((x) => `- ${x}`) : ['- No concerns.']));
  }
  for (const c of evidence.checks.filter((c) => c.outcome === 'failed' || c.outcome === 'timed_out')) {
    lines.push('', `<details><summary>${c.name} output</summary>`, '', '```text', c.outputTail ?? '', '```', '</details>');
  }
  lines.push('', `_Verify run \`${evidence.runId}\` · $${evidence.costUsd.toFixed(4)} · replay with \`factory log ${evidence.runId}\`_`);
  return lines.join('\n');
}

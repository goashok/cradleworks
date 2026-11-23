// `factory drill`: hands the reviewer and each agent check changes whose verdict is known, from
// `.factory/drill/`, and says whether each was judged right. A check that can't send back a
// change it should is worse than none: it looks like protection. So a blocking agent check runs
// as advisory until it has known-bad cases, and this is how a team sees they still work after a
// change to a skill, a prompt addition or a model.
//
// The rule is the one the factory's own reviewer drill uses: a known-bad case counts as missed
// only if it passed every time it ran (a pass gets one confirmation run, since one pass of a
// noisy judge says little), the drill flags a missed case or more than half the controls sent
// back, and a run that gives no verdict makes it inconclusive, never a pass.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { advisoryReason, caseTask, CONTROLS, DRILL_DIR, drillCases, KNOWN_MISSES, parseKnownMisses, type DrillCase, type Project, type ProjectConfig } from '@cradleworks/core';

export interface DrillIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type Review = (input: { title: string; description: string; patch: string; base?: string; check?: string }) => Promise<{
  runId: string;
  review?: { verdict: string; risk: string; reasons: string[]; model: string };
  stop?: string;
  error?: string;
  cost: number;
}>;

const REVIEWER = 'reviewer';

function drillPaths(repoRoot: string): string[] {
  const dir = join(repoRoot, DRILL_DIR);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(repoRoot, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

/** What `factory validate` says about `.factory/drill/`. */
export function checkDrill(repoRoot: string, config: ProjectConfig): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const paths = drillPaths(repoRoot);
  const cases = drillCases(paths);
  const checks = config.verify.agentChecks ?? [];
  const groups = new Set([REVIEWER, CONTROLS, ...checks.map((c) => c.name)]);
  for (const group of new Set(cases.map((c) => c.group))) {
    if (!groups.has(group)) problems.push(`${DRILL_DIR}/${group}/ is not for the reviewer, the controls or an agent check (checks: ${checks.map((c) => c.name).join(', ') || 'none'})`);
  }
  for (const c of cases) if (!c.taskPath) notes.push(`${c.patchPath} has no ${c.name}.md beside it, so the change is judged against its file name alone`);
  for (const check of checks) {
    const why = advisoryReason(check, paths);
    if (why) notes.push(`verify.agent_checks.${check.name} is set to block, but has ${why}, so it runs as advisory`);
  }
  const misses = parseKnownMisses(existsSync(join(repoRoot, KNOWN_MISSES)) ? readFileSync(join(repoRoot, KNOWN_MISSES), 'utf8') : undefined);
  for (const id of misses.keys()) if (!cases.some((c) => `${c.group}/${c.name}` === id)) notes.push(`${KNOWN_MISSES} names ${id}, which is not a drill case`);
  return { problems, notes };
}

interface CaseResult {
  target: string;
  case: string;
  kind: 'known-bad' | 'control';
  /** right, wrong, or no verdict. */
  outcome: 'right' | 'wrong' | 'inconclusive';
  /** Reported but not counted, from known-misses.txt. */
  knownMiss?: string;
  verdicts: string[];
  reason?: string;
  cost: number;
  runIds: string[];
}

export async function runDrill(repoRoot: string, project: Project, review: Review, io: DrillIo, opts: { check?: string; base?: string; json: boolean }): Promise<number> {
  const paths = drillPaths(repoRoot);
  const cases = drillCases(paths);
  const checks = project.config.verify.agentChecks ?? [];
  const known = new Set([REVIEWER, ...checks.map((c) => c.name)]);
  if (opts.check && !known.has(opts.check)) {
    io.stderr(`factory drill: no agent check "${opts.check}" (checks: ${checks.map((c) => c.name).join(', ') || 'none'}; or reviewer)\n`);
    return 2;
  }
  // The reviewer joins when it has cases of its own or is asked for; every check always does.
  const targets = [
    ...(opts.check === REVIEWER || (!opts.check && cases.some((c) => c.group === REVIEWER)) ? [REVIEWER] : []),
    ...checks.filter((c) => !opts.check || c.name === opts.check).map((c) => c.name),
  ];
  const controls = cases.filter((c) => c.group === CONTROLS);
  if (!targets.length || !cases.some((c) => targets.includes(c.group)) && !controls.length) {
    io.stderr(`factory drill: no drill cases in ${DRILL_DIR}/ for ${targets.join(', ') || 'the reviewer'}. Add <check>/<case>.patch (a change it must send back) and ${CONTROLS}/<case>.patch (one every check must pass), each with a .md of the task.\n`);
    return 2;
  }
  const misses = parseKnownMisses(existsSync(join(repoRoot, KNOWN_MISSES)) ? readFileSync(join(repoRoot, KNOWN_MISSES), 'utf8') : undefined);
  const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

  const once = async (target: string, c: DrillCase) => {
    const task = caseTask(c.name, c.taskPath ? read(c.taskPath) : undefined);
    const r = await review({ ...task, patch: read(c.patchPath), ...(opts.base ? { base: opts.base } : {}), ...(target === REVIEWER ? {} : { check: target }) });
    return { verdict: r.review?.verdict, reason: r.review ? r.review.reasons[0] : (r.stop ?? r.error), cost: r.cost, runId: r.runId };
  };

  const results: CaseResult[] = [];
  for (const target of targets) {
    const advisory = target === REVIEWER ? undefined : advisoryReason(checks.find((c) => c.name === target)!, paths);
    if (advisory) io.stdout(`${target}: set to block, but has ${advisory}, so Verify runs it as advisory\n`);
    for (const [kind, list] of [['known-bad', cases.filter((c) => c.group === target)], ['control', controls]] as const) {
      for (const c of list) {
        const runs = [await once(target, c)];
        // One pass of a known-bad case says little about a noisy judge: confirm it.
        if (kind === 'known-bad' && runs[0]!.verdict === 'pass') runs.push(await once(target, c));
        const last = runs.at(-1)!;
        const outcome: CaseResult['outcome'] = runs.some((r) => !r.verdict)
          ? 'inconclusive'
          : kind === 'known-bad'
            ? runs.every((r) => r.verdict === 'pass') ? 'wrong' : 'right'
            : last.verdict === 'pass' ? 'right' : 'wrong';
        const id = `${c.group}/${c.name}`;
        const result: CaseResult = {
          target,
          case: id,
          kind,
          outcome,
          verdicts: runs.map((r) => r.verdict ?? 'none'),
          ...(last.reason ? { reason: last.reason } : {}),
          cost: runs.reduce((a, r) => a + r.cost, 0),
          runIds: runs.map((r) => r.runId),
          ...(kind === 'known-bad' && misses.has(id) ? { knownMiss: misses.get(id) ?? '' } : {}),
        };
        results.push(result);
        if (!opts.json) {
          const word = outcome === 'right' ? 'right' : outcome === 'wrong' ? 'WRONG' : 'no verdict';
          io.stdout(`${target} on ${id}: ${word}  ${result.verdicts.join(', then ')}  $${result.cost.toFixed(2)}${result.knownMiss !== undefined ? '  (known miss, not counted)' : ''}${result.reason ? `  ${result.reason.slice(0, 160)}` : ''}\n`);
        }
      }
    }
  }

  const flagged: string[] = [];
  for (const target of targets) {
    const bad = results.filter((r) => r.target === target && r.kind === 'known-bad' && r.knownMiss === undefined);
    const ctl = results.filter((r) => r.target === target && r.kind === 'control');
    const missed = bad.filter((r) => r.outcome === 'wrong');
    const sentBack = ctl.filter((r) => r.outcome === 'wrong');
    if (missed.length) flagged.push(`${target} missed ${missed.map((r) => r.case).join(', ')}`);
    if (ctl.length && sentBack.length * 2 > ctl.length) flagged.push(`${target} sent back ${sentBack.length} of ${ctl.length} controls`);
    if (!opts.json) io.stdout(`${target}: sent back ${bad.length - missed.length} of ${bad.length} known-bad, passed ${ctl.length - sentBack.length} of ${ctl.length} controls\n`);
  }
  const inconclusive = results.filter((r) => r.outcome === 'inconclusive');
  const code = flagged.length ? 1 : inconclusive.length ? 3 : 0;
  const total = results.reduce((a, r) => a + r.cost, 0);
  if (opts.json) io.stdout(`${JSON.stringify({ code, flagged, results, costUsd: total })}\n`);
  else {
    io.stdout(`$${total.toFixed(2)} in all.\n`);
    if (flagged.length) io.stdout(`Flagged: ${flagged.join('; ')}.\n`);
    else if (inconclusive.length) io.stdout(`Inconclusive: no verdict on ${inconclusive.map((r) => `${r.target} on ${r.case}`).join(', ')}.\n`);
    else io.stdout('Every case judged right.\n');
  }
  return code;
}

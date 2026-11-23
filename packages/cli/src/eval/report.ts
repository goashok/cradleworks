// Reading eval results: one run's score, and a variant against the factory as it is.
//
// The same factory scores differently from run to run: agents are not deterministic. So a
// comparison needs the base run at least twice to see how far it moves on its own (the noise
// band), and a variant counts as better or worse only when its score lands outside that band.
// Inside it, the run says nothing either way, however different the numbers look.

import type { EvalResult } from './run.ts';

export interface RunSummary {
  file: string;
  label: string;
  variant: string | null;
  tasks: number;
  passed: number;
  costUsd: number;
  medianMinutes: number;
  errors: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summarize(file: string, results: EvalResult[]): RunSummary {
  return {
    file,
    label: results[0]?.label ?? '',
    variant: results[0]?.variant?.name ?? null,
    tasks: results.length,
    passed: results.filter((r) => r.passed).length,
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    medianMinutes: Math.round(median(results.map((r) => r.durationSeconds)) / 6) / 10,
    errors: results.filter((r) => r.error).length,
  };
}

export interface Comparison {
  tasks: string[];
  /** Tasks some runs had and others didn't; left out of the scores. */
  leftOut: string[];
  base: RunSummary[];
  variant: RunSummary[];
  /** min and max of the base scores; undefined with fewer than two base runs. */
  band?: [number, number];
  verdict: 'better' | 'worse' | 'within the noise' | 'unknown';
  perTask: Array<{ task: string; base: string; variant: string; moved: 'better' | 'worse' | '' }>;
}

/** Scores over the tasks every run has, so runs of different sets don't mislead. */
export function compare(base: Array<{ file: string; results: EvalResult[] }>, variant: Array<{ file: string; results: EvalResult[] }>): Comparison {
  const all = [...base, ...variant];
  const sets = all.map((r) => new Set(r.results.map((x) => x.task)));
  const union = [...new Set(all.flatMap((r) => r.results.map((x) => x.task)))].sort();
  const tasks = union.filter((t) => sets.every((s) => s.has(t)));
  const leftOut = union.filter((t) => !tasks.includes(t));
  const only = (r: { file: string; results: EvalResult[] }) => summarize(r.file, r.results.filter((x) => tasks.includes(x.task)));
  const b = base.map(only);
  const v = variant.map(only);
  const band: [number, number] | undefined = b.length >= 2 ? [Math.min(...b.map((s) => s.passed)), Math.max(...b.map((s) => s.passed))] : undefined;
  let verdict: Comparison['verdict'] = 'unknown';
  if (band && v.length) {
    const scores = v.map((s) => s.passed);
    verdict = scores.every((s) => s > band[1]) ? 'better' : scores.every((s) => s < band[0]) ? 'worse' : 'within the noise';
  }
  const ratio = (runs: Array<{ results: EvalResult[] }>, task: string) => {
    const got = runs.map((r) => r.results.find((x) => x.task === task)?.passed ?? false);
    return { text: `${got.filter(Boolean).length}/${got.length}`, rate: got.filter(Boolean).length / Math.max(1, got.length) };
  };
  const perTask = tasks.map((task) => {
    const bb = ratio(base, task);
    const vv = ratio(variant, task);
    // A task moved only when it went from always to never, or the other way.
    const moved = bb.rate === 0 && vv.rate === 1 ? 'better' : bb.rate === 1 && vv.rate === 0 ? 'worse' : '';
    return { task, base: bb.text, variant: vv.text, moved: moved as 'better' | 'worse' | '' };
  });
  return { tasks, leftOut, base: b, variant: v, ...(band ? { band } : {}), verdict, perTask };
}

const money = (n: number) => `$${n.toFixed(2)}`;

export function formatSummary(s: RunSummary): string {
  return `${s.label || s.file}: ${s.passed} of ${s.tasks} passed${s.variant ? ` (variant ${s.variant})` : ''}, ${money(s.costUsd)}, median ${s.medianMinutes} min per task${s.errors ? `, ${s.errors} could not run` : ''}`;
}

export function formatComparison(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`Over the ${c.tasks.length} task(s) every run has${c.leftOut.length ? ` (left out, not in every run: ${c.leftOut.join(', ')})` : ''}:`);
  lines.push('', 'Factory as configured:');
  for (const s of c.base) lines.push(`  ${formatSummary(s)}`);
  lines.push('With the variant:');
  for (const s of c.variant) lines.push(`  ${formatSummary(s)}`);
  lines.push('');
  if (!c.band) lines.push('No noise band: run the factory as configured at least twice on the same tasks, so the comparison can tell a change from chance.');
  else {
    lines.push(`Noise band: the factory as configured scored ${c.band[0] === c.band[1] ? `${c.band[0]}` : `${c.band[0]} to ${c.band[1]}`} of ${c.tasks.length}.`);
    lines.push(
      c.verdict === 'better'
        ? 'Verdict: better. Every variant run scored above the band.'
        : c.verdict === 'worse'
          ? 'Verdict: worse. Every variant run scored below the band.'
          : c.verdict === 'within the noise'
            ? "Verdict: within the noise. The variant's score is inside the band (or its runs disagree), so this says nothing either way. Keep the change only for another reason, or measure on more tasks."
            : 'Verdict: unknown. There are no variant runs.',
    );
    const ceiling = c.band[0] === c.tasks.length && c.variant.every((s) => s.passed === c.tasks.length);
    const floor = c.band[1] === 0 && c.variant.every((s) => s.passed === 0);
    if (ceiling) lines.push('Every run passed every task: these tasks are too easy to tell the two apart. Add harder ones.');
    if (floor) lines.push('No run passed any task: these tasks are too hard to tell the two apart, or the grading is broken (try factory eval check).');
    const bCost = c.base.reduce((a, s) => a + s.costUsd, 0) / Math.max(1, c.base.length);
    const vCost = c.variant.reduce((a, s) => a + s.costUsd, 0) / Math.max(1, c.variant.length);
    if (c.variant.length) lines.push(`Cost per run: ${money(bCost)} as configured, ${money(vCost)} with the variant.`);
  }
  const moved = c.perTask.filter((t) => t.moved);
  lines.push('', 'Per task (passed / runs):', ...c.perTask.map((t) => `  ${t.task}  ${t.base} as configured, ${t.variant} with the variant${t.moved ? `  ← ${t.moved}` : ''}`));
  if (moved.length && c.verdict === 'within the noise') lines.push('', 'A task that moved is worth a look, but one task moving is not evidence on its own.');
  return lines.join('\n');
}

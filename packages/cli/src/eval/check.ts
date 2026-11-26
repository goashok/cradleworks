// Checks a task before it measures anything: its hidden tests must fail at the base commit (or
// pass, for a refactor marked `expect_base: pass`), pass with the reference solution, and fail
// with each wrong solution. A task whose tests pass at the base measures nothing; one whose tests
// fail with the reference solution counts every right answer as wrong.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectConfig } from '@cradleworks/config';
import { applyPatch, checkoutAt, gradeCheckout, type Runner } from './grade.ts';
import { defaultCommand, runnerFor } from './run.ts';
import { loadTask, type Suite } from './suite.ts';
import { overlaySettings } from './variant.ts';

export interface CheckLine {
  task: string;
  /** `base`, `solution` or `wrong/<file>`. */
  case: string;
  expected: 'pass' | 'fail';
  got: 'pass' | 'fail' | 'error';
  reason: string;
  ok: boolean;
}

export async function checkTasks(suite: Suite, ids: string[], workDir: string, log: (l: CheckLine) => void, runner?: Runner): Promise<CheckLine[]> {
  const out: CheckLine[] = [];
  for (const id of ids) {
    const task = loadTask(suite, id);
    const cases: Array<{ name: string; patch?: string; expected: 'pass' | 'fail' }> = [
      { name: 'base', expected: task.expectBase },
      ...(task.solution ? [{ name: 'solution', patch: task.solution, expected: 'pass' as const }] : []),
      ...task.wrong.map((p) => ({ name: `wrong/${p.split('/').pop()}`, patch: p, expected: 'fail' as const })),
    ];
    if (!task.solution) {
      const line: CheckLine = { task: id, case: 'solution', expected: 'pass', got: 'error', reason: 'no solution.patch: a task needs a reference solution to show its tests can pass', ok: false };
      out.push(line);
      log(line);
    }
    for (const c of cases) {
      const dir = join(workDir, id, c.name.replace(/[^a-z0-9.-]+/gi, '_'));
      let line: CheckLine;
      try {
        mkdirSync(join(workDir, id), { recursive: true });
        checkoutAt(suite.repo, task.baseCommit, dir);
        if (suite.settingsFrom) overlaySettings(join(dir, '.git'), suite.settingsFrom, dir);
        if (c.patch) applyPatch(dir, c.patch);
        const config = loadProjectConfig(dir);
        const r = await gradeCheckout({
          task,
          dir,
          command: task.grade.command ?? defaultCommand(config),
          image: task.grade.image ?? config.stack.image,
          runner: runnerFor(config, runner),
          cacheDir: join(workDir, '.grade-cache'),
        });
        line = { task: id, case: c.name, expected: c.expected, got: r.verdict, reason: r.reason, ok: r.verdict === c.expected };
      } catch (error) {
        line = { task: id, case: c.name, expected: c.expected, got: 'error', reason: (error as Error).message.split('\n')[0] ?? '', ok: false };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      out.push(line);
      log(line);
    }
  }
  return out;
}

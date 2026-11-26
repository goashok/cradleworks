// `factory eval`: measure the factory on a suite of tasks with known answers.

import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tokenProviderFromEnv } from '@cradleworks/adapter-github';
import { checkTasks } from './check.ts';
import { githubPulls, githubRepoOf, mine } from './mine.ts';
import { compare, formatComparison, formatSummary, summarize } from './report.ts';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { ATTEMPT_JSON, ATTEMPT_PATCH, attemptTask, factoryCommit, gradeAttempt, readResults, runEval, type AttemptResult, type FactoryCall } from './run.ts';
import { loadTask } from './suite.ts';
import { loadSuite, selectTasks } from './suite.ts';
import { loadVariant } from './variant.ts';
import type { Runner } from './grade.ts';

export interface EvalIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `factory eval run <suite> [<task> | @<set> ...] [--variant <file>] [--label <name>] [--out <file.jsonl>] [--jobs <n>]
factory eval check <suite> [<task> | @<set> ...]
factory eval attempt --repo <repo> --base <commit> --issue <issue.md> --out <dir> [--settings-from <commit>] [--variant <file>]
factory eval grade <suite> <task> --attempt <dir> [--label <name>] [--out <file.jsonl>] [--json]
factory eval mine <repo> --out <suite> [--propose <n>] [--depth <merges>] [--tests <regex>] [--no-github] [--no-check]
factory eval report <results.jsonl>...
factory eval compare --base <results.jsonl>... --variant <results.jsonl>... [--json]
`;

export async function evalCommand(args: string[], io: EvalIo, factory: FactoryCall, runner?: Runner): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'run': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { variant: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' }, jobs: { type: 'string' } } });
        const [suiteDir, ...picks] = positionals;
        if (!suiteDir) throw new Error('run needs a suite folder');
        const suite = loadSuite(resolve(io.cwd, suiteDir));
        const tasks = selectTasks(suite, picks);
        if (!tasks.length) throw new Error(`no tasks in ${join(suite.dir, 'tasks')}`);
        const variant = values.variant ? loadVariant(resolve(io.cwd, values.variant)) : undefined;
        const label = values.label ?? variant?.name ?? 'base';
        const out = values.out ? resolve(io.cwd, values.out) : join(suite.dir, 'results', `${new Date().toISOString().slice(0, 10)}-${label}.jsonl`);
        const jobs = values.jobs ? Number(values.jobs) : 1;
        if (!Number.isInteger(jobs) || jobs < 1) throw new Error('--jobs must be a whole number of at least 1');
        io.stdout(`${tasks.length} task(s) as ${label}${variant ? ` (variant ${variant.name}, ${variant.hash.slice(7, 19)})` : ''}, results in ${out}\n`);
        const results = await runEval({ suite, tasks, ...(variant ? { variant } : {}), out, label, jobs, factory, env: io.env, log: (l) => io.stdout(`${l}\n`), ...(runner ? { runner } : {}) });
        const all = readResults(out).filter((r) => r.label === label);
        io.stdout(`${formatSummary(summarize(out, all))}\n`);
        return results.some((r) => r.error) ? 3 : 0;
      }
      case 'check': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        const [suiteDir, ...picks] = positionals;
        if (!suiteDir) throw new Error('check needs a suite folder');
        const suite = loadSuite(resolve(io.cwd, suiteDir));
        const lines = await checkTasks(suite, selectTasks(suite, picks), join(suite.dir, '.check'), (l) =>
          io.stdout(`${l.task} ${l.case}: ${l.ok ? 'ok' : 'WRONG'}  expected ${l.expected}, got ${l.got}  ${l.reason}\n`),
          runner,
        );
        const bad = lines.filter((l) => !l.ok);
        io.stdout(bad.length ? `${bad.length} case(s) wrong: fix those tasks before measuring with them.\n` : `Every task checks out (${lines.length} cases).\n`);
        return bad.length ? 1 : 0;
      }
      case 'attempt': {
        const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, base: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' }, 'settings-from': { type: 'string' }, variant: { type: 'string' } } });
        if (!values.repo || !values.base || !values.issue || !values.out) throw new Error('attempt needs --repo, --base, --issue and --out');
        const repo = /^[a-z+]+:\/\/|^git@/.test(values.repo) ? values.repo : resolve(io.cwd, values.repo);
        const variant = values.variant ? loadVariant(resolve(io.cwd, values.variant)) : undefined;
        const commit = factoryCommit();
        const out = resolve(io.cwd, values.out);
        const a = await attemptTask({
          source: { repo, ...(values['settings-from'] ? { settingsFrom: values['settings-from'] } : {}) },
          baseCommit: values.base,
          issue: readFileSync(resolve(io.cwd, values.issue), 'utf8'),
          ...(variant ? { variant } : {}),
          dir: out,
          factory,
          env: io.env,
          ...(commit ? { commit } : {}),
        });
        io.stdout(`factory ${a.factoryState}, ${a.merged ? 'merged' : 'not merged'}, ${a.reworkLoops} rework, $${a.costUsd.toFixed(2)} (${a.durationSeconds}s)${a.error ? `; ${a.error}` : ''}. Result in ${join(out, ATTEMPT_JSON)} and ${join(out, ATTEMPT_PATCH)}\n`);
        return a.error ? 3 : 0;
      }
      case 'grade': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { attempt: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' } } });
        const [suiteDir, id] = positionals;
        if (!suiteDir || !id || !values.attempt) throw new Error('grade needs a suite folder, a task and --attempt <dir>');
        const suite = loadSuite(resolve(io.cwd, suiteDir));
        const dir = resolve(io.cwd, values.attempt);
        if (!existsSync(join(dir, ATTEMPT_JSON))) throw new Error(`no ${ATTEMPT_JSON} in ${dir}`);
        const attempt = JSON.parse(readFileSync(join(dir, ATTEMPT_JSON), 'utf8')) as AttemptResult;
        const patch = existsSync(join(dir, ATTEMPT_PATCH)) ? readFileSync(join(dir, ATTEMPT_PATCH), 'utf8') : '';
        const r = await gradeAttempt({ suite, task: loadTask(suite, id), attempt, patch, dir, label: values.label ?? attempt.variant?.name ?? 'base', ...(runner ? { runner } : {}), cacheDir: join(suite.dir, '.grade-cache') });
        if (values.out) appendFileSync(resolve(io.cwd, values.out), `${JSON.stringify(r)}\n`);
        io.stdout(values.json ? `${JSON.stringify(r)}\n` : `${id}: ${r.passed ? 'PASS' : 'FAIL'}  factory ${r.factoryState}${r.grade ? `, hidden tests ${r.grade.verdict}: ${r.grade.reason}` : ''}${r.error ? `, ${r.error}` : ''}\n`);
        return r.error ? 3 : 0;
      }
      case 'mine': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: 'string' }, propose: { type: 'string' }, depth: { type: 'string' }, tests: { type: 'string' }, 'no-github': { type: 'boolean' }, 'no-check': { type: 'boolean' } } });
        const [repoArg] = positionals;
        if (!repoArg || !values.out) throw new Error('mine needs the project repository and --out <suite folder>');
        const num = (v: string | undefined, what: string) => {
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1) throw new Error(`--${what} must be a whole number of at least 1`);
          return n;
        };
        const repo = /^[a-z+]+:\/\/|^git@/.test(repoArg) ? repoArg : resolve(io.cwd, repoArg);
        const onGithub = values['no-github'] ? undefined : githubRepoOf(repo);
        const propose = num(values.propose, 'propose');
        const depth = num(values.depth, 'depth');
        const r = await mine({
          repo,
          out: resolve(io.cwd, values.out),
          ...(values.tests ? { tests: new RegExp(values.tests) } : {}),
          ...(propose ? { propose } : {}),
          ...(depth ? { depth } : {}),
          ...(onGithub ? { pulls: githubPulls(onGithub, tokenProviderFromEnv(io.env)) } : {}),
          ...(values['no-check'] ? { noCheck: true } : {}),
          ...(runner ? { runner } : {}),
          log: (l) => io.stdout(`${l}\n`),
        });
        const dropped = r.candidates.filter((c) => c.status === 'dropped').length;
        const flagged = r.candidates.filter((c) => c.unmentioned.length).length;
        io.stdout(`${r.candidates.length} candidate(s) from merges that changed tests (${r.withoutTests} changed none). Proposed ${r.proposed.length}, smoke ${r.smoke.length}, dropped ${dropped}, flagged for a person ${flagged}.\n`);
        io.stdout(`Suite in ${r.suite}; read candidates.md there, then edit the sets in suite.yaml before the first run.\n`);
        if (!onGithub && !values['no-github']) io.stdout('The repository is not on GitHub, so requests come from commit messages.\n');
        return 0;
      }
      case 'report': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        if (!positionals.length) throw new Error('report needs one or more results files');
        for (const f of positionals) {
          const file = resolve(io.cwd, f);
          const results = readResults(file);
          io.stdout(`${formatSummary(summarize(file, results))}\n`);
          for (const r of results) io.stdout(`  ${r.task}  ${r.passed ? 'pass' : 'fail'}  factory ${r.factoryState}, ${r.reworkLoops} rework, $${r.costUsd.toFixed(2)}${r.grade ? `; hidden tests: ${r.grade.reason}` : ''}${r.error ? `; ${r.error}` : ''}\n`);
        }
        return 0;
      }
      case 'compare': {
        const { values } = parseArgs({ args: rest, options: { base: { type: 'string', multiple: true }, variant: { type: 'string', multiple: true }, json: { type: 'boolean' } } });
        if (!values.base?.length || !values.variant?.length) throw new Error('compare needs --base <results.jsonl> (twice or more, for the noise band) and --variant <results.jsonl>');
        const load = (f: string) => ({ file: resolve(io.cwd, f), results: readResults(resolve(io.cwd, f)) });
        const c = compare(values.base.map(load), values.variant.map(load));
        io.stdout(values.json ? `${JSON.stringify(c)}\n` : `${formatComparison(c)}\n`);
        return 0;
      }
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    io.stderr(`factory eval: ${(error as Error).message}\n`);
    return 2;
  }
}

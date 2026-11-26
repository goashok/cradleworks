// `factory eval mine`: builds a suite of candidate tasks from a project's own merged history, so a
// team can measure its factory on its own code without writing tasks by hand.
//
// Each merge to the default branch that changed tests becomes a candidate:
//
//   starting code       the default branch just before the merge (the merge's first parent)
//   request (issue.md)  the issue the pull request closes or is part of, else the pull request's
//                       title and description, else the commit message
//   hidden tests        the test files the merge added or changed, as they were after it
//   solution.patch      the rest of the merge's diff, outside .factory/
//
// The factory is not graded on reproducing the team's change: it writes its own, and passes when
// the team's tests pass on it. Candidates are then ranked into a balanced proposal (spread over
// areas of the code, newest first, near-duplicates held back), and checked in that order with
// `factory eval check` until enough pass. Everything mined is written, so an admin can swap tasks
// in and out; the proposal and a smoke set are sets in suite.yaml, and candidates.md lists every
// candidate with the signals it was ranked on and anything a person should look at.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringifyYaml } from '@cradleworks/config';
import { checkTasks, type CheckLine } from './check.ts';
import type { Runner } from './grade.ts';
import { loadSuite } from './suite.ts';

/** What a host knows about a pull request beyond the commit. */
export interface PullInfo {
  title: string;
  body: string;
  /** The issue it closes or is part of, when it names one. */
  issue?: { number: number; title: string; body: string };
  /** Reviews that asked for changes. */
  reviewRounds?: number;
}

export interface PullSource {
  pull(number: number): Promise<PullInfo | undefined>;
}

export interface MineOptions {
  /** The project's repository: a path on this machine or a clone URL. */
  repo: string;
  /** The suite folder to write; it must be new or empty, and outside the repository. */
  out: string;
  /** Which changed files are tests. */
  tests?: RegExp;
  /** How many tasks to propose. */
  propose?: number;
  /** How many merges back to look. */
  depth?: number;
  pulls?: PullSource;
  /** Skip `factory eval check`; the proposal is then unchecked. */
  noCheck?: boolean;
  runner?: Runner;
  log: (line: string) => void;
}

export interface Candidate {
  id: string;
  commit: string;
  base: string;
  mergedAt: string;
  title: string;
  pr?: number;
  issue?: number;
  /** Where the request came from. */
  requestFrom: 'issue' | 'pull request' | 'commit';
  type: 'feature' | 'bug fix' | 'refactor' | 'dependency';
  size: 'small' | 'medium' | 'large';
  area: string;
  linesChanged: number;
  filesChanged: number;
  hiddenFiles: string[];
  testCases: number;
  reviewRounds?: number;
  /** Names the tests use that the change introduced and the request never mentions. */
  unmentioned: string[];
  /** Why it was held back from the proposal or dropped, if it was. */
  note?: string;
  status: 'proposed' | 'spare' | 'dropped';
}

export interface MineResult {
  suite: string;
  candidates: Candidate[];
  /** Merges looked at that changed no tests. */
  withoutTests: number;
  proposed: string[];
  smoke: string[];
}

/** Common test file layouts across stacks. */
export const DEFAULT_TESTS = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|(^|\/)src\/test\/|Tests?\.(java|kt|cs|scala)$|_spec\.rb$/;

const SMOKE = 5;
const PER_GROUP = 2;

function gitIn(gitDir: string) {
  return (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** The pull request a merge commit came from, from GitHub's merge and squash subjects. */
export function pullNumber(subject: string): number | undefined {
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

export function changeType(text: string): Candidate['type'] {
  if (/\b(bump|upgrade|dependabot|renovate|dependenc(y|ies)|deps)\b/i.test(text)) return 'dependency';
  if (/\b(fix(es|ed)?|bug|crash|regression|broken|wrong|incorrect)\b/i.test(text)) return 'bug fix';
  if (/\b(refactor|rename|clean ?up|tidy|extract|simplif(y|ies))\b/i.test(text)) return 'refactor';
  return 'feature';
}

const sizeOf = (lines: number): Candidate['size'] => (lines <= 60 ? 'small' : lines <= 300 ? 'medium' : 'large');

/** Commit message lines that are bookkeeping, not a request. */
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|claude-session|factory task\b)/i;

function cleanBody(body: string): string {
  // A factory pull request's own sections say what the agent did: not part of any request.
  const cut = body.search(/^##\s+(Agent summary|Factory)\b/m);
  return (cut >= 0 ? body.slice(0, cut) : body)
    .split('\n')
    .filter((l) => !TRAILER.test(l.trim()))
    .join('\n')
    .trim();
}

/** Names defined in a change's added lines, across common languages. */
function definedNames(added: string): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /\b(?:function\*?|def|class|interface|enum|type|struct|trait|fun|func|fn|module)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b(?:public|protected|private|internal)\s+(?:static\s+|final\s+|async\s+|override\s+)*[\w<>[\],.? ]+?\s+([a-zA-Z_][\w]*)\s*\(/g,
  ];
  for (const p of patterns) for (const m of added.matchAll(p)) if (m[1] && m[1].length > 2) out.add(m[1]);
  return out;
}

/** Literal routes or paths ('/bookings/:id') in added lines. */
function routes(added: string): Set<string> {
  return new Set([...added.matchAll(/['"`](\/[A-Za-z][\w/:{}.-]*)['"`]/g)].map((m) => m[1]!));
}

/** Names and routes the tests use that the change introduced but the request never mentions. */
export function unmentionedNames(solutionAdded: string, testAdded: string, request: string): string[] {
  const words = new Set(request.toLowerCase().split(/[^a-z0-9_$/:{}.-]+/).filter(Boolean));
  const said = (n: string) => words.has(n.toLowerCase()) || request.toLowerCase().includes(n.toLowerCase());
  const used = (n: string) => new RegExp(`(^|[^\\w$])${n.replace(/[$/.{}]/g, (c) => `\\${c}`)}([^\\w$]|$)`).test(testAdded);
  return [...definedNames(solutionAdded), ...routes(solutionAdded)].filter((n) => used(n) && !said(n)).sort();
}

const addedLines = (diff: string) =>
  diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');

const countCases = (testAdded: string) => [...testAdded.matchAll(/(^|\s)(it|test)(\.\w+)?\s*\(|@Test\b|\bdef test_|\bfunc Test[A-Z]|\[Fact\]|\[Test\]/gm)].length;

/** Orders candidates for the proposal: spread over areas, newest first in each, near-duplicates last (noted). */
export function rank(cands: Candidate[]): Candidate[] {
  const groups = new Map<string, number>();
  const fresh: Candidate[] = [];
  const held: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1))) {
    const key = `${c.type}|${c.area}|${c.size}`;
    const n = groups.get(key) ?? 0;
    groups.set(key, n + 1);
    if (n < PER_GROUP) fresh.push(c);
    else {
      c.note ??= `near-duplicate: ${PER_GROUP} newer ${c.type} change(s) of this size in ${c.area} rank ahead`;
      held.push(c);
    }
  }
  const byArea = new Map<string, Candidate[]>();
  for (const c of fresh) byArea.set(c.area, [...(byArea.get(c.area) ?? []), c]);
  const order: Candidate[] = [];
  for (let round = 0; order.length < fresh.length; round++)
    for (const list of byArea.values()) if (list[round]) order.push(list[round]!);
  return [...order, ...held];
}

/** Reads the merges of the default branch into candidate tasks, written under `<out>/tasks`. */
export async function mine(o: MineOptions): Promise<MineResult> {
  const out = resolve(o.out);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty: mine writes a new suite`);
  const local = !/^[a-z+]+:\/\/|^git@/.test(o.repo);
  const repo = local ? resolve(o.repo) : o.repo;
  if (local) {
    const rel = relative(repo, out);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('the suite must live outside the repository: the factory can read everything inside it');
  }
  const tests = o.tests ?? DEFAULT_TESTS;
  const work = join(out, '.mine');
  const gitDir = join(work, 'source.git');
  mkdirSync(work, { recursive: true });
  try {
    execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const git = gitIn(gitDir);
    const branch = git('symbolic-ref', '--short', 'HEAD').trim();
    const head = git('rev-parse', branch).trim();
    const log = git('log', '--first-parent', `--max-count=${o.depth ?? 200}`, '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e', branch);
    let withoutTests = 0;
    const cands: Candidate[] = [];
    const used = new Set<string>();
    for (const rec of log.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
      const [commit, parents, mergedAt, subject, body = ''] = rec.split('\x1f') as [string, string, string, string, string?];
      const base = parents.split(' ')[0];
      if (!base) continue;
      const changes = git('diff', '--name-status', '--no-renames', '-z', base, commit).split('\0').filter(Boolean);
      const files: Array<{ status: string; path: string }> = [];
      for (let i = 0; i + 1 < changes.length; i += 2) files.push({ status: changes[i]!, path: changes[i + 1]! });
      const testFiles = files.filter((f) => tests.test(f.path) && f.status !== 'D').map((f) => f.path);
      const code = files.filter((f) => !tests.test(f.path) && !f.path.startsWith('.factory/'));
      if (!testFiles.length || !code.length) {
        withoutTests++;
        continue;
      }
      const pr = pullNumber(subject);
      const info = pr && o.pulls ? await o.pulls.pull(pr).catch(() => undefined) : undefined;
      let title = info?.title ?? subject.replace(/\s*\(#\d+\)\s*$/, '');
      let request = cleanBody(info?.body ?? body);
      let requestFrom: Candidate['requestFrom'] = info ? 'pull request' : 'commit';
      if (/^Merge pull request #\d+/.test(title)) title = request.split('\n')[0]?.trim() || title;
      if (info?.issue) {
        title = info.issue.title;
        request = info.issue.body.trim();
        requestFrom = 'issue';
      } else if (/^Merge pull request #\d+/.test(subject)) request = request.split('\n').slice(1).join('\n').trim();
      const codePaths = code.map((f) => f.path);
      const solution = git('diff', '--binary', base, commit, '--', ...codePaths);
      const testDiff = git('diff', base, commit, '--', ...testFiles);
      const numstat = git('diff', '--numstat', base, commit, '--', ...codePaths, ...testFiles)
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t'));
      const lines = numstat.reduce((a, [add, del]) => a + (Number(add) || 0) + (Number(del) || 0), 0);
      const weight = new Map<string, number>();
      for (const [add, del, path] of numstat) {
        if (!path || tests.test(path)) continue;
        const d = dirname(path);
        const area = d === '.' ? path : d.split('/').slice(0, 2).join('/');
        weight.set(area, (weight.get(area) ?? 0) + (Number(add) || 0) + (Number(del) || 0));
      }
      const area = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '.';
      const testAdded = addedLines(testDiff);
      let id = `${pr ? `pr-${pr}` : commit.slice(0, 8)}-${slug(title) || 'change'}`;
      while (used.has(id)) id += '-x';
      used.add(id);
      const c: Candidate = {
        id,
        commit,
        base,
        mergedAt,
        title,
        ...(pr ? { pr } : {}),
        ...(info?.issue ? { issue: info.issue.number } : {}),
        requestFrom,
        type: changeType(`${title} ${subject}`),
        size: sizeOf(lines),
        area,
        linesChanged: lines,
        filesChanged: codePaths.length + testFiles.length,
        hiddenFiles: testFiles,
        testCases: countCases(testAdded),
        ...(info?.reviewRounds !== undefined ? { reviewRounds: info.reviewRounds } : {}),
        unmentioned: unmentionedNames(addedLines(solution), testAdded, `${title}\n${request}`),
        status: 'spare',
      };
      if (c.unmentioned.length) c.note = `the tests use ${c.unmentioned.join(', ')}, which the request never names: add it to issue.md or drop the task`;
      const dir = join(out, 'tasks', id);
      mkdirSync(join(dir, 'hidden'), { recursive: true });
      writeFileSync(join(dir, 'issue.md'), `# ${title}\n\n${request || title}\n`);
      writeFileSync(join(dir, 'solution.patch'), solution);
      for (const t of testFiles) {
        const target = join(dir, 'hidden', t);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', `${commit}:${t}`], { maxBuffer: 256 * 1024 * 1024 }));
      }
      writeFileSync(
        join(dir, 'task.yaml'),
        stringifyYaml({
          base_commit: base,
          title,
          type: c.type,
          size: c.size,
          mined: { commit, merged_at: mergedAt, ...(pr ? { pull_request: pr } : {}), ...(c.issue ? { issue: c.issue } : {}), request_from: requestFrom, area, lines_changed: lines, files_changed: c.filesChanged, test_cases: c.testCases, ...(c.reviewRounds !== undefined ? { review_rounds: c.reviewRounds } : {}) },
        }),
      );
      cands.push(c);
    }

    // Today's settings over every base, when the project has them.
    let settingsFrom: string | undefined;
    try {
      git('cat-file', '-e', `${head}:.factory/factory.yaml`);
      settingsFrom = head;
    } catch {
      settingsFrom = undefined;
    }
    const writeSuite = (sets: Record<string, string[]>) =>
      writeFileSync(join(out, 'suite.yaml'), stringifyYaml({ repo, ...(settingsFrom ? { settings_from: settingsFrom } : {}), sets }));
    writeSuite({});

    const want = o.propose ?? 20;
    const ranked = rank(cands);
    const proposed: Candidate[] = [];
    const suite = loadSuite(out);
    for (const c of ranked) {
      if (proposed.length >= want) break;
      if (c.note?.startsWith('near-duplicate') || c.unmentioned.length) continue;
      if (!o.noCheck) {
        o.log(`checking ${c.id}`);
        const lines: CheckLine[] = await checkTasks(suite, [c.id], join(work, 'check'), () => {}, o.runner);
        const bad = lines.filter((l) => !l.ok);
        if (bad.length) {
          c.status = 'dropped';
          c.note = bad.map((l) => `${l.case}: expected ${l.expected}, got ${l.got} (${l.reason})`).join('; ');
          o.log(`  dropped: ${c.note}`);
          continue;
        }
      }
      c.status = 'proposed';
      proposed.push(c);
    }
    const order = new Map(ranked.map((c, i) => [c.id, i]));
    const proposedIds = proposed.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map((c) => c.id);
    const smoke = [...proposed].sort((a, b) => a.linesChanged - b.linesChanged).slice(0, SMOKE).map((c) => c.id);
    writeSuite({ proposed: proposedIds, smoke });
    const result: MineResult = { suite: out, candidates: ranked, withoutTests, proposed: proposedIds, smoke };
    writeFileSync(join(out, 'candidates.md'), formatCandidates(result, !o.noCheck));
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function formatCandidates(r: MineResult, checked: boolean): string {
  const rows = r.candidates.map(
    (c) =>
      `| ${c.status} | ${c.id} | ${c.type} | ${c.size} (${c.linesChanged} lines, ${c.filesChanged} files) | ${c.area} | ${c.hiddenFiles.length} file(s), ${c.testCases} case(s) | ${c.mergedAt.slice(0, 10)} | ${c.reviewRounds ?? ''} | ${c.requestFrom} | ${(c.note ?? '').replace(/\|/g, '\\|')} |`,
  );
  return `# Candidate tasks

${r.candidates.length} candidate(s) from merges that changed tests; ${r.withoutTests} merge(s) changed no tests and were left out.
${checked ? 'Proposed tasks passed `factory eval check`.' : 'Nothing was checked: run `factory eval check` before measuring.'}
\`proposed\` (${r.proposed.length}) and \`smoke\` (${r.smoke.length}) are sets in suite.yaml. Edit them, and each task's issue.md, before the first run;
once measuring starts, changing the tasks makes a new suite with its own noise band.

| Status | Task | Type | Size | Area | Hidden tests | Merged | Review rounds | Request from | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

/** Pull requests and their issues from GitHub's API. */
export function githubPulls(ownerRepo: string, token: () => Promise<string>, fetcher: typeof fetch = fetch): PullSource {
  const api = async (path: string) => {
    const res = await fetcher(`https://api.github.com/repos/${ownerRepo}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'user-agent': 'cradleworks-eval-mine' } });
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    async pull(number) {
      const p = await api(`/pulls/${number}`);
      const body = typeof p.body === 'string' ? p.body : '';
      const reviews = (await api(`/pulls/${number}/reviews?per_page=100`).catch(() => [])) as unknown as Array<{ state?: string }>;
      const ref = new RegExp(`(?:\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#(\\d+)|Part of https://github\\.com/${ownerRepo.replace('/', '\\/')}/issues/(\\d+))`, 'i').exec(body);
      const n = ref ? Number(ref[1] ?? ref[2]) : undefined;
      const issue = n ? await api(`/issues/${n}`).catch(() => undefined) : undefined;
      return {
        title: String(p.title ?? ''),
        body,
        ...(issue && n ? { issue: { number: n, title: String(issue.title ?? ''), body: typeof issue.body === 'string' ? issue.body : '' } } : {}),
        reviewRounds: Array.isArray(reviews) ? reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length : 0,
      };
    },
  };
}

/** `owner/repo` of a GitHub clone URL or a local clone's origin, if it is on GitHub. */
export function githubRepoOf(repo: string): string | undefined {
  let url = repo;
  if (!/^[a-z+]+:\/\/|^git@/.test(repo)) {
    try {
      url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      return undefined;
    }
  }
  return /github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url)?.[1];
}

// The issue flow's pure parts: prompts for the spec, plan, check and tester agents, parsers
// for their answers, the plan rules, the comments posted on the issue, and the gate commands
// people write back. The orchestrator wires them to agents, the tracker and the event log.

import type { SpecDocument, TrackerComment, TrackerItem } from '@cradleworks/interfaces';
import type { ProjectConfig } from '../config/types.ts';
import type { TaskSize } from '../domain/types.ts';
import { extractJson } from './verify.ts';
import { WAITING_RULE } from './prompts.ts';

export const MAX_QUESTIONS = 5;
export const MAX_TASKS = 8;

// --- spec ---------------------------------------------------------------------------

export type SpecDraft = Pick<SpecDocument, 'title' | 'problem' | 'acceptanceCriteria' | 'outOfScope'> & { assumptions: string[] };
export type SpecAnswer = { kind: 'questions'; questions: string[] } | { kind: 'spec'; spec: SpecDraft } | { kind: 'unreadable'; reason: string };

export function specifierPrompt(contextFiles: string[]): string {
  return [
    'You are the spec agent in a software factory. Someone filed a request in the issue tracker; you turn it into a spec that the rest of the factory builds and tests against.',
    'You work in a read-only checkout of the project. Read the code you need to understand what exists today; do not change files.',
    '',
    'Project rule files (read them):',
    ...(contextFiles.length ? contextFiles.map((f) => `- ${f}`) : ['- (none)']),
    '',
    'A good spec:',
    '- states the problem in the requester\'s terms, in two to five sentences',
    '- has acceptance criteria that are each observable and testable: inputs, outputs, status codes, messages, limits. Number them by order; write each as one sentence',
    '- states a criterion about the whole repository (for example that nothing mentions an old version) without counting `.factory/`, where this spec is kept',
    '- keeps to what was asked; extra ideas go in "out of scope"',
    '- names every assumption you made where the request was silent',
    '',
    `If the request cannot be specified without answers only the requester has, you may ask up to ${MAX_QUESTIONS} short questions instead, once. Ask only what changes the spec; prefer a stated assumption over a question.`,
    '',
    'End your final message with exactly one JSON object and nothing after it, either',
    '{"questions": ["…"]}',
    'or',
    '{"title": "…", "problem": "…", "acceptance_criteria": ["…"], "out_of_scope": ["…"], "assumptions": ["…"]}',
  ].join('\n');
}

/** Which repositories the work may change, for the spec agent and the spec check. */
export function reposSection(repos: { main: string; related: string[] }): string[] {
  if (repos.related.length === 0) return [];
  return [
    '',
    '## Repositories this work can change',
    `- \`${repos.main}\`: the one checked out here`,
    ...repos.related.map((r) => `- \`${r}\`: a related repository the factory can also change`),
    '',
    'When the request asks for changes in more than one of them, one spec covers all of it: keep every part in scope, and say in each criterion which repository it is about.',
  ];
}

export function specifierInput(item: TrackerItem, context: { previous?: SpecDocument; rejection?: string; questionsAsked?: string[]; repos?: { main: string; related: string[] } }): string {
  const lines = [`# Request: ${item.title}`, '', `Filed by @${item.author.handle ?? item.author.name}.`, '', item.body.trim() || '_(no description)_'];
  if (context.repos) lines.push(...reposSection(context.repos));
  const people = item.comments.filter((c) => !c.byFactory);
  if (people.length) {
    lines.push('', '## Discussion on the issue');
    for (const c of people) lines.push('', `**@${c.author.handle ?? c.author.name}:**`, c.body.trim());
  }
  if (context.questionsAsked) {
    lines.push('', '## You already asked', ...context.questionsAsked.map((q) => `- ${q}`), '', 'The answers, if any, are in the discussion above. Do not ask again: write the spec, with assumptions for anything still open.');
  }
  if (context.previous) {
    lines.push('', `## Your previous draft (version ${context.previous.version})`, specBody(context.previous));
  }
  if (context.rejection) lines.push('', '## Why the previous draft was sent back', context.rejection, '', 'Write a new version that addresses this.');
  return lines.join('\n');
}

export function parseSpecAnswer(text: string | undefined, questionsAllowed: boolean): SpecAnswer {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
  const answer = extractJson<SpecAnswer>(text, (v) => {
    if (typeof v.problem === 'string' && Array.isArray(v.acceptance_criteria)) {
      const criteria = strings(v.acceptance_criteria);
      if (criteria.length === 0) return undefined;
      return {
        kind: 'spec',
        spec: {
          title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : '',
          problem: v.problem.trim(),
          acceptanceCriteria: criteria,
          outOfScope: strings(v.out_of_scope),
          assumptions: strings(v.assumptions),
        },
      };
    }
    const questions = strings(v.questions);
    if (questions.length > 0) return { kind: 'questions', questions: questions.slice(0, MAX_QUESTIONS) };
    return undefined;
  });
  if (!answer) return { kind: 'unreadable', reason: text?.trim() ? 'no JSON spec or questions in its final message' : 'it gave no final message' };
  if (answer.kind === 'questions' && !questionsAllowed) return { kind: 'unreadable', reason: 'it asked questions again instead of writing the spec' };
  return answer;
}

/** The spec's content as Markdown: on the issue, in prompts, and in `.factory/specs/`. */
export function specBody(spec: Pick<SpecDocument, 'problem' | 'acceptanceCriteria' | 'outOfScope' | 'assumptions'>): string {
  const lines = ['### Problem', spec.problem, '', '### Acceptance criteria', ...spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`)];
  if (spec.outOfScope.length) lines.push('', '### Out of scope', ...spec.outOfScope.map((s) => `- ${s}`));
  if (spec.assumptions?.length) lines.push('', '### Assumptions', ...spec.assumptions.map((s) => `- ${s}`));
  return lines.join('\n');
}

export function specFile(spec: SpecDocument, source: { url: string }): string {
  const approved = spec.approval ? `Approved by ${spec.approval.by} on ${spec.approval.at.slice(0, 10)}.` : 'Not yet approved.';
  return [`# ${spec.title}`, '', `Spec \`${spec.id}\` version ${spec.version}, from ${source.url}. ${approved}`, '', specBody(spec), ''].join('\n');
}

// --- plan ---------------------------------------------------------------------------

export interface PlanDraftTask {
  key: string;
  title: string;
  description: string;
  size: TaskSize;
  dependsOn: string[];
  /** 1-based acceptance criteria this task makes true. */
  criteria: number[];
  repo?: string;
  /** Why this task needs nothing from the tasks in other repositories it isn't ordered with. */
  independent?: string;
}

export function plannerPrompt(contextFiles: string[]): string {
  return [
    'You are the planner agent in a software factory. You split an approved spec into tasks. Each task becomes one branch and one pull request, built by an implementer agent that sees only its own task and the spec.',
    'You work in a read-only checkout of the project. Read what you need; do not change files.',
    '',
    'Project rule files (read them):',
    ...(contextFiles.length ? contextFiles.map((f) => `- ${f}`) : ['- (none)']),
    '',
    'Rules for the plan:',
    `- At most ${MAX_TASKS} tasks; one task is right when the change is small. Do not split for the sake of it.`,
    '- Each task is "small" (an hour of focused work) or "medium" (half a day). Never "large": split it.',
    '- Each task leaves the project building and its tests passing on its own.',
    '- A task that needs another merged first lists it in depends_on. Independent tasks run in parallel, so keep them apart in the code where you can.',
    '- Every acceptance criterion is covered by at least one task, or by a follow-up when only a person can make it true; list the criteria numbers each covers.',
    '- The description says what to change, where, and how to tell it is done, including tests to add.',
    '- Every task must be doable by an agent with only the repositories\' code, in a sandbox. Steps that need a person or a system outside the repositories (publishing or tagging a release, deploying, creating secrets, accounts or infrastructure, a decision only a person can make) are never tasks, and no task may wait on one: the factory merges code, nothing more. A merged change is not a release. List such steps in "follow_ups", in plain words, for a person to do after the work merges, including any task that would have needed them (for example "Release client 0.2.0, then add its compatibility test"), with the acceptance criteria they cover.',
    '',
    'End your final message with exactly one JSON object and nothing after it:',
    '{"tasks": [{"key": "t1", "title": "…", "description": "…", "size": "small", "depends_on": [], "criteria": [1, 2], "repo": "…"}], "follow_ups": [{"step": "…", "criteria": [3]}]}',
    'Leave out "follow_ups" when there are none.',
    'Leave out "repo" unless the task belongs in one of the other repositories you are offered.',
    'Leave out "independent" unless the plan has tasks in more than one repository (see the repositories below).',
  ].join('\n');
}

export function plannerInput(spec: SpecDocument, repos: { main: string; related: string[] }, context: { rejection?: string; problems?: string[] }): string {
  const lines = [`# Spec: ${spec.title}`, '', specBody(spec), '', '## Repositories', `- \`${repos.main}\`: the one checked out here (default)`];
  for (const r of repos.related) lines.push(`- \`${r}\`: a related repository; give a task to it with "repo": "${r}"`);
  if (repos.related.length) {
    lines.push(
      '',
      'Tasks in different repositories run in parallel unless one depends on the other. When a task uses what a task in another repository adds (an endpoint, a field, a message, a type), list that task in its depends_on: it then starts after that change merges, and sees it. Only when two tasks in different repositories truly need nothing from each other, leave them unordered and say why in "independent" on one of them.',
    );
  }
  if (context.rejection) lines.push('', '## Why the previous plan was sent back', context.rejection);
  if (context.problems?.length) lines.push('', '## Problems with your previous answer', ...context.problems.map((p) => `- ${p}`), '', 'Answer again with a plan that fixes them.');
  return lines.join('\n');
}

export interface FollowUp {
  step: string;
  /** Acceptance criteria only a person can make true, which this step covers instead of a task. */
  criteria: number[];
}

/** The steps the planner left for a person, from the same answer as the plan. */
export function parseFollowUps(text: string | undefined): FollowUp[] {
  const found = extractJson(text, (v) => (Array.isArray(v.tasks) ? (Array.isArray(v.follow_ups) ? (v.follow_ups as unknown[]) : []) : undefined));
  const out: FollowUp[] = [];
  for (const f of found ?? []) {
    const raw = typeof f === 'string' ? { step: f } : typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : {};
    const step = typeof raw.step === 'string' ? raw.step.trim() : '';
    if (!step) continue;
    out.push({ step, criteria: Array.isArray(raw.criteria) ? raw.criteria.filter((c): c is number => Number.isInteger(c)) : [] });
  }
  return out.slice(0, 10);
}

/** A follow-up as it's kept and shown: the step, and the criteria it stands for. */
export function followUpText(f: FollowUp): string {
  return f.criteria.length ? `${f.step} (acceptance criteri${f.criteria.length > 1 ? 'a' : 'on'} ${f.criteria.join(', ')})` : f.step;
}

/** Markdown for the steps a person does after the work merges; '' when there are none. */
export function followUpsMarkdown(followUps: string[] | undefined, heading = 'After this merges, a person needs to'): string {
  return followUps?.length ? [`**${heading}:**`, '', ...followUps.map((f) => `- ${f}`)].join('\n') : '';
}

export function parsePlan(text: string | undefined): PlanDraftTask[] | undefined {
  return extractJson(text, (v) => {
    if (!Array.isArray(v.tasks)) return undefined;
    const tasks: PlanDraftTask[] = [];
    for (const raw of v.tasks as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const t = raw as Record<string, unknown>;
      const size = t.size === 'small' || t.size === 'medium' || t.size === 'large' ? t.size : 'medium';
      tasks.push({
        key: typeof t.key === 'string' ? t.key.trim() : '',
        title: typeof t.title === 'string' ? t.title.trim() : '',
        description: typeof t.description === 'string' ? t.description.trim() : '',
        size,
        dependsOn: Array.isArray(t.depends_on) ? t.depends_on.filter((d): d is string => typeof d === 'string') : [],
        criteria: Array.isArray(t.criteria) ? t.criteria.filter((c): c is number => Number.isInteger(c)) : [],
        ...(typeof t.repo === 'string' && t.repo.trim() ? { repo: t.repo.trim() } : {}),
        ...(typeof t.independent === 'string' && t.independent.trim() ? { independent: t.independent.trim() } : {}),
      });
    }
    return tasks;
  });
}

/** What's wrong with a plan, by the rules every plan must keep. Empty = fine. */
export function checkPlan(tasks: PlanDraftTask[], criteriaCount: number, repos: { main: string; related: string[] }, followUps: FollowUp[] = []): string[] {
  const problems: string[] = [];
  if (tasks.length === 0) return ['the plan has no tasks'];
  if (tasks.length > MAX_TASKS) problems.push(`the plan has ${tasks.length} tasks; at most ${MAX_TASKS}`);
  const keys = new Set<string>();
  for (const t of tasks) {
    if (!t.key) problems.push(`a task has no key: "${t.title}"`);
    else if (keys.has(t.key)) problems.push(`key ${t.key} is used twice`);
    keys.add(t.key);
    if (!t.title) problems.push(`task ${t.key} has no title`);
    if (!t.description) problems.push(`task ${t.key} has no description`);
    if (t.size === 'large') problems.push(`task ${t.key} is large; split it`);
    if (t.repo && t.repo !== repos.main && !repos.related.includes(t.repo)) problems.push(`task ${t.key} names repo "${t.repo}", which is not offered`);
    for (const c of t.criteria) if (c < 1 || c > criteriaCount) problems.push(`task ${t.key} covers criterion ${c}, which does not exist`);
  }
  for (const t of tasks) for (const d of t.dependsOn) if (!keys.has(d)) problems.push(`task ${t.key} depends on unknown task ${d}`);
  if (hasCycle(tasks)) problems.push('the dependencies form a cycle');
  else problems.push(...unorderedAcrossRepos(tasks, repos.main));
  for (const f of followUps) for (const c of f.criteria) if (c < 1 || c > criteriaCount) problems.push(`a follow-up covers criterion ${c}, which does not exist`);
  const covered = new Set([...tasks.flatMap((t) => t.criteria), ...followUps.flatMap((f) => f.criteria)]);
  const missing = Array.from({ length: criteriaCount }, (_, i) => i + 1).filter((c) => !covered.has(c));
  if (missing.length) problems.push(`no task covers criteri${missing.length > 1 ? 'a' : 'on'} ${missing.join(', ')}`);
  return problems;
}

/**
 * Tasks in different repositories that neither depend on the other run in parallel, so one
 * can't build on what the other adds. Each such pair needs a dependency, or a reason on one of
 * them for why they need nothing from each other.
 */
function unorderedAcrossRepos(tasks: PlanDraftTask[], main: string): string[] {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const reach = new Map<string, Set<string>>();
  const upstream = (k: string): Set<string> => {
    const known = reach.get(k);
    if (known) return known;
    const out = new Set<string>();
    reach.set(k, out);
    for (const d of deps.get(k) ?? []) {
      if (!deps.has(d)) continue;
      out.add(d);
      for (const u of upstream(d)) out.add(u);
    }
    return out;
  };
  const repoOf = (t: PlanDraftTask) => t.repo ?? main;
  const problems: string[] = [];
  for (const [i, a] of tasks.entries()) {
    for (const b of tasks.slice(i + 1)) {
      if (repoOf(a) === repoOf(b) || a.independent || b.independent) continue;
      if (upstream(a.key).has(b.key) || upstream(b.key).has(a.key)) continue;
      problems.push(`tasks ${a.key} (${repoOf(a)}) and ${b.key} (${repoOf(b)}) are in different repositories and neither depends on the other: add the dependency, or say in "independent" why they need nothing from each other`);
    }
  }
  return problems;
}

function hasCycle(tasks: PlanDraftTask[]): boolean {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 2) return false;
    if (state.get(k) === 1) return true;
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(k, 2);
    return false;
  };
  return tasks.some((t) => visit(t.key));
}

// --- checks: the ai gates for spec and plan -------------------------------------------

export interface CheckVerdict {
  verdict: 'approved' | 'rejected';
  reasons: string[];
}

export function checkerPrompt(what: 'spec' | 'plan'): string {
  const looks =
    what === 'spec'
      ? ['- every acceptance criterion is observable and testable', '- the spec answers what the requester asked, no less and no more', '- the assumptions are reasonable, or would a requester likely disagree?', '- nothing contradicts the existing code or the project rules']
      : ['- following the tasks in order makes every acceptance criterion true, except those a follow-up leaves for a person, and each of those really needs a person', '- each task is small enough for one focused pull request and leaves the project working', '- dependencies are right: nothing builds on work that is not merged first', '- no task does work the spec does not ask for', '- no task needs a step only a person or an outside system can do (publishing a release, deploying, creating secrets or accounts): such steps belong in the follow-ups for a person, not in a task'];
  return [
    `You check a ${what} in a software factory before ${what === 'spec' ? 'any code is planned' : 'any code is written'}. You work in a read-only checkout of the project; read what you need, change nothing.`,
    '',
    'Check that:',
    ...looks,
    '',
    'Approve when it is good enough to proceed; reject only for concrete problems, each stated so the author can fix it.',
    'End your final message with exactly one JSON object and nothing after it:',
    '{"verdict": "approved" | "rejected", "reasons": ["…"]}',
  ].join('\n');
}

export function parseCheck(text: string | undefined): CheckVerdict {
  return (
    extractJson<CheckVerdict>(text, (v) => {
      if (v.verdict !== 'approved' && v.verdict !== 'rejected') return undefined;
      const reasons = Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : [];
      return { verdict: v.verdict, reasons: v.verdict === 'rejected' && reasons.length === 0 ? ['The check gave no reason.'] : reasons };
    }) ?? { verdict: 'rejected', reasons: ['The check\'s answer could not be read.'] }
  );
}

// --- tester -------------------------------------------------------------------------

export function testerPrompt(config: ProjectConfig, contextFiles: string[]): string {
  return [
    'You are the tester agent in a software factory. Another agent is implementing a task from the spec below, separately; you have not seen its change and will not.',
    'Write automated acceptance tests that check the acceptance criteria this task covers, from the outside: through the public API, endpoints or functions the spec names.',
    '',
    'Project rule files (read them, and follow the existing test conventions):',
    ...(contextFiles.length ? contextFiles.map((f) => `- ${f}`) : ['- (none)']),
    '',
    `The project runs its tests with \`${config.stack.commands.test}\`. Put your tests in new files whose names contain "acceptance", next to the existing tests, so the test command picks them up. Do not edit existing files.`,
    'The tests are expected to fail now, because the feature is not built in this checkout. Make them compile against the interfaces the spec describes where you can, and test behaviour, not implementation details.',
    'Assert only what the spec requires. Where it leaves a detail open (exact wording, formatting, order, extra fields, which of several valid approaches), accept any answer the spec allows; an implementer will rightly refuse to satisfy a test the spec does not support.',
    'Run your tests once before you finish. They may fail only because the feature is missing (an unknown endpoint, function or type, or a failed assertion), never because of a mistake in the test code itself, such as a wrong type, import or call of the test library.',
    'A test that searches the repository must leave out `.factory/`, where the factory keeps the spec itself.',
    WAITING_RULE,
    'Do not implement the feature. Finish with a one-paragraph summary of what each test checks.',
  ].join('\n');
}

export function testerInput(spec: SpecDocument, task: { title: string; description?: string }): string {
  return [`# Task: ${task.title}`, '', task.description?.trim() || '_(no description)_', '', `# Spec: ${spec.title}`, '', specBody(spec)].join('\n');
}

/**
 * The tester again, after the implementer refused to change the code to pass one of its tests.
 * It now sees the branch, its own tests, the failure and the implementer's argument, and judges
 * the test against the spec: fix the test, or keep it and say why.
 */
export function testReviewPrompt(config: ProjectConfig, contextFiles: string[]): string {
  return [
    'You are the tester agent in a software factory. You wrote acceptance tests for a task from its spec. The implementer built the task, one of your tests failed, and the implementer declined to change the code because it believes the test is wrong.',
    'Decide who is right, judged only against the spec and the project rules, not against what is easiest to change.',
    '',
    'Project rule files:',
    ...(contextFiles.length ? contextFiles.map((f) => `- ${f}`) : ['- (none)']),
    '',
    `Your tests are applied in this checkout, on top of the implementer's branch. Run them with \`${config.stack.commands.test}\`.`,
    'The test is wrong when it does not compile or run as written, asserts something the spec does not require (an exact format, order, message or structure the spec leaves open), contradicts the spec, or depends on the environment. Then fix your test files so they check what the spec does require, and run them again. Edit only your own acceptance test files; never the implementation or other tests.',
    'The test is right when the code does not do what the spec requires. Then leave the tests as they are.',
    'End your final message with a JSON object: {"verdict": "revised" | "upheld", "reasons": ["..."]}. "revised" means you changed the tests; "upheld" means the code is wrong, with the spec requirement it misses.',
  ].join('\n');
}

export function testReviewInput(spec: SpecDocument, task: { title: string; description?: string }, tests: { files: string[] }, failure: string, dispute: string): string {
  return [
    `# Task: ${task.title}`,
    '',
    task.description?.trim() || '_(no description)_',
    '',
    `# Your acceptance tests`,
    '',
    ...tests.files.map((f) => `- ${f}`),
    '',
    '# How they failed',
    '',
    '```',
    failure.trim() || '(no output)',
    '```',
    '',
    "# The implementer's reason for not changing the code",
    '',
    dispute.trim(),
    '',
    `# Spec: ${spec.title}`,
    '',
    specBody(spec),
  ].join('\n');
}

export function parseTestReview(text: string | undefined): { verdict: 'revised' | 'upheld'; reasons: string[] } | undefined {
  return extractJson(text, (v) => {
    if (v.verdict !== 'revised' && v.verdict !== 'upheld') return undefined;
    const reasons = Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim()) : [];
    return { verdict: v.verdict, reasons: reasons.length ? reasons : ['The tester gave no reason.'] };
  });
}

// --- the issue: comments the factory posts, and commands people write ------------------

/** A hidden tag in a factory comment, so the gate that follows it can be found again. */
export function gateTag(gate: 'questions' | 'spec' | 'plan' | 'blocked', version: number | string): string {
  return `<!-- cradleworks:${gate}:${version} -->`;
}

export function questionsComment(questions: string[], requester: string): string {
  return [
    gateTag('questions', 1),
    `### Before I write the spec, @${requester}`,
    '',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Reply here in your own words; I will write the spec when you do. Anything you leave out, I will state as an assumption.',
  ].join('\n');
}

export function specComment(spec: SpecDocument, mode: 'human' | 'ai' | 'skipped'): string {
  const how =
    mode === 'human'
      ? 'Reply **`/approve`** to start planning, or **`/reject <what to change>`** for a new version. Only people with write access can decide.'
      : mode === 'ai'
        ? 'A checker agent reviews it next.'
        : 'Spec approval is skipped for this project; planning starts now.';
  return [gateTag('spec', spec.version), `## Spec, version ${spec.version}: ${spec.title}`, '', specBody(spec), '', `_${how}_`].join('\n');
}

export function planComment(tasks: Array<{ id: string; title: string; size: string; dependsOn: string[]; repo?: string }>, mode: 'human' | 'ai' | 'skipped', attempt: number, followUps?: string[]): string {
  const name = new Map(tasks.map((t, i) => [t.id, `T${i + 1}`]));
  const how =
    mode === 'human'
      ? 'Reply **`/approve`** to start building, or **`/reject <what to change>`** for a new plan.'
      : mode === 'ai'
        ? 'A checker agent reviews it next.'
        : 'The plan check is skipped for this project; building starts now.';
  const lines = [gateTag('plan', attempt), `## Plan: ${tasks.length} task${tasks.length > 1 ? 's' : ''}`, '', '| | Task | Size | After | Repo |', '| --- | --- | --- | --- | --- |'];
  for (const t of tasks) lines.push(`| ${name.get(t.id)} | ${t.title} | ${t.size} | ${t.dependsOn.map((d) => name.get(d)).join(', ') || '—'} | ${t.repo ?? 'this one'} |`);
  const after = followUpsMarkdown(followUps);
  if (after) lines.push('', after);
  lines.push('', `_Each task becomes one pull request. Tasks with nothing in "After" start in parallel. ${how}_`);
  return lines.join('\n');
}

export type GateCommand = { kind: 'approve'; by: string; note: string } | { kind: 'reject'; by: string; reason: string } | { kind: 'retry'; by: string; note: string };

/**
 * Commands in the comments after the factory's last comment carrying `tag`. Each command
 * is a line starting with /approve, /reject or /retry; the last one wins. Who may decide
 * is checked by the caller.
 */
export function commandsAfter(comments: TrackerComment[], tag: string): GateCommand[] {
  let start = -1;
  comments.forEach((c, i) => {
    if (c.byFactory && c.body.includes(tag)) start = i;
  });
  if (start < 0) return [];
  const out: GateCommand[] = [];
  for (const c of comments.slice(start + 1)) {
    if (c.byFactory) continue;
    const by = c.author.handle ?? c.author.name;
    const m = /^\s*\/(approve|reject|retry)\b[ \t]*(.*)$/im.exec(c.body);
    if (!m) continue;
    const rest = `${m[2] ?? ''}${c.body.slice((m.index ?? 0) + m[0].length)}`.trim();
    const verb = m[1]!.toLowerCase();
    if (verb === 'approve') out.push({ kind: 'approve', by, note: rest });
    else if (verb === 'retry') out.push({ kind: 'retry', by, note: rest });
    else out.push({ kind: 'reject', by, reason: rest });
  }
  return out;
}

/** People's comments after the factory's comment carrying `tag` (answers to questions). */
export function repliesAfter(comments: TrackerComment[], tag: string): TrackerComment[] {
  const start = comments.findLastIndex((c) => c.byFactory && c.body.includes(tag));
  return start < 0 ? [] : comments.slice(start + 1).filter((c) => !c.byFactory);
}

/** `<!-- cradleworks: base=release/2 -->` in an issue picks the branch the work starts from and merges into. */
export function baseDirective(body: string): string | undefined {
  const m = /<!--\s*cradleworks:\s*base=([A-Za-z0-9._\/-]+)\s*-->/.exec(body);
  return m?.[1];
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'spec'
  );
}

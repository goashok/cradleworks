// What the console's work item and run pages say, built from stored state alone. Each page tells
// its story in the order a person asks: where does this stand and do you need me; what was agreed;
// what happened; and only then the raw detail, folded away.
//
// Pure: no I/O. Everything from the store is escaped; agent text is shown as plain text with
// `code` and **bold** picked out, never as HTML.

import type { AgentEvent, SpecDocument, StoredEvent } from '@cradleworks/interfaces';
import type { CheckResult, Evidence, Run, Task, WorkItem } from '@cradleworks/core';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const money = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`;

/** Agent text: escaped, line breaks kept, `code` and **bold** shown as such. */
export function prose(text: string): string {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

export function when(at: string | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function duration(from: string | undefined, to: string | undefined): string {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

// --- states in words ------------------------------------------------------------

type Tone = 'ok' | 'wait' | 'bad' | 'busy' | 'idle';

export const chip = (label: string, tone: Tone) => `<span class="chip ${tone}">${esc(label)}</span>`;

const TASK_WORDS: Record<string, [string, Tone]> = {
  queued: ['Waiting to start', 'idle'],
  building: ['Being built', 'busy'],
  verifying: ['Being checked', 'busy'],
  rework: ['Being reworked', 'busy'],
  ready: ['Ready', 'wait'],
  merged: ['Merged', 'ok'],
  escalated: ['Needs a person', 'wait'],
  budget_exceeded: ['Over budget', 'wait'],
  failed: ['Failed', 'bad'],
  cancelled: ['Cancelled', 'idle'],
};

export function taskState(t: Task): [string, Tone] {
  if (t.state === 'ready') return t.changeApproved ? ['Approved, merging', 'busy'] : ['Waiting for approval', 'wait'];
  return TASK_WORDS[t.state] ?? [t.state.replace(/_/g, ' '), 'idle'];
}

/** One sentence on where the work stands, and whether a person is needed. */
export function headline(wi: WorkItem): { text: string; tone: Tone; needsYou: boolean } {
  const waitingTask = ['merged', 'failed', 'cancelled'].includes(wi.state) ? undefined : wi.tasks.find((t) => ['escalated', 'budget_exceeded', 'failed'].includes(t.state) || (t.state === 'ready' && !t.changeApproved));
  switch (wi.state) {
    case 'received':
      return { text: 'Received. The factory starts on it at its next pass.', tone: 'idle', needsYou: false };
    case 'specifying':
      return { text: 'The spec agent is turning the request into a spec.', tone: 'busy', needsYou: false };
    case 'awaiting_spec_approval':
      return { text: 'The spec is written and waits for someone to approve it or send it back.', tone: 'wait', needsYou: true };
    case 'planning':
      return wi.proposedTasks.length
        ? { text: `The planner proposed ${wi.proposedTasks.length} task${wi.proposedTasks.length > 1 ? 's' : ''}; the plan waits for its check.`, tone: 'wait', needsYou: false }
        : { text: 'The planner is splitting the spec into tasks.', tone: 'busy', needsYou: false };
    case 'merged':
      return { text: `Done. ${wi.tasks.length > 1 ? `All ${wi.tasks.length} tasks are` : 'The change is'} merged.`, tone: 'ok', needsYou: false };
    case 'blocked':
      return { text: `Stopped: ${wi.blockedReason ?? 'it is blocked'}.`, tone: 'wait', needsYou: true };
    case 'failed':
      return { text: `Failed: ${wi.endReason ?? 'see the runs below'}.`, tone: 'bad', needsYou: false };
    case 'cancelled':
      return { text: `Cancelled${wi.endReason ? `: ${wi.endReason}` : ''}.`, tone: 'idle', needsYou: false };
    default: {
      if (waitingTask) {
        const [label] = taskState(waitingTask);
        return { text: `“${waitingTask.title}” — ${label.toLowerCase()}${waitingTask.lastReason ? `: ${waitingTask.lastReason}` : '.'}`, tone: 'wait', needsYou: true };
      }
      const merged = wi.tasks.filter((t) => t.state === 'merged').length;
      const active = wi.tasks.filter((t) => ['building', 'verifying', 'rework'].includes(t.state));
      const doing = active.length ? ` Working on: ${active.map((t) => `“${t.title}” (${taskState(t)[0].toLowerCase()})`).join(', ')}.` : '';
      return { text: `${merged} of ${wi.tasks.length} task${wi.tasks.length === 1 ? '' : 's'} merged.${doing}`, tone: 'busy', needsYou: false };
    }
  }
}

/** Where the work item is on its way: request, spec, plan, build, done. */
export function steps(wi: WorkItem): string {
  const names = ['Request', 'Spec', 'Plan', 'Build & check', 'Merged'];
  const at: Record<string, number> = { received: 0, specifying: 1, awaiting_spec_approval: 1, planning: 2, in_progress: 3, awaiting_change_approval: 3, merged: 4 };
  // Stopped, or waiting on a person: the current step shows amber rather than as work under way.
  const stopped = ['blocked', 'failed', 'cancelled'].includes(wi.state) || headline(wi).needsYou;
  const from = wi.state === 'blocked' && wi.blockedFrom ? wi.blockedFrom : wi.tasks.length ? 'in_progress' : wi.spec ? 'planning' : 'specifying';
  const current = ['blocked', 'failed', 'cancelled'].includes(wi.state) ? (at[from] ?? 0) : (at[wi.state] ?? 0);
  // A task submitted without an issue has no spec or plan.
  const skipped = (i: number) => !wi.spec && wi.tasks.length > 0 && (i === 1 || i === 2);
  return `<ol class="steps">${names
    .map((n, i) => {
      const cls = skipped(i) ? 'skip' : i < current || wi.state === 'merged' ? 'done' : i === current ? (stopped ? 'stop' : 'now') : '';
      return `<li class="${cls}">${esc(n)}</li>`;
    })
    .join('')}</ol>`;
}

// --- runs -----------------------------------------------------------------------

/** A run's name in words: who ran and for what. */
export function runName(r: { station: Run['station']; agentProfile?: Run['agentProfile'] | undefined }): string {
  const role = r.agentProfile?.role;
  switch (r.station) {
    case 'specify':
      return 'Spec agent writes the spec';
    case 'approve_spec':
      return 'Spec check';
    case 'plan':
      return role === 'planner' ? 'Planner splits the work' : 'Plan check';
    case 'build':
      return 'Build: the implementer writes the change';
    case 'verify':
      return 'Verify: checks, tests and review';
    default:
      return r.station.replace(/_/g, ' ');
  }
}

const OUTCOME: Record<string, [string, Tone]> = {
  succeeded: ['Succeeded', 'ok'],
  failed: ['Failed', 'bad'],
  stopped: ['Stopped', 'idle'],
  timed_out: ['Timed out', 'bad'],
  limit_reached: ['Spend limit reached', 'wait'],
};
export const verdictChip = (v: string) => (v === 'pass' ? chip('Passed', 'ok') : v === 'rework' ? chip('Sent back for rework', 'wait') : chip('Escalated to a person', 'wait'));
export const outcomeChip = (o: string | undefined) => (o ? chip(...(OUTCOME[o] ?? [o, 'idle'])) : chip('Running', 'busy'));

/** Model spend per run, from the work item's cost records. */
export function costByRun(wiEvents: StoredEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of wiEvents) {
    if (e.type !== 'agent_cost_recorded') continue;
    const p = e.payload as { runId?: string; costUsd?: number };
    if (p.runId) out.set(p.runId, (out.get(p.runId) ?? 0) + (p.costUsd ?? 0));
  }
  return out;
}

// --- the work item's story ------------------------------------------------------

export interface StoryLine {
  at: string;
  text: string;
  tone: Tone;
  runId?: string;
}

/** The work item's events as sentences, oldest first. */
export function story(wi: WorkItem, wiEvents: StoredEvent[]): StoryLine[] {
  const title = new Map([...wi.tasks, ...wi.proposedTasks].map((t) => [t.id, t.title]));
  const of = (id: unknown) => (title.has(String(id)) ? `“${title.get(String(id))}”` : 'a task');
  const runFor = new Map<string, string>();
  const out: StoryLine[] = [];
  for (const e of wiEvents) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const add = (text: string, tone: Tone = 'idle', runId?: string) => out.push({ at: e.at, text, tone, ...(runId ? { runId } : {}) });
    switch (e.type) {
      case 'work_item_received':
        add(`Request received from ${String(p.requester ?? 'someone')}.`);
        break;
      case 'run_started': {
        const r = { station: p.station as Run['station'], agentProfile: p.agentProfile as Run['agentProfile'] };
        runFor.set(String(p.runId), runName(r));
        break;
      }
      case 'run_ended':
        if (p.outcome !== 'succeeded') add(`${runFor.get(String(p.runId)) ?? 'A run'} ${String(p.outcome).replace(/_/g, ' ')}${p.reason ? `: ${String(p.reason)}` : '.'}`, 'bad', String(p.runId));
        break;
      case 'spec_drafted':
        add(`Spec version ${String(p.version)} written.`);
        break;
      case 'tasks_planned': {
        const n = (p.tasks as unknown[] | undefined)?.length ?? 0;
        add(`Planned as ${n} task${n === 1 ? '' : 's'}.`);
        break;
      }
      case 'gate_decided': {
        const gate = { spec_approval: 'Spec', plan_check: 'Plan', change_approval: `Change to ${of(p.subjectId)}` }[String(p.gate)] ?? String(p.gate);
        const by = p.mode === 'ai' ? `${String(p.decidedBy)}, automatically` : String(p.decidedBy);
        const approved = p.verdict === 'approved';
        add(`${gate} ${approved ? 'approved' : 'sent back'} by ${by}${!approved && p.reason ? `: ${String(p.reason)}` : '.'}`, approved ? 'ok' : 'wait');
        break;
      }
      case 'task_started':
        add(`Started ${of(p.taskId)}.`, 'busy');
        break;
      case 'task_pr_opened':
        add(`Opened a pull request for ${of(p.taskId)}.`);
        break;
      case 'task_acceptance_tests_written':
        add(`The tester wrote ${(p.files as unknown[] | undefined)?.length ?? 0} acceptance test file(s) for ${of(p.taskId)}, from the spec alone.`, 'idle', String(p.runId ?? ''));
        break;
      case 'task_verified':
        add(`${of(p.taskId)} checked: ${p.verdict === 'pass' ? 'passed' : p.verdict === 'rework' ? 'sent back for rework' : 'escalated to a person'}${p.verdict === 'pass' ? '.' : ` — ${String(p.reason ?? '')}`}`, p.verdict === 'pass' ? 'ok' : 'wait');
        break;
      case 'task_rework_started':
        add(`Reworking ${of(p.taskId)}.`, 'busy');
        break;
      case 'task_tests_disputed':
        add(`The implementer disputed the acceptance tests for ${of(p.taskId)}; they were reviewed once.`, 'wait');
        break;
      case 'task_declined':
        add(`The implementer made no change to ${of(p.taskId)}: ${String(p.reason ?? '').split('\n')[0]}`, 'wait');
        break;
      case 'task_merged':
        add(`Merged ${of(p.taskId)}.`, 'ok');
        break;
      case 'task_failed':
        add(`${of(p.taskId)} failed: ${String(p.reason ?? '')}`, 'bad');
        break;
      case 'work_item_blocked':
        add(`Stopped: ${String(p.reason ?? '')}`, 'wait');
        break;
      case 'work_item_cancelled':
        add(`Cancelled: ${String(p.reason ?? '')}`, 'idle');
        break;
      default:
        break;
    }
  }
  return out;
}

// --- sections of the work item page ---------------------------------------------

export function specSection(spec: SpecDocument | undefined, wi: WorkItem): string {
  if (!spec) return wi.spec ? '<p class="muted">The spec is kept in the project repository, not in this factory’s store.</p>' : '';
  const list = (items: string[] | undefined, ordered = false) =>
    items?.length ? `<${ordered ? 'ol' : 'ul'}>${items.map((i) => `<li>${prose(i)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '';
  const approval = spec.approval ? chip(`Approved by ${spec.approval.by}`, 'ok') : chip('Not approved yet', 'wait');
  // Read in full when it waits for approval; afterwards it is reference, folded.
  const open = wi.state === 'awaiting_spec_approval' ? ' open' : '';
  const fold = (title: string, n: number, body: string) => (n ? `<details${open}><summary><b>${esc(title)}</b> <span class="muted">(${n})</span></summary>${body}</details>` : '');
  return `<section class="card"><div class="row"><h2>Spec${spec.version > 1 ? `, version ${spec.version}` : ''}</h2>${approval}</div>
<p class="lead">${prose(spec.problem)}</p>
${fold('Done when', spec.acceptanceCriteria.length, list(spec.acceptanceCriteria, true))}
${fold('Assumed, where the request was silent', spec.assumptions?.length ?? 0, list(spec.assumptions))}
${fold('Out of scope', spec.outOfScope.length, list(spec.outOfScope))}</section>`;
}

function checksTable(checks: CheckResult[]): string {
  if (!checks.length) return '';
  const rows = checks.map((c) => {
    const ok = c.outcome === 'passed';
    const mark = ok ? '<span class="ok-t">✓</span>' : c.outcome === 'skipped' ? '<span class="muted">–</span>' : '<span class="bad-t">✗</span>';
    const tail = !ok && c.outputTail ? `<details><summary>Output</summary><pre>${esc(c.outputTail)}</pre></details>` : '';
    return `<tr><td>${mark} ${esc(c.name)}${c.flaky ? ' <span class="muted">(passed on a second run)</span>' : ''}${tail}</td><td class="num muted">${(c.durationMs / 1000).toFixed(0)} s</td></tr>`;
  });
  return `<table class="compact">${rows.join('')}</table>`;
}

/** The latest check in one line: what passed and what the reviewer said. */
export function evidenceLine(ev: Evidence): string {
  const failed = ev.checks.filter((c) => c.outcome === 'failed' || c.outcome === 'timed_out').length;
  const checks = failed ? `${failed} of ${ev.checks.length} checks failed` : `${ev.checks.length} check${ev.checks.length === 1 ? '' : 's'} passed`;
  const ci = ev.ci.state === 'passed' ? 'CI passed' : ev.ci.state === 'failed' ? 'CI failed' : '';
  const review = ev.review ? `reviewer: ${ev.review.verdict}, ${ev.review.risk} risk` : '';
  return [checks, ci, review].filter(Boolean).join(' · ');
}

export function evidenceBlock(ev: Evidence, runHref?: string, folded = false): string {
  if (folded) return `<details class="evidence"><summary><b>Latest check</b> ${ev.verdict === 'pass' ? chip('Passed', 'ok') : chip(ev.verdict, 'wait')} <span class="muted small">${esc(evidenceLine(ev))}</span></summary>${evidenceBlock(ev, runHref)}</details>`;
  const verdict = ev.verdict === 'pass' ? chip('Passed', 'ok') : ev.verdict === 'rework' ? chip('Sent back for rework', 'wait') : chip('Escalated to a person', 'wait');
  const ci = { passed: '✓ passed', failed: '✗ failed', timed_out: 'timed out', none: 'no run found', not_configured: 'not configured', skipped: 'skipped', error: 'error' }[ev.ci.state];
  const ciLinks = ev.ci.runs.map((r) => `<a href="${esc(r.url)}" rel="noreferrer">run</a>`).join(', ');
  const review = ev.review
    ? `<div class="sub"><b>Reviewer</b> ${chip(`${ev.review.verdict === 'pass' ? 'pass' : ev.review.verdict}, ${ev.review.risk} risk`, ev.review.verdict === 'pass' ? 'ok' : 'wait')}${ev.review.reasons.length ? `<ul>${ev.review.reasons.map((r) => `<li>${prose(r)}</li>`).join('')}</ul>` : ''}</div>`
    : '<div class="sub muted">The reviewer did not run: the checks decided first.</div>';
  return `<div class="evidence"><div class="row"><b>Latest check</b> ${verdict}<span class="muted">${when(ev.verifiedAt)}${runHref ? ` · <a href="${esc(runHref)}">see the run</a>` : ''}</span></div>
<div class="cols"><div><div class="label">Project checks</div>${checksTable(ev.checks)}</div><div><div class="label">CI</div><p>${esc(ci)} ${ciLinks}${ev.ci.note ? `<br><span class="muted">${esc(ev.ci.note)}</span>` : ''}</p></div></div>${review}</div>`;
}

export function taskCard(t: Task, wi: WorkItem, actions: string): string {
  const [label, tone] = taskState(t);
  const deps = t.dependsOn.map((d) => wi.tasks.find((x) => x.id === d)?.title ?? d);
  const facts = [
    t.pr ? `<a href="${esc(t.pr.url)}" rel="noreferrer">pull request</a>` : '',
    t.repo ? `in ${esc(t.repo)}` : '',
    `size ${esc(t.size)}`,
    `spent ${money(t.spentUsd)}`,
    t.reworkLoops ? `${t.reworkLoops} rework round${t.reworkLoops > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  const finished = ['merged', 'failed', 'cancelled'].includes(wi.state);
  const needs = !finished && (['escalated', 'budget_exceeded', 'failed'].includes(t.state) || (t.state === 'ready' && !t.changeApproved));
  return `<section class="card${needs ? ' attention' : ''}"><div class="row"><h3>${esc(t.title)}</h3>${chip(label, tone)}</div>
<p class="muted small">${facts.join(' · ')}</p>
${deps.length && t.state === 'queued' ? `<p class="muted small">Starts after: ${deps.map((d) => `“${esc(d)}”`).join(', ')}</p>` : ''}
${t.protectedPaths?.length ? `<p class="note">Changes protected files (${t.protectedPaths.map((p) => `<code>${esc(p)}</code>`).join(', ')}), so a person must approve and merge it.</p>` : ''}
${t.lastReason && needs ? `<p class="note">${prose(t.lastReason)}</p>` : ''}
${actions}
${t.evidence ? evidenceBlock(t.evidence, `/run/${t.evidence.runId}`, t.state === 'merged' || t.state === 'cancelled') : ''}
${t.acceptanceTests?.files.length ? `<p class="muted small">Acceptance tests from the tester: ${t.acceptanceTests.files.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>` : ''}
${t.description ? `<details><summary>What the task asks</summary><div class="text">${prose(t.description)}</div></details>` : ''}</section>`;
}

export function storySection(lines: StoryLine[]): string {
  if (!lines.length) return '';
  return `<h2>What happened</h2><ol class="story">${lines
    .map((l) => {
      // A long reason is cut to its start; the whole of it is one click away.
      const text = l.text.length > 200 ? `${prose(l.text.slice(0, 180).replace(/\s+\S*$/, ''))}… <details><summary>more</summary><div class="text">${prose(l.text)}</div></details>` : prose(l.text);
      return `<li class="t-${l.tone}"><span class="when">${esc(when(l.at))}</span><span>${text}${l.runId ? ` <a href="/run/${esc(l.runId)}">run</a>` : ''}</span></li>`;
    })
    .join('')}</ol>`;
}

export function runsTable(wi: WorkItem, costs: Map<string, number>): string {
  if (!wi.runs.length) return '';
  const subject = (id: string) => wi.tasks.find((t) => t.id === id)?.title;
  const rows = [...wi.runs].reverse().map((r) => {
    const task = subject(r.subjectId);
    return `<tr><td><a href="/run/${esc(r.id)}">${esc(runName(r))}</a>${task ? `<div class="muted small">${esc(task)}</div>` : ''}</td>
<td>${outcomeChip(r.outcome)}</td><td class="num muted hide-sm">${esc(when(r.startedAt))}</td><td class="num muted">${esc(duration(r.startedAt, r.endedAt))}</td><td class="num">${costs.has(r.id) ? money(costs.get(r.id)) : ''}</td></tr>`;
  });
  return `<h2>Runs</h2><p class="muted small">Every agent run, newest first. Each page shows what the agent did, step by step.</p><div class="scroll"><table><tr><th>Run</th><th>Outcome</th><th class="hide-sm">Started</th><th>Took</th><th>Cost</th></tr>${rows.join('')}</table></div>`;
}

// --- the run page ---------------------------------------------------------------

interface Segment {
  name: string;
  started?: Record<string, unknown>;
  events: AgentEvent[];
}

/** Which agent an agent segment was, from what the run recorded right after it. */
function agentRole(after: string | undefined, station: string, what?: string): string {
  switch (after) {
    case 'acceptance_tests':
      return 'Tester: writes acceptance tests from the spec, without seeing the change';
    case 'review_decided':
      return 'Reviewer: judges the change';
    case 'tests_reviewed':
      return 'Test review: rechecks disputed acceptance tests';
    case 'check_decided':
      return `${what === 'plan' ? 'Plan' : 'Spec'} checker`;
    default:
      return { specify: 'Spec agent', plan: 'Planner', build: 'Implementer', verify: 'Agent' }[station] ?? 'Agent';
  }
}

export interface RunView {
  runId: string;
  events: StoredEvent[];
  run?: Run;
  wi?: WorkItem;
  cost?: number;
}

const ICON: Record<string, string> = { Bash: '$', shell: '$', Read: '📄', Edit: '✎', Write: '✎', MultiEdit: '✎', apply_patch: '✎', Grep: '🔍', Glob: '🔍', WebFetch: '🌐', web_search: '🌐', TodoWrite: '☑' };

function toolSummary(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) if (typeof o[key] === 'string') return o[key] as string;
  return tool === 'TodoWrite' ? 'updates its to-do list' : JSON.stringify(input ?? '').slice(0, 200);
}

/** A message without the JSON answer it ends with, if it ends with one. */
export function withoutAnswer(message: string): { text: string; answered: boolean } {
  const text = message.trim();
  if (!text.endsWith('}') && !text.endsWith('```')) return { text, answered: false };
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```\s*$/.exec(text);
  const candidates = fenced ? [fenced.index] : [...text.matchAll(/\{/g)].map((m) => m.index!);
  for (const start of candidates) {
    const raw = fenced ? fenced[1]! : text.slice(start);
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return { text: text.slice(0, start).trim(), answered: true };
    } catch {
      // not the start of the answer; try the next brace
    }
  }
  return { text, answered: false };
}

function conversation(events: AgentEvent[]): string {
  const results = new Map<string, { output: string; isError: boolean }>();
  for (const e of events) if (e.type === 'tool_result') results.set(e.callId, { output: e.output, isError: e.isError });
  const out: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'message': {
        // An agent's answer ends with a JSON object the factory reads; the Result above says it in words.
        const { text, answered } = withoutAnswer(e.text);
        if (text) out.push(`<div class="msg ${e.role === 'assistant' ? '' : 'sys'}">${prose(text)}</div>`);
        if (answered) out.push('<p class="muted small">↳ Ended with its answer in the form the factory reads; Result, at the top, says it in words.</p>');
        break;
      }
      case 'tool_call': {
        const r = results.get(e.callId);
        const summary = toolSummary(e.tool, e.input);
        out.push(`<details class="tool${r?.isError ? ' err' : ''}"><summary><span class="icon">${esc(ICON[e.tool] ?? '•')}</span><span class="tname">${esc(e.tool)}</span> <code>${esc(summary.length > 160 ? `${summary.slice(0, 160)}…` : summary)}</code>${r?.isError ? ' <span class="bad-t">failed</span>' : ''}</summary>${r ? `<pre>${esc(r.output || '(no output)')}</pre>` : '<p class="muted small">No result was recorded.</p>'}</details>`);
        break;
      }
      case 'denied':
        out.push(`<div class="msg denied">Refused: <code>${esc(e.tool)}</code> ${esc(e.detail)}</div>`);
        break;
      case 'done': {
        const t = e.total;
        out.push(`<p class="muted small">Agent ${esc(e.outcome)} · ${(t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)).toLocaleString('en')} tokens in, ${t.outputTokens.toLocaleString('en')} out · ${money(t.costUsd)}${e.error ? ` · ${esc(e.error)}` : ''}</p>`);
        break;
      }
      default:
        break;
    }
  }
  const files = events.filter((e): e is Extract<AgentEvent, { type: 'file_change' }> => e.type === 'file_change');
  if (files.length) out.push(`<p class="small"><b>Files changed:</b> ${[...new Set(files.map((f) => `${f.change} ${f.path}`))].map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>`);
  return out.join('\n');
}

/** The run's outcome in the terms of its station: what it decided or produced. */
function resultSection(events: StoredEvent[], wiId?: string): string {
  const parts: string[] = [];
  const checks = events.filter((e) => e.type === 'check_ran').map((e) => e.payload as unknown as CheckResult);
  if (checks.length) parts.push(`<div><div class="label">Project checks</div>${checksTable(checks)}</div>`);
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case 'spec_written':
        parts.push(`<p>Saved the approved spec in the repository at <code>${esc(p.path)}</code>.</p>`);
        break;
      case 'spec_answer':
        parts.push(p.kind === 'questions' ? '<p>Asked the requester questions before writing a spec.</p>' : `<p>Drafted the spec.${wiId ? ` <a href="/wi/${esc(wiId)}">Read it on the work item</a>.` : ''}</p>`);
        break;
      case 'plan_checked': {
        const problems = (p.problems as string[] | undefined) ?? [];
        parts.push(problems.length ? `<p>Plan, attempt ${esc(p.attempt)}: broke the rules.</p><ul>${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p>Plan, attempt ${esc(p.attempt)}: keeps every rule.</p>`);
        break;
      }
      case 'check_decided': {
        const reasons = (p.reasons as string[] | undefined) ?? [];
        parts.push(`<p>${p.what === 'plan' ? 'Plan' : 'Spec'} ${p.verdict === 'approved' ? chip('approved', 'ok') : chip('sent back', 'wait')}</p>${reasons.length ? `<ul>${reasons.map((r) => `<li>${prose(r)}</li>`).join('')}</ul>` : ''}`);
        break;
      }
      case 'acceptance_tests':
        parts.push(`<p>Tester wrote ${((p.files as string[] | undefined) ?? []).map((f) => `<code>${esc(f)}</code>`).join(', ')}.</p>`);
        break;
      case 'tests_reviewed':
        parts.push(`<p>Disputed tests ${p.verdict === 'revised' ? 'revised' : 'upheld'}.</p><ul>${((p.reasons as string[] | undefined) ?? []).map((r) => `<li>${prose(r)}</li>`).join('')}</ul>`);
        break;
      case 'review_decided': {
        const reasons = (p.reasons as string[] | undefined) ?? [];
        parts.push(`<div><b>Reviewer</b> ${chip(`${String(p.verdict)}, ${String(p.risk)} risk`, p.verdict === 'pass' ? 'ok' : 'wait')}${reasons.length ? `<ul>${reasons.map((r) => `<li>${prose(r)}</li>`).join('')}</ul>` : ''}</div>`);
        break;
      }
      case 'ci_checked':
        parts.push(`<p><b>CI</b> ${esc(String(p.state).replace(/_/g, ' '))}${((p.runs as Array<{ url: string }> | undefined) ?? []).map((r) => ` · <a href="${esc(r.url)}" rel="noreferrer">run</a>`).join('')}${p.note ? ` <span class="muted">(${esc(p.note)})</span>` : ''}</p>`);
        break;
      case 'evidence': {
        const reason = String(p.reason ?? '');
        const byReviewer = reason.startsWith('reviewer:');
        parts.push(`<p><b>Verdict</b> ${verdictChip(String(p.verdict))} ${byReviewer ? '<span class="muted">for the reviewer’s reasons above</span>' : esc(reason)}</p>`);
        break;
      }
      case 'changes_committed':
        parts.push(`<p>Committed <code>${esc(String(p.sha).slice(0, 12))}</code>.</p>`);
        break;
      case 'pr_opened':
        parts.push(`<p>Opened <a href="${esc(p.url)}" rel="noreferrer">a pull request</a>.</p>`);
        break;
      case 'task_declined':
        parts.push(`<div class="note"><b>Made no change.</b> ${prose(String(p.reason ?? ''))}</div>`);
        break;
      case 'protected_paths_changed':
        parts.push(`<p class="note">Touched protected files: ${((p.paths as string[] | undefined) ?? []).map((x) => `<code>${esc(x)}</code>`).join(', ')}. A person must approve and merge.</p>`);
        break;
      case 'step_failed':
        parts.push(`<p class="note bad-t">${esc(p.step)} failed: ${esc(p.error)}</p>`);
        break;
      default:
        break;
    }
  }
  return parts.length ? `<section class="card"><h2>Result</h2>${parts.join('\n')}</section>` : '';
}

function environment(events: StoredEvent[]): string {
  const rows: string[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === 'sandbox_created') {
      const net = p.network as { mode?: string; allow?: string[] } | undefined;
      rows.push(`<li>Sandbox <code>${esc(p.sandboxId)}</code> on <code>${esc(p.branch)}</code>; network ${esc(net?.mode ?? '?')}${net?.allow?.length ? `: ${net.allow.map((h) => `<code>${esc(h)}</code>`).join(' ')}` : ''}</li>`);
    } else if (e.type === 'context_pack_built') {
      const files = (p.files as Array<{ path: string; kind?: string; sha256?: string }> | undefined) ?? [];
      const dropped = (p.dropped as string[] | undefined) ?? [];
      const file = (f: { path: string; sha256?: string }) => `<code>${esc(f.path)}</code>${f.sha256 ? ` <span class="muted small" title="${esc(f.sha256)}">${esc(f.sha256.replace('sha256:', '').slice(0, 10))}</span>` : ''}`;
      const added = files.filter((f) => f.kind === 'prompt');
      const rules = files.filter((f) => f.kind !== 'prompt');
      const who = p.role ? `the ${esc(p.role)}` : 'the agent';
      if (added.length) rows.push(`<li>Team's prompt addition for ${who}: ${added.map(file).join(', ')}</li>`);
      rows.push(`<li>Project rules given to ${who}: ${rules.length ? rules.map(file).join(', ') : 'none'}</li>`);
      if (dropped.length) rows.push(`<li class="bad-t">Left out, over the context budget: ${dropped.map((d) => `<code>${esc(d)}</code>`).join(', ')}</li>`);
    } else if (e.type === 'network_decisions') {
      const ds = (p.decisions as Array<{ host: string; port: number; decision: string; reason?: string }> | undefined) ?? [];
      const denied = ds.filter((d) => d.decision === 'deny');
      const hosts = new Map<string, number>();
      for (const d of ds.filter((x) => x.decision !== 'deny')) hosts.set(d.host, (hosts.get(d.host) ?? 0) + 1);
      rows.push(`<li>Network: ${Number(p.allowed ?? 0)} request(s) allowed${hosts.size ? ` (${[...hosts].map(([h, n]) => `<code>${esc(h)}</code> ×${n}`).join(', ')})` : ''}, ${denied.length ? `<span class="bad-t">${denied.length} refused</span>: ${denied.map((d) => `<code>${esc(d.host)}:${esc(d.port)}</code>${d.reason ? ` (${esc(d.reason)})` : ''}`).join(', ')}` : 'none refused'}</li>`);
    } else if (e.type === 'agent_started') {
      const l = p.limits as { maxWallSeconds?: number; maxSpendUsd?: number } | undefined;
      rows.push(`<li>Agent <code>${esc(p.agent)}</code> on <code>${esc(p.model)}</code>, limits ${l?.maxWallSeconds ? `${Math.round(l.maxWallSeconds / 60)} min` : '—'} and ${l?.maxSpendUsd !== undefined ? money(l.maxSpendUsd) : '—'}</li>`);
    }
  }
  return rows.length ? `<details class="card"><summary><b>Where it ran</b> <span class="muted small">sandbox, network, rules, limits</span></summary><ul>${rows.join('')}</ul></details>` : '';
}

export function runBody(v: RunView, rawLog: string): string {
  const ctx = v.events.find((e) => e.type === 'run_context')?.payload as { workItemId?: string; taskId?: string; station?: string; attempt?: number } | undefined;
  const station = v.run?.station ?? (ctx?.station as Run['station'] | undefined) ?? 'build';
  const name = v.run ? runName(v.run) : runName({ station });
  const task = v.wi?.tasks.find((t) => t.id === (v.run?.subjectId ?? ctx?.taskId));
  const ended = v.events.find((e) => e.type === 'run_ended');
  // What each agent in the run reported spending; the tester's spend is recorded under its own id.
  const agentCost = v.events.reduce((sum, e) => {
    const ev = e.type === 'agent_event' ? (e.payload as { event?: AgentEvent }).event : undefined;
    return ev?.type === 'done' ? sum + ev.total.costUsd : sum;
  }, 0);
  const cost = agentCost > 0 ? agentCost : v.cost;
  const verdict = (v.events.find((e) => e.type === 'evidence')?.payload as { verdict?: string } | undefined)?.verdict;
  const decided = (v.events.find((e) => e.type === 'check_decided')?.payload as { verdict?: string } | undefined)?.verdict;
  const outcome = v.run?.outcome ?? (ended?.payload as { outcome?: string } | undefined)?.outcome;
  const started = v.run?.startedAt ?? v.events[0]?.at;
  const facts = [
    started ? `started ${when(started)}` : '',
    duration(started, v.run?.endedAt ?? ended?.at) ? `took ${duration(started, v.run?.endedAt ?? ended?.at)}` : '',
    cost !== undefined ? `cost ${money(cost)}` : '',
    (ctx?.attempt ?? 1) > 1 ? `attempt ${ctx!.attempt}` : '',
  ].filter(Boolean);

  // Split the agent events into one segment per agent, named by what the run recorded next.
  const segments: Segment[] = [];
  let current: Segment | undefined;
  for (const e of v.events) {
    if (e.type === 'agent_started') {
      current = { name: '', started: e.payload as Record<string, unknown>, events: [] };
      segments.push(current);
    } else if (e.type === 'agent_event' && current) {
      const ev = (e.payload as { event?: AgentEvent }).event;
      if (ev && ev.type !== 'usage') current.events.push(ev);
    } else if (current && !current.name && ['acceptance_tests', 'review_decided', 'tests_reviewed', 'check_decided', 'spec_answer', 'plan_checked', 'changes_committed', 'task_declined'].includes(e.type)) {
      current.name = agentRole(e.type, station, (e.payload as { what?: string }).what);
    }
  }
  for (const s of segments) if (!s.name) s.name = agentRole(undefined, station);
  const agents = segments
    .map((s, i) => `<section class="card"><h2>${esc(s.name)}</h2>${segments.length > 1 ? `<p class="muted small">Agent ${i + 1} of ${segments.length} in this run.</p>` : ''}${conversation(s.events) || '<p class="muted">It recorded nothing.</p>'}</section>`)
    .join('\n');

  const crumbs = v.wi ? `<p class="crumbs"><a href="/runs">Runs</a> › <a href="/wi/${esc(v.wi.id)}">${esc(v.wi.title)}</a>${task ? ` › ${esc(task.title)}` : ''}</p>` : '';
  return `${crumbs}<div class="row"><h1>${esc(name)}</h1>${outcome !== undefined && outcome !== 'succeeded' ? outcomeChip(outcome) : verdict ? verdictChip(verdict) : decided ? (decided === 'approved' ? chip('Approved', 'ok') : chip('Sent back', 'wait')) : outcomeChip(outcome)}</div>
<p class="muted">${esc(facts.join(' · '))}${v.run?.agentProfile ? ` · ${esc(v.run.agentProfile.agent ?? '')} ${esc(v.run.agentProfile.model ?? '')}` : ''}</p>
${resultSection(v.events, v.wi?.id ?? ctx?.workItemId)}
${agents}
${environment(v.events)}
<details class="card"><summary><b>Raw log</b> <span class="muted small">as <code>factory log --full</code> prints it</span></summary><pre>${esc(rawLog)}</pre></details>`;
}

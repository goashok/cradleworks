// The console's overview pages: the dashboard it opens on, and the full lists of work and runs
// behind it. The dashboard answers, in order: does anything need me; what is moving; what just
// happened; and what it has cost. Every number on it links to the list it counts.
//
// Pure: no I/O. Everything from the store is escaped.

import type { Run, WorkItem } from '@cradleworks/core';
import { chip, esc, headline, money, outcomeChip, runName, when } from './console-view.ts';

const WAITING = new Set(['awaiting_spec_approval', 'awaiting_change_approval', 'blocked']);
const TASK_WAITING = new Set(['escalated', 'budget_exceeded', 'failed']);
export const FINISHED = new Set(['merged', 'failed', 'cancelled']);
const DAY = 86_400_000;

export function needsPerson(wi: WorkItem): boolean {
  if (FINISHED.has(wi.state)) return false;
  return WAITING.has(wi.state) || wi.tasks.some((t) => TASK_WAITING.has(t.state) || (t.state === 'ready' && !t.changeApproved));
}

/** What a waiting work item waits on, in a few words: the group it is counted in on the dashboard. */
export function waitKind(wi: WorkItem): string {
  if (wi.state === 'awaiting_spec_approval') return 'Spec to approve';
  if (wi.state === 'blocked') return 'Blocked';
  const t = wi.tasks.find((x) => TASK_WAITING.has(x.state) || (x.state === 'ready' && !x.changeApproved));
  if (!t) return 'Change to approve';
  return t.state === 'ready' ? 'Change to approve' : t.state === 'escalated' ? 'Escalated to you' : t.state === 'budget_exceeded' ? 'Over budget' : 'Failed, retry or cancel';
}

export type WorkFilter = 'all' | 'waiting' | 'active' | 'finished';
const WORK_FILTERS: Record<WorkFilter, { label: string; href: string; keep: (wi: WorkItem) => boolean; empty: string }> = {
  all: { label: 'All', href: '/work', keep: () => true, empty: 'No work items yet.' },
  waiting: { label: 'Needs you', href: '/waiting', keep: needsPerson, empty: 'Nothing is waiting on a person.' },
  active: { label: 'In progress', href: '/work?show=active', keep: (wi) => !FINISHED.has(wi.state) && !needsPerson(wi), empty: 'Nothing is in progress.' },
  finished: { label: 'Finished', href: '/work?show=finished', keep: (wi) => FINISHED.has(wi.state), empty: 'Nothing has finished yet.' },
};

/** Where a work item is, in a word or two, toned like its headline. */
function stage(wi: WorkItem): string {
  if (needsPerson(wi)) return chip(waitKind(wi), 'wait');
  const words: Record<string, [string, Parameters<typeof chip>[1]]> = {
    received: ['Received', 'idle'],
    specifying: ['Writing the spec', 'busy'],
    planning: ['Planning', 'busy'],
    in_progress: ['Building', 'busy'],
    merged: ['Merged', 'ok'],
    failed: ['Failed', 'bad'],
    cancelled: ['Cancelled', 'idle'],
  };
  return chip(...(words[wi.state] ?? [wi.state.replace(/_/g, ' '), 'idle']));
}

const tabs = (items: [string, string, number, boolean][]) =>
  `<nav class="tabs">${items.map(([label, href, n, on]) => `<a href="${href}"${on ? ' class="on" aria-current="page"' : ''}>${esc(label)} <span class="n">${n}</span></a>`).join('')}</nav>`;

const tasksDone = (wi: WorkItem) => (wi.tasks.length ? `${wi.tasks.filter((t) => t.state === 'merged').length}/${wi.tasks.length}` : '–');

export function workListBody(items: WorkItem[], filter: WorkFilter): string {
  const f = WORK_FILTERS[filter];
  const shown = items.filter(f.keep);
  const rows = shown.map(
    (wi) => `<tr><td><a href="/wi/${esc(wi.id)}">${esc(wi.title)}</a><div class="muted small hide-sm">${esc(wi.projectId)} · ${esc(wi.requester)}</div></td>
<td>${stage(wi)}</td><td class="num">${tasksDone(wi)}</td><td class="num">${money(wi.spentUsd)}</td><td class="num muted hide-sm">${esc(when(wi.updatedAt ?? wi.createdAt))}</td></tr>`,
  );
  const nav = tabs((Object.keys(WORK_FILTERS) as WorkFilter[]).map((k) => [WORK_FILTERS[k].label, WORK_FILTERS[k].href, items.filter(WORK_FILTERS[k].keep).length, k === filter]));
  return `<p class="crumbs"><a href="/">Dashboard</a></p><h1>Work</h1>${nav}${
    rows.length ? `<div class="scroll"><table><tr><th>Work item</th><th>Where it is</th><th>Tasks</th><th>Spent</th><th class="hide-sm">Updated</th></tr>${rows.join('')}</table></div>` : `<p class="muted">${f.empty}</p>`
  }`;
}

export interface RunRow {
  run: Run;
  wi: WorkItem;
}

export const allRuns = (items: WorkItem[]): RunRow[] =>
  items.flatMap((wi) => wi.runs.map((run) => ({ run, wi }))).sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));

export type RunFilter = 'all' | 'running' | 'failed';
const RUN_FILTERS: Record<RunFilter, { label: string; keep: (r: Run) => boolean; empty: string }> = {
  all: { label: 'All', keep: () => true, empty: 'No runs yet.' },
  running: { label: 'Running', keep: (r) => !r.outcome, empty: 'Nothing is running.' },
  failed: { label: 'Did not succeed', keep: (r) => !!r.outcome && r.outcome !== 'succeeded', empty: 'Every run succeeded.' },
};
const RUN_LIMIT = 200;

function runRow({ run, wi }: RunRow, costs: Map<string, number>, withWork = true): string {
  const task = wi.tasks.find((t) => t.id === run.subjectId)?.title;
  const what = withWork ? `<div class="muted small"><a class="quiet" href="/wi/${esc(wi.id)}">${esc(wi.title)}</a>${task && task !== wi.title ? ` · ${esc(task)}` : ''}</div>` : '';
  return `<tr><td><a href="/run/${esc(run.id)}">${esc(runName(run))}</a>${what}</td><td>${outcomeChip(run.outcome)}</td>
<td class="num muted hide-sm">${esc(when(run.startedAt))}</td><td class="num">${costs.has(run.id) ? money(costs.get(run.id)) : ''}</td></tr>`;
}

export function runsListBody(items: WorkItem[], costs: Map<string, number>, filter: RunFilter): string {
  const runs = allRuns(items);
  const f = RUN_FILTERS[filter];
  const shown = runs.filter((r) => f.keep(r.run));
  const nav = tabs((Object.keys(RUN_FILTERS) as RunFilter[]).map((k) => [RUN_FILTERS[k].label, k === 'all' ? '/runs' : `/runs?show=${k}`, runs.filter((r) => RUN_FILTERS[k].keep(r.run)).length, k === filter]));
  const more = shown.length > RUN_LIMIT ? `<p class="muted small">Showing the newest ${RUN_LIMIT} of ${shown.length}.</p>` : '';
  return `<p class="crumbs"><a href="/">Dashboard</a></p><h1>Runs</h1><p class="muted small">Every agent run across all work, newest first. Each opens to what the agent did, step by step.</p>${nav}${
    shown.length
      ? `<div class="scroll"><table><tr><th>Run</th><th>Outcome</th><th class="hide-sm">Started</th><th>Cost</th></tr>${shown.slice(0, RUN_LIMIT).map((r) => runRow(r, costs)).join('')}</table></div>${more}`
      : `<p class="muted">${f.empty}</p>`
  }`;
}

// --- the dashboard --------------------------------------------------------------

const ended = (wi: WorkItem) => wi.runs.reduce((at, r) => (r.endedAt && r.endedAt > at ? r.endedAt : at), wi.updatedAt ?? wi.createdAt);

function tile(label: string, value: string, href: string, tone: string, sub = ''): string {
  return `<a class="tile ${tone}" href="${href}"><span class="label">${esc(label)}</span><span class="value">${value}</span>${sub ? `<span class="muted small">${sub}</span>` : ''}</a>`;
}

/** Runs per day for the last two weeks, split into succeeded and not; each bar links nowhere, its title says the numbers. */
function activity(runs: RunRow[], costs: Map<string, number>, now: number): string {
  const days = 14;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * DAY;
  const buckets = Array.from({ length: days }, (_, i) => ({ at: first + i * DAY, ok: 0, other: 0, cost: 0 }));
  for (const { run } of runs) {
    const i = Math.floor((Date.parse(run.startedAt) - first) / DAY);
    const b = buckets[i];
    if (!b) continue;
    if (run.outcome === 'succeeded' || !run.outcome) b.ok++;
    else b.other++;
    b.cost += costs.get(run.id) ?? 0;
  }
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.other));
  if (buckets.every((b) => b.ok + b.other === 0)) return '<p class="muted small">No runs in the last 14 days.</p>';
  const bars = buckets
    .map((b) => {
      const day = new Date(b.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const title = `${day}: ${b.ok + b.other} run${b.ok + b.other === 1 ? '' : 's'}${b.other ? `, ${b.other} did not succeed` : ''}, ${money(b.cost)}`;
      return `<div class="bar" title="${esc(title)}" aria-label="${esc(title)}"><div class="stack"><span class="bad" style="height:${(b.other / max) * 100}%"></span><span class="ok" style="height:${(b.ok / max) * 100}%"></span></div><span class="d">${new Date(b.at).getDate()}</span></div>`;
    })
    .join('');
  return `<div class="bars" role="img" aria-label="Runs per day, last 14 days">${bars}</div><p class="muted small legend"><span class="key ok"></span>succeeded or running <span class="key bad"></span>did not succeed · tallest bar ${max} run${max === 1 ? '' : 's'}</p>`;
}

export function dashboardBody(items: WorkItem[], costs: Map<string, number>, now = Date.now()): string {
  const week = now - 7 * DAY;
  const waiting = items.filter(needsPerson);
  const active = items.filter((wi) => !FINISHED.has(wi.state) && !needsPerson(wi));
  // Moving work has an agent running, or changed in the last hour; the rest has likely lost its
  // watcher (stopped, or paused on a usage limit) and needs `factory watch` or a look.
  const stalled = new Set(active.filter((wi) => wi.runs.every((r) => r.outcome) && now - Date.parse(ended(wi)) > 3_600_000));
  const finished = items.filter((wi) => FINISHED.has(wi.state)).sort((a, b) => ended(b).localeCompare(ended(a)));
  const thisWeek = finished.filter((wi) => Date.parse(ended(wi)) >= week);
  const mergedWeek = thisWeek.filter((wi) => wi.state === 'merged').length;
  const runs = allRuns(items);
  const running = runs.filter((r) => !r.run.outcome).length;
  const weekRuns = runs.filter((r) => Date.parse(r.run.startedAt) >= week);
  const weekCost = weekRuns.reduce((s, r) => s + (costs.get(r.run.id) ?? 0), 0);
  const total = items.reduce((s, wi) => s + wi.spentUsd, 0);
  const failedWeek = weekRuns.filter((r) => r.run.outcome && r.run.outcome !== 'succeeded').length;

  const tiles = `<div class="tiles">
${tile('Needs you', String(waiting.length), '/waiting', waiting.length ? 'wait' : '', waiting.length ? 'waiting on a decision' : 'nothing waiting')}
${tile('In progress', String(active.length), '/work?show=active', stalled.size ? 'wait' : active.length ? 'busy' : '', stalled.size ? `${stalled.size} stalled, no run for over an hour` : `${running} run${running === 1 ? '' : 's'} going now`)}
${tile('Merged this week', String(mergedWeek), '/work?show=finished', mergedWeek ? 'ok' : '', `${thisWeek.length - mergedWeek} failed or cancelled`)}
${tile('Runs this week', String(weekRuns.length), '/runs', failedWeek ? 'bad' : '', failedWeek ? `${failedWeek} did not succeed` : 'all succeeded or running')}
${tile('Spent this week', money(weekCost), '/runs', '', `${money(total)} all time`)}
</div>`;

  const newest = (a: WorkItem, b: WorkItem) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
  const kinds = new Map<string, number>();
  for (const wi of waiting) kinds.set(waitKind(wi), (kinds.get(waitKind(wi)) ?? 0) + 1);
  const SHOW = 6;
  const needs = waiting.length
    ? `<p class="kinds">${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="chip wait">${esc(k)} · ${n}</span>`).join(' ')}</p><div class="scroll"><table>${[...waiting]
        .sort(newest)
        .slice(0, SHOW)
        .map((wi) => `<tr><td><a href="/wi/${esc(wi.id)}">${esc(wi.title)}</a><div class="muted small clamp">${esc(headline(wi).text)}</div></td><td>${chip(waitKind(wi), 'wait')}</td><td class="num muted hide-sm">${esc(when(wi.updatedAt ?? wi.createdAt))}</td></tr>`)
        .join('')}</table></div>${waiting.length > SHOW ? `<p class="small"><a href="/waiting">and ${waiting.length - SHOW} more →</a></p>` : ''}`
    : '<p class="muted">Nothing is waiting on you.</p>';

  const moving = active.length
    ? `<div class="scroll"><table>${[...active]
        .sort(newest)
        .slice(0, SHOW)
        .map((wi) => `<tr><td><a href="/wi/${esc(wi.id)}">${esc(wi.title)}</a><div class="muted small clamp">${esc(headline(wi).text)}</div></td><td>${stalled.has(wi) ? chip('Stalled', 'wait') : stage(wi)}</td><td class="num">${tasksDone(wi)}</td><td class="num">${money(wi.spentUsd)}</td></tr>`)
        .join('')}</table></div>${stalled.size ? `<p class="muted small">Stalled: nothing has run for over an hour. Is <code>factory watch</code> running, or did it pause on a usage limit?</p>` : ''}${active.length > SHOW ? `<p class="small"><a href="/work?show=active">and ${active.length - SHOW} more →</a></p>` : ''}`
    : '<p class="muted">Nothing is in progress.</p>';

  const recentRuns = runs.length
    ? `<div class="scroll"><table>${runs.slice(0, 6).map((r) => runRow(r, costs)).join('')}</table></div>`
    : '<p class="muted">No runs yet.</p>';

  const done = finished.length
    ? `<div class="scroll"><table>${finished
        .slice(0, 6)
        .map((wi) => `<tr><td><a href="/wi/${esc(wi.id)}">${esc(wi.title)}</a><div class="muted small">${esc(wi.projectId)}</div></td><td>${stage(wi)}</td><td class="num muted hide-sm">${esc(when(ended(wi)))}</td><td class="num">${money(wi.spentUsd)}</td></tr>`)
        .join('')}</table></div>`
    : '<p class="muted">Nothing has finished yet.</p>';

  const projects = [...new Set(items.map((wi) => wi.projectId))].sort();
  const byProject = projects.length > 1
    ? `<section class="card"><h2>By project</h2><table class="compact"><tr><th>Project</th><th>Open</th><th>Merged</th><th>Spent</th></tr>${projects
        .map((p) => {
          const of = items.filter((wi) => wi.projectId === p);
          return `<tr><td>${esc(p)}</td><td class="num">${of.filter((wi) => !FINISHED.has(wi.state)).length}</td><td class="num">${of.filter((wi) => wi.state === 'merged').length}</td><td class="num">${money(of.reduce((s, wi) => s + wi.spentUsd, 0))}</td></tr>`;
        })
        .join('')}</table></section>`
    : '';

  const more = (href: string, label: string) => `<a class="more" href="${href}">${esc(label)} →</a>`;
  return `<h1>Dashboard</h1>${tiles}
<section class="card"><h2>Runs per day, last 14 days</h2>${activity(runs, costs, now)}</section>
<section><div class="row between"><h2>Needs you</h2>${waiting.length ? more('/waiting', `All ${waiting.length} waiting`) : ''}</div>${needs}</section>
<section><div class="row between"><h2>In progress</h2>${active.length ? more('/work?show=active', `All ${active.length} in progress`) : ''}</div>${moving}</section>
<div class="cols even">
<section><div class="row between"><h2>Latest runs</h2>${more('/runs', 'All runs')}</div>${recentRuns}</section>
<section><div class="row between"><h2>Recently finished</h2>${more('/work?show=finished', 'All finished')}</div>${done}</section>
</div>
${byProject}`;
}

// `factory stats`: how the factory did on real work over a period, from the event store.
//
// A team's own eval suite will be small, so what happened on real work matters as much: how
// often each gate approves, how often Verify sends work back, how many rounds a change takes,
// what the agent checks catch, what a merged change costs and how long it takes. Verify records
// the `.factory/` tree it ran under, so the same numbers per config show drift when the factory's
// setup changes between eval runs.

import type { StoredEvent } from '@cradleworks/interfaces';
import type { AgentCheckResult, Evidence, WorkItem } from '@cradleworks/core';

export interface StatsItem {
  wi: WorkItem;
  events: StoredEvent[];
}

export interface Stats {
  since: string;
  until: string;
  workItems: number;
  workItemStates: Record<string, number>;
  tasks: { total: number; merged: number; escalated: number; failed: number; cancelled: number; open: number };
  /** Merged tasks that passed Verify and the gate the first time. */
  firstPass: number;
  /** Rework rounds per merged task: Verify send-backs plus gate send-backs. */
  reworkPerMerged: number;
  verify: { runs: number; pass: number; rework: number; escalate: number };
  gates: Record<string, { approved: number; rejected: number; byPerson: number }>;
  agentChecks: Record<string, { runs: number; rework: number; escalate: number; couldNotCheck: number; blocking: number }>;
  costUsd: number;
  costPerMergedUsd: number;
  /** Median hours from the request to the task's merge. */
  medianHoursToMerge: number;
  /** By the `.factory/` tree Verify ran under, oldest first. */
  byConfig: Array<{ config: string; firstSeen: string; lastSeen: string; verifies: number; passed: number }>;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Over work items received in [since, until). */
export function computeStats(items: StatsItem[], since: Date, until: Date): Stats {
  const inPeriod = items.filter(({ events }) => {
    const at = events.find((e) => e.type === 'work_item_received')?.at;
    const t = at ? Date.parse(at) : NaN;
    return t >= since.getTime() && t < until.getTime();
  });
  const stats: Stats = {
    since: since.toISOString(),
    until: until.toISOString(),
    workItems: inPeriod.length,
    workItemStates: {},
    tasks: { total: 0, merged: 0, escalated: 0, failed: 0, cancelled: 0, open: 0 },
    firstPass: 0,
    reworkPerMerged: 0,
    verify: { runs: 0, pass: 0, rework: 0, escalate: 0 },
    gates: {},
    agentChecks: {},
    costUsd: 0,
    costPerMergedUsd: 0,
    medianHoursToMerge: 0,
    byConfig: [],
  };
  const hoursToMerge: number[] = [];
  let reworkMerged = 0;
  const configs = new Map<string, { firstSeen: string; lastSeen: string; verifies: number; passed: number }>();
  for (const { wi, events } of inPeriod) {
    stats.workItemStates[wi.state] = (stats.workItemStates[wi.state] ?? 0) + 1;
    stats.costUsd += wi.spentUsd;
    const received = Date.parse(events.find((e) => e.type === 'work_item_received')!.at);
    for (const t of wi.tasks) {
      stats.tasks.total++;
      if (t.state === 'merged') {
        stats.tasks.merged++;
        const rounds = t.reworkLoops + t.gateReworks;
        reworkMerged += rounds;
        if (rounds === 0) stats.firstPass++;
      } else if (t.state === 'escalated') stats.tasks.escalated++;
      else if (t.state === 'failed') stats.tasks.failed++;
      else if (t.state === 'cancelled') stats.tasks.cancelled++;
      else stats.tasks.open++;
    }
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'task_verified') {
        stats.verify.runs++;
        const v = p.verdict as 'pass' | 'rework' | 'escalate';
        stats.verify[v]++;
      } else if (e.type === 'gate_decided') {
        const g = (stats.gates[String(p.gate)] ??= { approved: 0, rejected: 0, byPerson: 0 });
        if (p.verdict === 'approved') g.approved++;
        else g.rejected++;
        if (p.mode === 'human') g.byPerson++;
      } else if (e.type === 'task_merged') {
        hoursToMerge.push((Date.parse(e.at) - received) / 3_600_000);
      } else if (e.type === 'task_evidence_recorded') {
        const ev = p.evidence as Evidence;
        for (const c of ev.agentChecks ?? ([] as AgentCheckResult[])) {
          const s = (stats.agentChecks[c.name] ??= { runs: 0, rework: 0, escalate: 0, couldNotCheck: 0, blocking: 0 });
          s.runs++;
          if (c.blocking) s.blocking++;
          if (c.couldNotCheck) s.couldNotCheck++;
          else if (c.verdict === 'rework') s.rework++;
          else if (c.verdict === 'escalate') s.escalate++;
        }
        if (ev.factoryConfig) {
          const at = ev.verifiedAt;
          const s = configs.get(ev.factoryConfig) ?? { firstSeen: at, lastSeen: at, verifies: 0, passed: 0 };
          s.verifies++;
          if (ev.verdict === 'pass') s.passed++;
          if (at < s.firstSeen) s.firstSeen = at;
          if (at > s.lastSeen) s.lastSeen = at;
          configs.set(ev.factoryConfig, s);
        }
      }
    }
  }
  stats.reworkPerMerged = stats.tasks.merged ? reworkMerged / stats.tasks.merged : 0;
  stats.costPerMergedUsd = stats.tasks.merged ? stats.costUsd / stats.tasks.merged : 0;
  stats.medianHoursToMerge = median(hoursToMerge);
  stats.byConfig = [...configs.entries()].map(([config, s]) => ({ config, ...s })).sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));
  return stats;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');
const day = (iso: string) => iso.slice(0, 10);

export function formatStats(s: Stats, project?: string): string {
  const out: string[] = [];
  out.push(`${project ? `${project}: ` : ''}work received ${day(s.since)} to ${day(s.until)}`);
  if (!s.workItems) return `${out[0]}\nNo work items in this period.\n`;
  const states = Object.entries(s.workItemStates).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ');
  out.push(`  work items       ${s.workItems} (${states})`);
  const t = s.tasks;
  out.push(`  tasks            ${t.total}: ${t.merged} merged, ${t.escalated} escalated, ${t.failed} failed, ${t.cancelled} cancelled, ${t.open} open`);
  out.push(`  first time       ${s.firstPass} of ${t.merged} merged tasks (${pct(s.firstPass, t.merged)}) passed Verify and the gate the first time`);
  out.push(`  rework           ${s.reworkPerMerged.toFixed(1)} rounds per merged task`);
  const v = s.verify;
  out.push(`  Verify           ${v.runs} runs: ${v.pass} passed (${pct(v.pass, v.runs)}), ${v.rework} sent back (${pct(v.rework, v.runs)}), ${v.escalate} escalated (${pct(v.escalate, v.runs)})`);
  for (const [gate, g] of Object.entries(s.gates)) {
    out.push(`  gate ${gate}: ${g.approved + g.rejected} decided, ${g.approved} approved, ${g.rejected} sent back, ${g.byPerson} by a person`);
  }
  for (const [name, c] of Object.entries(s.agentChecks)) {
    out.push(`  agent check ${name}: ${c.runs} runs, ${c.rework} sent back, ${c.escalate} escalated, ${c.couldNotCheck} couldn't check${c.blocking < c.runs ? ` (${c.runs - c.blocking} as advisory)` : ''}`);
  }
  out.push(`  cost             $${s.costUsd.toFixed(2)} in all, $${s.costPerMergedUsd.toFixed(2)} per merged task`);
  if (t.merged) out.push(`  time to merge    median ${s.medianHoursToMerge < 1 ? `${Math.round(s.medianHoursToMerge * 60)} min` : `${s.medianHoursToMerge.toFixed(1)} h`} from the request`);
  if (s.byConfig.length > 1) {
    out.push('', '  By factory config (the .factory/ tree Verify ran under):');
    for (const c of s.byConfig) out.push(`    ${c.config.slice(0, 10)}  ${day(c.firstSeen)} to ${day(c.lastSeen)}: ${c.verifies} Verify runs, ${c.passed} passed (${pct(c.passed, c.verifies)})`);
  }
  return `${out.join('\n')}\n`;
}

// What the factory did on an eval attempt, step by step, read from the attempt's own event log:
// each station run with its agents' models, cost and time, what Verify found, and how the work
// ended. Reporting only: nothing here changes what the factory does.

/** One agent's share of a station run. */
export interface TraceAgent {
  role: string;
  model?: string;
  costUsd: number;
}

/** One station run: Specify, Plan, a Build or a Verify. */
export interface TraceStep {
  station: string;
  /** Which build or verify of its task this was, from 1. */
  round: number;
  /** The task it ran for, when the work item has more than one. */
  task?: string;
  outcome?: string;
  seconds: number;
  costUsd: number;
  agents: TraceAgent[];
  /** Verify only: its verdict and one-line reason. */
  verdict?: string;
  reason?: string;
  /** Verify only: what the reviewer said. */
  review?: { verdict: string; risk: string; reasons: string[] };
  /** Verify only: the stack commands that failed, by name, and the CI state when not passed. */
  failedChecks?: string[];
  ci?: string;
  /** Verify only: the project's agent checks and their verdicts. */
  agentChecks?: Array<{ name: string; verdict: string; reasons: string[]; couldNotCheck?: string }>;
}

/** Things along the way worth reading: a gate's decision, a rework, a dispute, a stop. */
export interface TraceNote {
  kind: string;
  text: string;
}

export interface AttemptTrace {
  steps: TraceStep[];
  notes: TraceNote[];
  /** Cost by agent role, over the whole attempt. */
  byRole: Record<string, number>;
  /** Why the work ended or stopped, when it did not merge. */
  endReason?: string;
}

export interface TraceEvent {
  type: string;
  payload: unknown;
  at: string;
}

const LONG = 600;
const MAX_STEPS = 100;
const MAX_NOTES = 60;
const cut = (s: unknown) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > LONG ? `${t.slice(0, LONG - 1)}…` : t;
};
const cents = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * The attempt's trace from its work item's events. `models` gives each role's model as the
 * attempt's settings resolve it; a run's own profile wins for the role it ran as.
 */
export function traceOf(events: TraceEvent[], models: Record<string, string> = {}): AttemptTrace {
  const steps: TraceStep[] = [];
  const byRun = new Map<string, { step: TraceStep; started: number; model?: string }>();
  const rounds = new Map<string, number>();
  const notes: TraceNote[] = [];
  const byRole: Record<string, number> = {};
  const tasks = new Set<string>();
  let endReason: string | undefined;
  const note = (kind: string, text: unknown) => {
    if (notes.length < MAX_NOTES) notes.push({ kind, text: cut(text) });
  };

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, any>;
    switch (e.type) {
      case 'tasks_planned':
        for (const t of p.tasks ?? []) if (t?.id) tasks.add(String(t.id));
        break;
      case 'run_started': {
        if (steps.length >= MAX_STEPS) break;
        const key = `${p.station}:${p.subjectId}`;
        const round = (rounds.get(key) ?? 0) + 1;
        rounds.set(key, round);
        const step: TraceStep = { station: String(p.station), round, seconds: 0, costUsd: 0, agents: [] };
        if (p.subjectId && !String(p.subjectId).startsWith('wi_')) step.task = String(p.subjectId);
        steps.push(step);
        byRun.set(String(p.runId), { step, started: Date.parse(e.at), model: p.agentProfile?.model });
        if (p.agentProfile?.role) step.agents.push({ role: String(p.agentProfile.role), model: p.agentProfile.model, costUsd: 0 });
        break;
      }
      case 'run_ended': {
        const r = byRun.get(String(p.runId));
        if (!r) break;
        r.step.outcome = String(p.outcome);
        const ms = Date.parse(e.at) - r.started;
        if (Number.isFinite(ms)) r.step.seconds = Math.max(0, Math.round(ms / 1000));
        break;
      }
      case 'agent_cost_recorded': {
        const cost = Number(p.costUsd) || 0;
        const role = String(p.role ?? 'agent');
        byRole[role] = cents((byRole[role] ?? 0) + cost);
        const r = byRun.get(String(p.runId));
        if (!r) break;
        r.step.costUsd = cents(r.step.costUsd + cost);
        let agent = r.step.agents.find((a) => a.role === role);
        if (!agent) {
          agent = { role, ...(models[role] ? { model: models[role] } : {}), costUsd: 0 };
          r.step.agents.push(agent);
        }
        agent.costUsd = cents(agent.costUsd + cost);
        break;
      }
      case 'task_evidence_recorded': {
        const ev = p.evidence ?? {};
        const r = byRun.get(String(ev.runId));
        if (!r) break;
        const s = r.step;
        s.verdict = ev.verdict;
        s.reason = cut(ev.reason);
        if (ev.review) s.review = { verdict: String(ev.review.verdict), risk: String(ev.review.risk), reasons: (ev.review.reasons ?? []).slice(0, 12).map(cut) };
        const failed = (ev.checks ?? []).filter((c: any) => c.outcome === 'failed' || c.outcome === 'timed_out').map((c: any) => String(c.name));
        if (failed.length) s.failedChecks = failed;
        if (ev.ci?.state && ev.ci.state !== 'passed' && ev.ci.state !== 'not_configured' && ev.ci.state !== 'none') s.ci = String(ev.ci.state);
        if (ev.agentChecks?.length)
          s.agentChecks = ev.agentChecks.map((c: any) => ({ name: String(c.name), verdict: String(c.verdict), reasons: (c.reasons ?? []).slice(0, 6).map(cut), ...(c.couldNotCheck ? { couldNotCheck: cut(c.couldNotCheck) } : {}) }));
        break;
      }
      case 'gate_decided':
        note('gate', `${String(p.gate).replace(/_/g, ' ')}: ${p.verdict} by ${p.decidedBy}${p.reason ? `: ${p.reason}` : ''}`);
        break;
      case 'spec_questions_asked':
        note('questions', `the spec agent asked: ${(p.questions ?? []).join(' ')}`);
        break;
      case 'task_verified':
        if (p.verdict === 'escalate') note('escalated', `handed to a person at Verify: ${p.reason}`);
        break;
      case 'task_rework_started':
        note('rework', 'sent back to be built again');
        break;
      case 'task_declined':
        note('declined', `the implementer changed nothing: ${p.reason}`);
        break;
      case 'task_tests_disputed':
        note('dispute', `the implementer disputed an acceptance test (${p.verdict}): ${p.dispute}`);
        break;
      case 'task_merge_conflicted':
        note('conflict', p.reason);
        break;
      case 'task_budget_exceeded':
        note('budget', `stopped at the spend limit after $${Number(p.spentUsd).toFixed(2)}${p.reason ? `: ${p.reason}` : ''}`);
        endReason ??= 'reached the spend limit per task';
        break;
      case 'task_failed':
        note('failed', p.reason);
        endReason = cut(p.reason);
        break;
      case 'work_item_blocked':
        note('blocked', p.reason);
        endReason = cut(p.reason);
        break;
      case 'work_item_unblocked':
        endReason = undefined;
        break;
      case 'work_item_failed':
      case 'work_item_cancelled':
        endReason = cut(p.reason);
        break;
    }
  }
  if (tasks.size <= 1) for (const s of steps) delete s.task;
  return { steps, notes, byRole, ...(endReason ? { endReason } : {}) };
}

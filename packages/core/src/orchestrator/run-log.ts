// The per-run stream: every step a station takes and every agent event, in order.
// A reviewer reads this to see exactly what happened and what the agent was shown.

import type { AgentEvent, AgentRole, NetworkDecision, NetworkPolicy, StateStore } from '@cradleworks/interfaces';
import type { ContextFile } from './context-pack.ts';
import type { CheckResult, CiResult, ReviewResult, VerifyVerdict } from '../domain/types.ts';

export type RunLogEntry =
  | { type: 'run_context'; workItemId: string; taskId: string; station: string; attempt?: number }
  /** A review of a change the factory didn't build (`reviewChange`): no work item or task. */
  | { type: 'run_context'; station: 'review'; title: string; base: string }
  | { type: 'context_pack_built'; role?: AgentRole; files: ContextFile[]; dropped: string[]; budgetBytes: number }
  | { type: 'checkout_cloned'; path: string; repo: string }
  | { type: 'sandbox_created'; sandboxId: string; branch: string; baseRef: string; network: NetworkPolicy }
  | { type: 'agent_started'; agent: string; model: string; limits: object }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'changes_committed'; sha: string }
  | { type: 'branch_pushed'; branch: string }
  | { type: 'pr_opened'; id: string; url: string }
  | { type: 'step_failed'; step: string; error: string }
  | { type: 'sandbox_destroyed'; sandboxId: string }
  | { type: 'task_declined'; reason: string }
  | ({ type: 'check_ran' } & CheckResult)
  | ({ type: 'review_decided' } & ReviewResult)
  | ({ type: 'ci_checked' } & CiResult)
  | { type: 'evidence'; verdict: VerifyVerdict; reason: string; sha: string }
  | { type: 'evidence_posted'; url: string }
  | { type: 'evidence_not_posted'; error: string }
  | { type: 'spec_written'; path: string }
  | { type: 'spec_answer'; kind: 'questions' | 'spec' | 'unreadable' }
  | { type: 'plan_checked'; attempt: number; problems: string[] }
  | { type: 'check_decided'; what: 'spec' | 'plan'; verdict: 'approved' | 'rejected'; reasons: string[] }
  | { type: 'acceptance_tests'; files: string[]; note?: string }
  | { type: 'budget_stopped'; reason: string }
  | { type: 'review_retried'; reason: string }
  | { type: 'tests_reviewed'; verdict: 'revised' | 'upheld'; reasons: string[]; files: string[] }
  | { type: 'secrets_found'; findings: Array<{ file: string; line: number; kind: string }> }
  | { type: 'protected_paths_changed'; paths: string[] }
  | { type: 'command_denied'; tool: string; detail: string }
  | { type: 'network_decisions'; allowed: number; denied: number; decisions: NetworkDecision[] };

export class RunLog {
  readonly runId: string;
  readonly #store: StateStore;
  readonly #clock: () => string;

  constructor(store: StateStore, runId: string, clock: () => string) {
    this.#store = store;
    this.runId = runId;
    this.#clock = clock;
  }

  async write(entry: RunLogEntry): Promise<void> {
    const { type, ...payload } = entry;
    await this.#store.append(this.runId, [{ type, payload, at: this.#clock() }]);
  }
}

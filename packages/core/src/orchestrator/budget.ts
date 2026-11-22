// Spend limits. Every agent run records what it cost (`agent_cost_recorded` on its work
// item), so the ledger is a sum over events: by task, by work item, or by requester per UTC
// day and month. Before each run the factory works out what's left under every cap that
// applies, and hands the runtime only that much.

import type { StateStore } from '@cradleworks/interfaces';
import type { ProjectConfig } from '../config/types.ts';
import type { Task } from '../domain/types.ts';

export type BudgetPeriod = 'day' | 'month';

/** UTC calendar keys for a timestamp: `2026-11-22` and `2026-11`. */
export function periodKey(at: string, period: BudgetPeriod): string {
  return period === 'day' ? at.slice(0, 10) : at.slice(0, 7);
}

export interface UserSpend {
  requester: string;
  day: { key: string; spentUsd: number; extraUsd: number };
  month: { key: string; spentUsd: number; extraUsd: number };
}

const userStream = (requester: string) => `budget:${requester}`;

/** What a requester has spent today and this month (UTC), and any extensions granted for those periods. */
export async function userSpend(store: StateStore, requester: string, at: string): Promise<UserSpend> {
  const day = periodKey(at, 'day');
  const month = periodKey(at, 'month');
  const out: UserSpend = { requester, day: { key: day, spentUsd: 0, extraUsd: 0 }, month: { key: month, spentUsd: 0, extraUsd: 0 } };
  for (const e of await store.query({ types: ['agent_cost_recorded'] })) {
    const p = e.payload as { requester?: string; costUsd?: number };
    if (p.requester !== requester || typeof p.costUsd !== 'number') continue;
    if (e.at.startsWith(month)) out.month.spentUsd += p.costUsd;
    if (e.at.startsWith(day)) out.day.spentUsd += p.costUsd;
  }
  for (const e of await store.readStream(userStream(requester))) {
    if (e.type !== 'user_budget_extended') continue;
    const p = e.payload as { period: BudgetPeriod; key: string; extraUsd: number };
    if (p.period === 'day' && p.key === day) out.day.extraUsd += p.extraUsd;
    if (p.period === 'month' && p.key === month) out.month.extraUsd += p.extraUsd;
  }
  return out;
}

/** Raises a requester's cap for the current day or month only. */
export async function extendUserBudget(store: StateStore, input: { requester: string; period: BudgetPeriod; extraUsd: number; by: string; at: string }): Promise<void> {
  if (!Number.isFinite(input.extraUsd) || input.extraUsd <= 0) throw new Error('the extension must be a positive amount');
  await store.append(userStream(input.requester), [
    { type: 'user_budget_extended', at: input.at, payload: { period: input.period, key: periodKey(input.at, input.period), extraUsd: input.extraUsd, by: input.by } },
  ]);
}

export interface BudgetCheck {
  /** The most the next run may spend. */
  allowedUsd: number;
  /** Set when nothing is left: which cap stopped it, in words. */
  stop?: string;
}

/** Below this, a run would stop before doing anything useful. */
const MIN_RUN_USD = 0.05;

/**
 * What the next agent run may spend: the least of what's left of the task's cap (all its
 * attempts together) and the requester's daily and monthly caps. A run for the work item
 * itself (spec, plan, checks) has `per_task_usd` as its own cap.
 */
export function checkBudget(config: ProjectConfig, task: Task | undefined, user: UserSpend): BudgetCheck {
  const limits: Array<{ left: number; stop: string }> = [];
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (task) {
    const cap = task.budgetUsd ?? config.budgets.perTaskUsd;
    const spent = task.spentUsd ?? 0;
    limits.push({ left: cap - spent, stop: `budget: the task's ${money(cap)} cap is used up (${money(spent)} spent over all its attempts)` });
  } else {
    limits.push({ left: config.budgets.perTaskUsd, stop: '' });
  }
  const { perUserDailyUsd: daily, perUserMonthlyUsd: monthly } = config.budgets;
  if (daily !== undefined) {
    const cap = daily + user.day.extraUsd;
    limits.push({ left: cap - user.day.spentUsd, stop: `budget: @${user.requester}'s daily cap of ${money(cap)} is used up (${money(user.day.spentUsd)} on ${user.day.key} UTC)` });
  }
  if (monthly !== undefined) {
    const cap = monthly + user.month.extraUsd;
    limits.push({ left: cap - user.month.spentUsd, stop: `budget: @${user.requester}'s monthly cap of ${money(cap)} is used up (${money(user.month.spentUsd)} in ${user.month.key})` });
  }
  const tightest = limits.reduce((a, b) => (b.left < a.left ? b : a));
  if (tightest.left < MIN_RUN_USD) return { allowedUsd: 0, stop: tightest.stop };
  return { allowedUsd: Math.round(tightest.left * 1e4) / 1e4 };
}

export function isBudgetStop(error: string | undefined): boolean {
  return error?.startsWith('budget: ') ?? false;
}

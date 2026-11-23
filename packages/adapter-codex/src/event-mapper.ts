// Maps `codex exec --json` lines to the factory's normalised agent events. Pure: no I/O, so it
// is tested against transcripts.
//
// The stream is thread.started, turn.started, then item.started / item.updated /
// item.completed for each item (agent_message, reasoning, command_execution, file_change,
// mcp_tool_call, web_search, todo_list, error), then turn.completed with token usage, or
// turn.failed. A top-level `error` line reports a stream failure.

import type { AgentEvent, AgentOutcome, Usage } from '@cradleworks/interfaces';

/** An event without the fields the runtime stamps on (runId, seq, at). */
export type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'runId' | 'seq' | 'at'> : never) : never;

export interface Ending {
  outcome: AgentOutcome;
  summary?: string;
  error?: string;
}

/** US dollars per million tokens. */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * List prices when this was written. Codex reports tokens, not dollars, so spend is an
 * estimate from these; an unknown model is priced at FALLBACK_PRICE, which is deliberately
 * high so a spend cap stops a run early rather than late. Override with `prices`.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
};
export const FALLBACK_PRICE: Price = { input: 15, cachedInput: 1.5, output: 60 };

const MAX_TOOL_OUTPUT = 8_000;

interface Item {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  query?: string;
  message?: string;
}

interface Line {
  type?: string;
  item?: Item;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
}

export class CodexMapper {
  readonly #price: Price;
  readonly #started = new Set<string>();
  #usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  #lastMessage: string | undefined;
  #ending: Ending | undefined;
  #streamError: string | undefined;

  constructor(price: Price) {
    this.#price = price;
  }

  /** The running total so far, never decreasing. */
  get usage(): Usage {
    return { ...this.#usage };
  }

  /** Set once the turn has completed or failed. */
  get ending(): Ending | undefined {
    if (this.#ending) return this.#ending;
    return this.#streamError ? { outcome: 'failed', error: this.#streamError } : undefined;
  }

  /** A shell command that has just started, for the runtime's policy check. */
  startedCommand(line: string): { callId: string; command: string } | undefined {
    const parsed = parse(line);
    const item = parsed?.item;
    if (parsed?.type !== 'item.started' || item?.type !== 'command_execution' || !item.command) return undefined;
    return { callId: item.id ?? '', command: item.command };
  }

  map(line: string): Draft[] {
    const parsed = parse(line);
    if (!parsed) return [];
    switch (parsed.type) {
      case 'item.started':
        return parsed.item ? this.#started_(parsed.item) : [];
      case 'item.completed':
        return parsed.item ? this.#completed(parsed.item) : [];
      case 'turn.completed':
        return this.#turnCompleted(parsed);
      case 'turn.failed':
        this.#ending = { outcome: 'failed', error: messageOf(parsed.error) ?? 'the turn failed' };
        return [];
      case 'error':
        this.#streamError = messageOf(parsed.error) ?? parsed.message ?? 'stream error';
        return [{ type: 'message', role: 'system', text: `Codex error: ${this.#streamError}` }];
      default:
        return [];
    }
  }

  #started_(item: Item): Draft[] {
    const call = toolCall(item);
    if (!call || !item.id) return [];
    this.#started.add(item.id);
    return [call];
  }

  #completed(item: Item): Draft[] {
    switch (item.type) {
      case 'agent_message':
        if (!item.text) return [];
        this.#lastMessage = item.text;
        return [{ type: 'message', role: 'assistant', text: item.text }];
      case 'error':
        return [{ type: 'message', role: 'system', text: `Codex: ${item.message ?? messageOf(item.error) ?? 'error'}` }];
      case 'command_execution':
      case 'file_change':
      case 'mcp_tool_call':
      case 'web_search': {
        const out: Draft[] = [];
        if (!item.id || !this.#started.has(item.id)) {
          const call = toolCall(item);
          if (call) out.push(call);
        }
        out.push(toolResult(item));
        return out;
      }
      default:
        // reasoning, todo_list: not part of the audit trail.
        return [];
    }
  }

  #turnCompleted(line: Line): Draft[] {
    const u = line.usage ?? {};
    const cached = u.cached_input_tokens ?? 0;
    // Codex counts cached tokens inside input_tokens; the factory keeps them apart.
    const fresh = Math.max(0, (u.input_tokens ?? 0) - cached);
    const output = u.output_tokens ?? 0;
    const cost = (fresh * this.#price.input + cached * this.#price.cachedInput + output * this.#price.output) / 1_000_000;
    this.#usage = {
      inputTokens: this.#usage.inputTokens + fresh,
      outputTokens: this.#usage.outputTokens + output,
      cacheReadTokens: (this.#usage.cacheReadTokens ?? 0) + cached,
      costUsd: round(this.#usage.costUsd + cost),
    };
    this.#ending = { outcome: 'succeeded', ...(this.#lastMessage ? { summary: this.#lastMessage } : {}) };
    return [{ type: 'usage', total: this.usage }];
  }
}

function toolCall(item: Item): Draft | undefined {
  const callId = item.id ?? '';
  switch (item.type) {
    case 'command_execution':
      return { type: 'tool_call', callId, tool: 'shell', input: { command: item.command ?? '' } };
    case 'file_change':
      return { type: 'tool_call', callId, tool: 'apply_patch', input: { changes: (item.changes ?? []).map((c) => ({ path: c.path, kind: c.kind })) } };
    case 'mcp_tool_call':
      return { type: 'tool_call', callId, tool: `mcp:${item.server ?? '?'}.${item.tool ?? '?'}`, input: item.arguments ?? {} };
    case 'web_search':
      return { type: 'tool_call', callId, tool: 'web_search', input: { query: item.query ?? '' } };
    default:
      return undefined;
  }
}

function toolResult(item: Item): Draft {
  const callId = item.id ?? '';
  let isError = item.status === 'failed' || item.status === 'declined';
  let output = '';
  if (item.type === 'command_execution') {
    isError ||= item.exit_code !== undefined && item.exit_code !== null && item.exit_code !== 0;
    output = item.aggregated_output ?? '';
  } else if (item.type === 'file_change') {
    output = (item.changes ?? []).map((c) => `${c.kind ?? 'update'} ${c.path ?? ''}`).join('\n');
  } else if (item.type === 'mcp_tool_call') {
    const err = messageOf(item.error);
    isError ||= Boolean(err);
    output = err ?? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? ''));
  }
  return { type: 'tool_result', callId, isError, output: truncate(output) };
}

function parse(line: string): Line | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as Line) : undefined;
  } catch {
    return undefined;
  }
}

function messageOf(e: { message?: string } | string | null | undefined): string | undefined {
  if (!e) return undefined;
  return typeof e === 'string' ? e : e.message;
}

function truncate(text: string): string {
  return text.length <= MAX_TOOL_OUTPUT ? text : `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (${text.length - MAX_TOOL_OUTPUT} more characters)`;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Maps Claude Code's `--output-format stream-json` lines to the factory's normalised
// agent events. Pure: no I/O, so it is tested against recorded transcripts.

import type { AgentEvent, AgentOutcome, Usage } from '@cradleworks/interfaces';

/** An event without the fields the runtime stamps on (runId, seq, at). */
export type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'runId' | 'seq' | 'at'> : never) : never;

export interface Ending {
  outcome: AgentOutcome;
  summary?: string;
  error?: string;
}

const MAX_TOOL_OUTPUT = 8_000;

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export class StreamMapper {
  /** Latest usage per model message: a message's usage repeats on each of its content lines. */
  readonly #perMessage = new Map<string, MessageUsage>();
  #final: Usage | undefined;
  #reported: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  #ending: Ending | undefined;
  #model: string | undefined;

  /** The running total so far, never decreasing. */
  get usage(): Usage {
    return { ...this.#reported };
  }

  /** Set once the agent's closing `result` line has been seen. */
  get ending(): Ending | undefined {
    return this.#ending;
  }

  get model(): string | undefined {
    return this.#model;
  }

  /** Maps one output line. Lines that are not JSON are ignored (Claude Code prints none in this mode). */
  map(line: string): Draft[] {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const out: Draft[] = [];
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init') {
          this.#model = typeof e.model === 'string' ? e.model : undefined;
          out.push({ type: 'message', role: 'system', text: `Claude Code ${String(e.claude_code_version ?? '')} started with model ${this.#model ?? 'unknown'}`.replace('  ', ' ') });
        } else if (e.subtype === 'permission_denied') {
          out.push({ type: 'message', role: 'system', text: `Tool refused: ${String(e.tool_name ?? 'unknown')}` });
        }
        break;

      case 'assistant': {
        const message = (e.message ?? {}) as { id?: string; content?: Array<Record<string, unknown>>; usage?: MessageUsage };
        for (const block of message.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            out.push({ type: 'message', role: 'assistant', text: block.text });
          } else if (block.type === 'tool_use') {
            out.push({ type: 'tool_call', callId: String(block.id ?? ''), tool: String(block.name ?? ''), input: block.input ?? {} });
          }
        }
        if (message.usage && message.id) {
          this.#perMessage.set(message.id, message.usage);
          const changed = this.#report(this.#summed());
          if (changed) out.push({ type: 'usage', total: this.usage });
        }
        break;
      }

      case 'user': {
        const message = (e.message ?? {}) as { content?: Array<Record<string, unknown>> | string };
        if (!Array.isArray(message.content)) break;
        for (const block of message.content) {
          if (block.type !== 'tool_result') continue;
          out.push({ type: 'tool_result', callId: String(block.tool_use_id ?? ''), isError: block.is_error === true, output: truncate(resultText(block.content)) });
        }
        break;
      }

      case 'result': {
        const usage = (e.usage ?? {}) as MessageUsage;
        this.#final = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0,
        };
        if (this.#report(this.#final)) out.push({ type: 'usage', total: this.usage });
        this.#ending = ending(e);
        break;
      }
    }
    return out;
  }

  #summed(): Usage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (const u of this.#perMessage.values()) {
      inputTokens += u.input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
      cacheReadTokens += u.cache_read_input_tokens ?? 0;
      cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: this.#reported.costUsd };
  }

  /** Raises the running total field by field; returns whether anything grew. */
  #report(next: Usage): boolean {
    const prev = this.#reported;
    const merged: Usage = {
      inputTokens: Math.max(prev.inputTokens, next.inputTokens),
      outputTokens: Math.max(prev.outputTokens, next.outputTokens),
      cacheReadTokens: Math.max(prev.cacheReadTokens ?? 0, next.cacheReadTokens ?? 0),
      cacheWriteTokens: Math.max(prev.cacheWriteTokens ?? 0, next.cacheWriteTokens ?? 0),
      costUsd: Math.max(prev.costUsd, next.costUsd),
    };
    const grew = (Object.keys(merged) as Array<keyof Usage>).some((k) => (merged[k] ?? 0) > (prev[k] ?? 0));
    this.#reported = merged;
    return grew;
  }
}

function ending(e: Record<string, unknown>): Ending {
  const subtype = String(e.subtype ?? '');
  const text = typeof e.result === 'string' ? e.result.trim() : '';
  const errors = Array.isArray(e.errors) ? e.errors.map(String).join('; ') : '';
  if (subtype === 'success' && e.is_error !== true) return { outcome: 'succeeded', ...(text ? { summary: text } : {}) };
  if (/budget|max_turns|max_tokens/.test(subtype)) {
    return { outcome: 'limit_reached', error: errors || `Claude Code stopped: ${subtype}`, ...(text ? { summary: text } : {}) };
  }
  return { outcome: 'failed', error: errors || text || `Claude Code ended with ${subtype || 'an error'}` };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '')).join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function truncate(text: string): string {
  return text.length <= MAX_TOOL_OUTPUT ? text : `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [${text.length - MAX_TOOL_OUTPUT} more characters]`;
}

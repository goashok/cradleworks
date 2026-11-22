// `factory log`: replays a run's event log as a readable timeline. Everything shown comes from the
// stored events alone, so a run can be inspected long after its sandbox and checkout are gone.

import type { AgentEvent, StoredEvent } from '@cradleworks/interfaces';

export interface LogOptions {
  /** Show tool inputs and outputs in full instead of a first line. */
  full?: boolean;
}

const WIDTH = 160;

function oneLine(text: string, full: boolean): string {
  if (full) return text;
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const more = text.trim().includes('\n') ? ' …' : '';
  const clipped = first.length > WIDTH ? `${first.slice(0, WIDTH)}…` : first;
  return `${clipped}${clipped === first ? more : ''}`;
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}

function toolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
      if (typeof o[key] === 'string') return o[key];
    }
  }
  return JSON.stringify(input);
}

function money(usd: number | undefined): string {
  return usd === undefined ? '' : `$${usd.toFixed(4)}`;
}

/** One line (or block, with `full`) per event; undefined for events not worth a line. */
export function formatEvent(event: StoredEvent, options: LogOptions = {}): string | undefined {
  const full = options.full ?? false;
  const time = event.at.slice(11, 19);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const line = (what: string, detail = ''): string => {
    const text = `${time}  ${what.padEnd(12)} ${detail}`.trimEnd();
    return full && detail.includes('\n') ? `${time}  ${what}\n${indentBlock(detail)}` : text;
  };
  switch (event.type) {
    case 'run_started':
      return line('run', `started ${String(p.station ?? '')}`.trim());
    case 'run_context':
      return line('run', `${String(p.station ?? '')} for ${String(p.taskId ?? '')} (${String(p.workItemId ?? '')})`);
    case 'checkout_cloned':
      return line('checkout', `${String(p.repo ?? '')} → ${String(p.path ?? '')}`);
    case 'sandbox_created': {
      const net = p.network as { mode?: string; allow?: string[] } | undefined;
      return line('sandbox', `${String(p.sandboxId ?? '')} on ${String(p.branch ?? '')} from ${String(p.baseRef ?? '')}; network ${net?.mode ?? '?'}: ${(net?.allow ?? []).join(', ')}`);
    }
    case 'context_pack_built': {
      const files = (p.files as Array<{ path: string }> | undefined) ?? [];
      const dropped = (p.dropped as unknown[] | undefined) ?? [];
      return line('context', `${files.map((f) => f.path).join(', ')}${dropped.length ? ` (${dropped.length} dropped)` : ''}`);
    }
    case 'agent_started': {
      const limits = p.limits as { maxWallSeconds?: number; maxSpendUsd?: number } | undefined;
      return line('agent', `${String(p.agent ?? '')} ${String(p.model ?? '')}, limits ${limits?.maxWallSeconds ?? '-'}s / ${money(limits?.maxSpendUsd) || '-'}`);
    }
    case 'agent_event':
      return formatAgentEvent(p.event as AgentEvent, line, full);
    case 'changes_committed':
      return line('commit', String(p.sha ?? ''));
    case 'branch_pushed':
      return line('push', String(p.branch ?? ''));
    case 'pr_opened':
      return line('pr', String(p.url ?? p.id ?? ''));
    case 'run_ended':
      return line('run', `ended ${String(p.outcome ?? '')}${p.reason ? `: ${String(p.reason)}` : ''}`);
    case 'sandbox_destroyed':
      return line('sandbox', `${String(p.sandboxId ?? '')} destroyed`);
    default:
      return line(event.type, oneLine(JSON.stringify(p), full));
  }
}

function formatAgentEvent(e: AgentEvent | undefined, line: (what: string, detail?: string) => string, full: boolean): string | undefined {
  if (!e) return undefined;
  switch (e.type) {
    case 'message':
      return line(e.role === 'assistant' ? 'says' : e.role, oneLine(e.text, full));
    case 'tool_call':
      return line(`→ ${e.tool}`, oneLine(toolInput(e.input), full));
    case 'tool_result':
      return line(e.isError ? '← error' : '←', oneLine(e.output, full));
    case 'file_change':
      return line('file', `${e.change} ${e.path}${e.previousPath ? ` (was ${e.previousPath})` : ''}`);
    case 'usage':
      return undefined; // the running total is shown once, on done
    case 'done': {
      const t = e.total;
      const usage = `${t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)} in / ${t.outputTokens} out tokens, ${money(t.costUsd)}`;
      const head = line('agent', `${e.outcome}; ${usage}${e.error ? `; ${e.error}` : ''}`);
      return e.summary ? `${head}\n${line('summary', oneLine(e.summary, full))}` : head;
    }
    default:
      return line('agent', JSON.stringify(e));
  }
}

export function formatLog(events: StoredEvent[], options: LogOptions = {}): string {
  return events
    .map((e) => formatEvent(e, options))
    .filter((l): l is string => l !== undefined)
    .join('\n');
}

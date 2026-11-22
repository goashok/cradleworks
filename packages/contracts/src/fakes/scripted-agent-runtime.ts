// AgentRuntime that plays a script instead of calling a model. It writes real files in
// the sandbox workspace and emits the same normalised events a real runtime must, so
// the orchestrator can be tested end to end without an agent.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AdapterError,
  ZERO_USAGE,
  type AgentEvent,
  type AgentOutcome,
  type AgentRun,
  type AgentRunRequest,
  type AgentRuntime,
  type Usage,
} from '@cradleworks/interfaces';

export type ScriptStep =
  | { kind: 'message'; text: string }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'tool'; tool: string; input: unknown; output: string; isError?: boolean }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { kind: 'wait'; ms: number }
  | { kind: 'fail'; error: string };

export type Script = (request: AgentRunRequest) => ScriptStep[];

export class ScriptedAgentRuntime implements AgentRuntime {
  readonly id = 'scripted';
  readonly #script: Script;
  readonly #runs = new Set<string>();
  readonly #hosts: string[];

  /** `hosts`: what `requiredHosts` reports, so tests can check the core adds them. */
  constructor(script: Script, options: { hosts?: string[] } = {}) {
    this.#script = script;
    this.#hosts = options.hosts ?? [];
  }

  requiredHosts(): string[] {
    return [...this.#hosts];
  }


  async start(request: AgentRunRequest): Promise<AgentRun> {
    if (this.#runs.has(request.runId)) throw new AdapterError('conflict', `run ${request.runId} already started`, { adapter: this.id, operation: 'start' });
    this.#runs.add(request.runId);
    return new ScriptedRun(request, this.#script(request));
  }
}

class ScriptedRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly #channel = new Channel<AgentEvent>();
  readonly #abort = new AbortController();
  #usage: Usage = { ...ZERO_USAGE };
  #seq = 0;
  #stopReason: string | undefined;
  #lastMessage: string | undefined;

  constructor(request: AgentRunRequest, steps: ScriptStep[]) {
    this.runId = request.runId;
    this.events = this.#channel;
    void this.#play(request, steps);
  }

  async stop(reason: string): Promise<void> {
    this.#stopReason ??= reason;
    this.#abort.abort();
  }

  async getUsage(): Promise<Usage> {
    return { ...this.#usage };
  }

  async #play(request: AgentRunRequest, steps: ScriptStep[]): Promise<void> {
    const { limits } = request;
    let timedOut = false;
    const timer =
      limits.maxWallSeconds !== undefined
        ? setTimeout(() => {
            timedOut = true;
            this.#abort.abort();
          }, limits.maxWallSeconds * 1000)
        : undefined;

    const finish = (outcome: AgentOutcome, error?: string) => {
      if (timer) clearTimeout(timer);
      // Like a real CLI agent, the closing summary is the last thing it said.
      const summary = this.#lastMessage;
      this.#emit({ type: 'done', outcome, total: { ...this.#usage }, ...(error ? { error } : {}), ...(summary ? { summary } : {}) });
      this.#channel.close();
    };

    try {
      for (const step of steps) {
        if (this.#abort.signal.aborted) break;
        switch (step.kind) {
          case 'message':
            this.#lastMessage = step.text;
            this.#emit({ type: 'message', role: 'assistant', text: step.text });
            break;
          case 'write': {
            const full = join(request.sandbox.workspacePath, step.path);
            const existed = existsSync(full);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, step.content);
            this.#emit({ type: 'file_change', path: step.path, change: existed ? 'modified' : 'added' });
            break;
          }
          case 'tool': {
            const callId = `call-${this.#seq + 1}`;
            this.#emit({ type: 'tool_call', callId, tool: step.tool, input: step.input });
            this.#emit({ type: 'tool_result', callId, isError: step.isError ?? false, output: step.output });
            break;
          }
          case 'usage': {
            this.#usage = {
              inputTokens: this.#usage.inputTokens + step.inputTokens,
              outputTokens: this.#usage.outputTokens + step.outputTokens,
              costUsd: this.#usage.costUsd + step.costUsd,
            };
            this.#emit({ type: 'usage', total: { ...this.#usage } });
            const tokens = this.#usage.inputTokens + this.#usage.outputTokens;
            if ((limits.maxSpendUsd !== undefined && this.#usage.costUsd > limits.maxSpendUsd) || (limits.maxTokens !== undefined && tokens > limits.maxTokens)) {
              return finish('limit_reached', 'run limit reached');
            }
            break;
          }
          case 'wait':
            await sleep(step.ms, this.#abort.signal);
            break;
          case 'fail':
            return finish('failed', step.error);
        }
      }
      if (timedOut) return finish('timed_out', `exceeded ${limits.maxWallSeconds}s`);
      if (this.#abort.signal.aborted) return finish('stopped', this.#stopReason);
      finish('succeeded');
    } catch (error) {
      finish('failed', error instanceof Error ? error.message : String(error));
    }
  }

  #emit(event: DistributiveOmit<AgentEvent, 'runId' | 'seq' | 'at'>): void {
    this.#channel.push({ ...event, runId: this.runId, seq: ++this.#seq, at: new Date().toISOString() } as AgentEvent);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** A single-consumer async queue. */
class Channel<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;
  #iterated = false;

  push(value: T): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value, done: false });
    } else {
      this.#buffer.push(value);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterated) throw new Error('agent events can be iterated once');
    this.#iterated = true;
    return {
      next: () => {
        const value = this.#buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

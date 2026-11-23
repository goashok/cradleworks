// AgentRuntime that runs the Codex CLI headless (`codex exec --json`) inside the task's sandbox.
//
// As with the Claude Code runtime, the sandbox is the security boundary: Codex's own sandbox
// and approval prompts are turned off (nobody is there to answer, and the factory's sandbox
// already isolates it), the sandbox's network allow-list holds, and the credential stays
// outside where the sandbox has a credential gateway. Every event is scrubbed of it.
//
// What Codex does not offer, and how this adapter makes up for it:
// - No system-prompt flag: the role prompt leads the prompt on stdin.
// - No per-command deny list in exec mode: each command is checked as it starts, and a
//   refused one stops the run (outcome `failed`, with a `denied` event). The command may
//   already be running when it is seen; the sandbox holds no credentials to push with.
// - No spend cap, and usage only when the run ends: spend is priced from tokens (an estimate,
//   see DEFAULT_PRICES) and checked then; a run over its cap ends `limit_reached`. The
//   wall-clock limit is what stops a long run part way.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdapterError, type AgentEvent, type AgentOutcome, type AgentRun, type AgentRunRequest, type AgentRuntime, type Sandbox, type SandboxProcess, type Usage } from '@cradleworks/interfaces';
import type { CodexAuth } from './auth.ts';
import { CodexMapper, DEFAULT_PRICES, FALLBACK_PRICE, type Draft, type Price } from './event-mapper.ts';

const ADAPTER = 'cli-agent';
export const CODEX_AGENT = 'codex';
export const MODEL_API_HOST = 'api.openai.com';
export const PLACEHOLDER = 'cradleworks-credential-held-outside-the-sandbox';

export interface CodexRuntimeOptions {
  sandbox: Sandbox;
  auth: CodexAuth;
  /** The command inside the sandbox image. Default `codex`. */
  command?: string;
  /** Per-model prices, over DEFAULT_PRICES. */
  prices?: Record<string, Price>;
  clock?: () => string;
}

export class CodexRuntime implements AgentRuntime {
  readonly id = ADAPTER;
  readonly #options: CodexRuntimeOptions;
  readonly #runs = new Set<string>();

  constructor(options: CodexRuntimeOptions) {
    this.#options = options;
  }

  requiredHosts(): string[] {
    return [MODEL_API_HOST];
  }

  async start(request: AgentRunRequest): Promise<AgentRun> {
    if (request.profile.agent !== CODEX_AGENT) throw fail('invalid_input', `this runtime drives "${CODEX_AGENT}", not "${request.profile.agent}"`);
    if (this.#runs.has(request.runId)) throw fail('conflict', `run ${request.runId} already started`);
    this.#runs.add(request.runId);

    const gateway = await this.#gateway(request);
    const proc = await this.#options.sandbox.spawn(request.sandbox, this.#argv(request), {
      env: { ...request.env, ...this.#env(gateway) },
      stdin: promptOf(request),
    });
    const price = { ...DEFAULT_PRICES, ...this.#options.prices }[request.profile.model] ?? FALLBACK_PRICE;
    return new CodexRun(request, proc, this.#options.auth.apiKey, new CodexMapper(price), this.#options.clock ?? (() => new Date().toISOString()));
  }

  #argv(request: AgentRunRequest): string[] {
    return [
      this.#options.command ?? 'codex',
      'exec',
      '--json',
      '--model',
      request.profile.model,
      '--skip-git-repo-check',
      // The factory's sandbox isolates the run; Codex's own sandbox would need kernel features
      // a container lacks, and its approval prompts have nobody to answer them.
      '--dangerously-bypass-approvals-and-sandbox',
      // The prompt is on stdin.
      '-',
    ];
  }

  async #gateway(request: AgentRunRequest): Promise<string | undefined> {
    const sandbox = this.#options.sandbox;
    if (!sandbox.credentialGateway) return undefined;
    return sandbox.credentialGateway(request.sandbox, { host: MODEL_API_HOST, header: 'authorization', value: `Bearer ${this.#options.auth.apiKey}`, strip: [] });
  }

  #env(gateway?: string): Record<string, string> {
    const credential = gateway === undefined ? { OPENAI_API_KEY: this.#options.auth.apiKey } : { OPENAI_API_KEY: PLACEHOLDER, OPENAI_BASE_URL: `${gateway.replace(/\/$/, '')}/v1` };
    // A fresh home per run: no history, sessions or user config carried between runs.
    return { ...credential, CODEX_HOME: '/tmp/.codex' };
  }
}

class CodexRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly #request: AgentRunRequest;
  readonly #proc: SandboxProcess;
  readonly #secret: string;
  readonly #mapper: CodexMapper;
  readonly #clock: () => string;
  #seq = 0;
  #stoppedBy: 'stopped' | 'timed_out' | 'refused' | undefined;
  #refused: string | undefined;
  #finished: Usage | undefined;

  constructor(request: AgentRunRequest, proc: SandboxProcess, secret: string, mapper: CodexMapper, clock: () => string) {
    this.runId = request.runId;
    this.#request = request;
    this.#proc = proc;
    this.#secret = secret;
    this.#mapper = mapper;
    this.#clock = clock;
    this.events = this.#stream();
  }

  async stop(_reason: string): Promise<void> {
    this.#stoppedBy ??= 'stopped';
    await this.#proc.kill();
  }

  async getUsage(): Promise<Usage> {
    return this.#finished ?? this.#mapper.usage;
  }

  async *#stream(): AsyncGenerator<AgentEvent> {
    const { limits, tools } = this.#request;
    const wall = limits.maxWallSeconds;
    const timer =
      wall !== undefined
        ? setTimeout(() => {
            this.#stoppedBy ??= 'timed_out';
            void this.#proc.kill();
          }, wall * 1000)
        : undefined;
    try {
      for await (const line of this.#proc.lines) {
        const started = this.#mapper.startedCommand(line);
        const refused = started && !this.#stoppedBy ? refusedCommand(started.command, tools.commands ?? []) : undefined;
        for (const draft of this.#mapper.map(line)) yield this.#stamp(draft);
        if (refused) {
          this.#stoppedBy = 'refused';
          this.#refused = refused;
          yield this.#stamp({ type: 'denied', tool: 'shell', detail: started!.command });
          void this.#proc.kill();
        }
      }
      let result: Awaited<SandboxProcess['result']> | undefined;
      let startError: string | undefined;
      try {
        result = await this.#proc.result;
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      for (const change of await fileChanges(this.#request.sandbox.workspacePath)) yield this.#stamp(change);

      this.#finished = this.#mapper.usage;
      const ending = this.#mapper.ending;
      let outcome: AgentOutcome;
      let summary: string | undefined;
      let error: string | undefined;
      if (this.#stoppedBy === 'refused') {
        outcome = 'failed';
        error = `stopped: the agent ran \`${this.#refused}\`, which this run may not use`;
      } else if (this.#stoppedBy) {
        outcome = this.#stoppedBy;
        error = this.#stoppedBy === 'timed_out' ? `stopped at the ${wall}s wall-clock limit` : 'stopped on request';
      } else if (ending) {
        ({ outcome, summary, error } = ending);
      } else {
        outcome = 'failed';
        const stderr = result?.stderr.trim().split('\n').slice(-5).join('\n');
        error = startError ?? `Codex exited ${result?.exitCode ?? '?'} without finishing its turn${stderr ? `: ${stderr}` : ''}`;
        if (result && (result.exitCode === 127 || /not found/.test(stderr ?? ''))) {
          error = `the sandbox image has no \`codex\` command (${stderr || `exit ${result.exitCode}`}); add the Codex CLI to stack.image`;
        }
      }
      if (outcome === 'succeeded') {
        const over = overLimit(this.#finished, limits);
        if (over) {
          outcome = 'limit_reached';
          error = over;
        }
      }
      yield this.#stamp({ type: 'done', outcome, total: this.#finished, ...(summary !== undefined ? { summary } : {}), ...(error !== undefined ? { error } : {}) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #stamp(draft: Draft): AgentEvent {
    const event = { ...draft, runId: this.runId, seq: ++this.#seq, at: this.#clock() } as AgentEvent;
    return scrub(event, this.#secret);
  }
}

/** The role prompt and rule files first, then the station's input. */
export function promptOf(request: AgentRunRequest): string {
  const rules = request.contextFiles.length === 0 ? '' : `Project rule files to read before you start:\n${request.contextFiles.map((f) => `- ${f}`).join('\n')}`;
  return [request.rolePrompt, rules, '---', request.input].filter(Boolean).join('\n\n');
}

/**
 * The refused rule a command matches, by leading words, in any part of a compound command.
 * Codex usually runs commands as `bash -lc '<script>'`; the script is what gets checked.
 */
export function refusedCommand(command: string, rules: string[]): string | undefined {
  if (rules.length === 0) return undefined;
  const parts = unwrap(command)
    .split(/&&|\|\||;|\||\n|\$\(|`/)
    .map((p) => p.trim().replace(/^\(+/, '').replace(/^(?:sudo|env|command|exec|nohup|time)\s+/, '').trim())
    .filter(Boolean);
  for (const part of parts) {
    const words = part.split(/\s+/);
    for (const rule of rules) {
      const want = rule.trim().split(/\s+/);
      // `git -C dir push` is still a push: options between the first word and the rest are skipped.
      if (words[0] === want[0] && matchesAfterOptions(words.slice(1), want.slice(1))) return rule;
    }
  }
  return undefined;
}

function matchesAfterOptions(words: string[], want: string[]): boolean {
  if (want.length === 0) return true;
  let i = 0;
  while (i < words.length && words[i]!.startsWith('-') && words[i] !== want[0]) i += /^-[A-Za-z]$/.test(words[i]!) ? 2 : 1;
  return want.every((w, k) => words[i + k] === w);
}

function unwrap(command: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!m) return command;
  const inner = m[1]!.trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) return inner.slice(1, -1);
  return inner;
}

function overLimit(usage: Usage, limits: AgentRunRequest['limits']): string | undefined {
  if (limits.maxSpendUsd !== undefined && usage.costUsd > limits.maxSpendUsd) return `spent about $${usage.costUsd.toFixed(2)}, over the $${limits.maxSpendUsd} cap`;
  const tokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0);
  if (limits.maxTokens !== undefined && tokens > limits.maxTokens) return `used ${tokens} tokens, over the ${limits.maxTokens} cap`;
  return undefined;
}

function scrub(event: AgentEvent, secret: string): AgentEvent {
  if (secret.length < 8) return event;
  const text = JSON.stringify(event);
  return text.includes(secret) ? (JSON.parse(text.split(secret).join('[redacted]')) as AgentEvent) : event;
}

/** What the agent changed, from git on the host side of the shared checkout. */
async function fileChanges(workspace: string): Promise<Draft[]> {
  let out: string;
  try {
    ({ stdout: out } = await promisify(execFile)(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: workspace, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch {
    return [];
  }
  const parts = out.split('\0');
  const changes: Draft[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes('R')) changes.push({ type: 'file_change', path, change: 'renamed', previousPath: parts[++i] ?? '' });
    else if (code === '??' || code.includes('A')) changes.push({ type: 'file_change', path, change: 'added' });
    else if (code.includes('D')) changes.push({ type: 'file_change', path, change: 'deleted' });
    else changes.push({ type: 'file_change', path, change: 'modified' });
  }
  return changes;
}

function fail(code: AdapterError['code'], message: string): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation: 'start' });
}

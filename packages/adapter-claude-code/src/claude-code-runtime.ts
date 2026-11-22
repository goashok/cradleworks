// AgentRuntime that runs Claude Code headless inside the task's sandbox.
//
// The sandbox is the security boundary: Claude Code runs with its own permission prompts
// bypassed (nobody is there to answer them), limited by the factory's tool deny-list, the
// sandbox's network allow-list, and `--max-budget-usd`. Where the sandbox offers a
// credential gateway (the Docker sandbox does), the credential stays outside: the agent
// gets a placeholder and the gateway's URL, and the sandbox's proxy sets the real header.
// Otherwise it reaches the agent as an environment variable. Either way every event is
// scrubbed of it before it leaves this adapter.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AdapterError,
  type AgentEvent,
  type AgentOutcome,

  type AgentRun,
  type AgentRunRequest,
  type AgentRuntime,
  type Sandbox,
  type SandboxProcess,
  type Usage,
} from '@cradleworks/interfaces';
import { secretOf, type ClaudeAuth } from './auth.ts';
import { StreamMapper, type Draft } from './stream-mapper.ts';

const ADAPTER = 'cli-agent';
export const CLAUDE_CODE_AGENT = 'claude-code';
export const MODEL_API_HOST = 'api.anthropic.com';
/** What the agent holds instead of the credential when the sandbox's gateway sets it. */
export const PLACEHOLDER = 'cradleworks-credential-held-outside-the-sandbox';

export interface ClaudeCodeRuntimeOptions {
  /** The sandbox adapter the factory created this run's sandbox with. */
  sandbox: Sandbox;
  auth: ClaudeAuth;
  /** The command inside the sandbox image. Default `claude`. */
  command?: string;
  /** Spend cap when a request sets none. Default: no cap beyond the request's. */
  defaultMaxSpendUsd?: number;
  clock?: () => string;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = ADAPTER;
  readonly #options: ClaudeCodeRuntimeOptions;
  readonly #runs = new Set<string>();

  constructor(options: ClaudeCodeRuntimeOptions) {
    this.#options = options;
  }

  get authKind(): ClaudeAuth['kind'] {
    return this.#options.auth.kind;
  }

  requiredHosts(): string[] {
    return [MODEL_API_HOST];
  }

  async start(request: AgentRunRequest): Promise<AgentRun> {
    if (request.profile.agent !== CLAUDE_CODE_AGENT) {
      throw fail('invalid_input', `this runtime drives "${CLAUDE_CODE_AGENT}", not "${request.profile.agent}"`);
    }
    if (this.#runs.has(request.runId)) throw fail('conflict', `run ${request.runId} already started`);
    this.#runs.add(request.runId);

    const secret = secretOf(this.#options.auth);
    const gateway = await this.#gateway(request);
    const proc = await this.#options.sandbox.spawn(request.sandbox, this.#argv(request), {
      env: { ...request.env, ...this.#env(gateway) },
      stdin: request.input,
    });
    return new ClaudeCodeRun(request, proc, secret, this.#options.clock ?? (() => new Date().toISOString()));
  }

  #argv(request: AgentRunRequest): string[] {
    const { limits, tools, profile } = request;
    const budget = limits.maxSpendUsd ?? this.#options.defaultMaxSpendUsd;
    const prompt = [request.rolePrompt, contextNote(request.contextFiles)].filter(Boolean).join('\n\n');
    // A command is refused on its own and with arguments; Claude Code checks each part of a
    // compound command (`cd x && git push`) against these rules.
    const denied = [...tools.deny, ...(tools.commands ?? []).flatMap((c) => [`Bash(${c})`, `Bash(${c}:*)`])];
    return [
      this.#options.command ?? 'claude',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      profile.model,
      '--permission-mode',
      'bypassPermissions',
      '--no-session-persistence',
      // --bare skips user settings, hooks, plugins and auto-memory; it accepts only API keys.
      ...(this.#options.auth.kind === 'api_key' ? ['--bare'] : []),
      '--append-system-prompt',
      prompt,
      ...(budget !== undefined ? ['--max-budget-usd', String(budget)] : []),
      ...(tools.allow.length > 0 ? ['--allowedTools', ...tools.allow] : []),
      ...(denied.length > 0 ? ['--disallowedTools', ...denied] : []),
    ];
  }

  /**
   * Where the sandbox supports it, the credential stays outside: the sandbox's proxy sets it
   * on requests to the model API, and the agent gets a placeholder and the gateway's URL.
   */
  async #gateway(request: AgentRunRequest): Promise<string | undefined> {
    const sandbox = this.#options.sandbox;
    if (!sandbox.credentialGateway) return undefined;
    const auth = this.#options.auth;
    return sandbox.credentialGateway(
      request.sandbox,
      auth.kind === 'api_key'
        ? { host: MODEL_API_HOST, header: 'x-api-key', value: auth.apiKey, strip: ['authorization'] }
        : { host: MODEL_API_HOST, header: 'authorization', value: `Bearer ${auth.token}`, strip: ['x-api-key'] },
    );
  }

  #env(gateway?: string): Record<string, string> {
    const auth = this.#options.auth;
    const credential =
      gateway === undefined
        ? auth.kind === 'api_key'
          ? { ANTHROPIC_API_KEY: auth.apiKey }
          : { CLAUDE_CODE_OAUTH_TOKEN: auth.token }
        : { ANTHROPIC_BASE_URL: gateway, ...(auth.kind === 'api_key' ? { ANTHROPIC_API_KEY: PLACEHOLDER } : { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER }) };
    return {
      ...credential,
      // Only the model API is reachable anyway; these stop it trying anything else.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CONFIG_DIR: '/tmp/.claude',
    };
  }
}

class ClaudeCodeRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly #request: AgentRunRequest;
  readonly #proc: SandboxProcess;
  readonly #secret: string;
  readonly #clock: () => string;
  readonly #mapper = new StreamMapper();
  #seq = 0;
  #stoppedBy: 'stopped' | 'timed_out' | undefined;
  #finished: Usage | undefined;

  constructor(request: AgentRunRequest, proc: SandboxProcess, secret: string, clock: () => string) {
    this.runId = request.runId;
    this.#request = request;
    this.#proc = proc;
    this.#secret = secret;
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
    const wall = this.#request.limits.maxWallSeconds;
    const timer =
      wall !== undefined
        ? setTimeout(() => {
            this.#stoppedBy ??= 'timed_out';
            void this.#proc.kill();
          }, wall * 1000)
        : undefined;
    try {
      for await (const line of this.#proc.lines) {
        for (const draft of this.#mapper.map(line)) yield this.#stamp(draft);
      }
      let result: Awaited<SandboxProcess['result']> | undefined;
      let startError: string | undefined;
      try {
        result = await this.#proc.result;
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      for (const change of await fileChanges(this.#request.sandbox.workspacePath)) yield this.#stamp(change);

      const ending = this.#mapper.ending;
      let outcome: AgentOutcome;
      let summary: string | undefined;
      let error: string | undefined;
      if (this.#stoppedBy) {
        outcome = this.#stoppedBy;
        error = this.#stoppedBy === 'timed_out' ? `stopped at the ${wall}s wall-clock limit` : 'stopped on request';
      } else if (ending) {
        ({ outcome, summary, error } = ending);
      } else {
        outcome = 'failed';
        const stderr = result?.stderr.trim().split('\n').slice(-5).join('\n');
        error = startError ?? `Claude Code exited ${result?.exitCode ?? '?'} without a result${stderr ? `: ${stderr}` : ''}`;
        if (result && (result.exitCode === 127 || /not found/.test(stderr ?? ''))) {
          error = `the sandbox image has no \`claude\` command (${stderr || `exit ${result.exitCode}`}); add Claude Code to stack.image`;
        }
      }
      this.#finished = this.#mapper.usage;
      yield this.#stamp({
        type: 'done',
        outcome,
        total: this.#finished,
        ...(summary !== undefined ? { summary } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #stamp(draft: Draft): AgentEvent {
    const event = { ...draft, runId: this.runId, seq: ++this.#seq, at: this.#clock() } as AgentEvent;
    return scrub(event, this.#secret);
  }
}

/** Replaces any copy of the credential, e.g. if the agent ran `env`. */
function scrub(event: AgentEvent, secret: string): AgentEvent {
  if (secret.length < 8) return event;
  const text = JSON.stringify(event);
  return text.includes(secret) ? (JSON.parse(text.split(secret).join('[redacted]')) as AgentEvent) : event;
}

/** What the agent changed, from git on the host side of the shared checkout. */
async function fileChanges(workspace: string): Promise<Draft[]> {
  let out: string;
  try {
    // The sandbox keeps git's own files read-only, but be strict anyway: no hooks, no fsmonitor.
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
    if (code.includes('R')) {
      changes.push({ type: 'file_change', path, change: 'renamed', previousPath: parts[++i] ?? '' });
    } else if (code === '??' || code.includes('A')) {
      changes.push({ type: 'file_change', path, change: 'added' });
    } else if (code.includes('D')) {
      changes.push({ type: 'file_change', path, change: 'deleted' });
    } else {
      changes.push({ type: 'file_change', path, change: 'modified' });
    }
  }
  return changes;
}

function contextNote(files: string[]): string {
  return files.length === 0 ? '' : `Project rule files to read before you start:\n${files.map((f) => `- ${f}`).join('\n')}`;
}

function fail(code: AdapterError['code'], message: string): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation: 'start' });
}



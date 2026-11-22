import type { AgentEvent } from './agent-events.ts';
import type { Limits, Usage } from './common.ts';
import type { SandboxHandle } from './sandbox.ts';

export type AgentRole = 'specifier' | 'planner' | 'implementer' | 'tester' | 'reviewer';

/** Which agent and model play a role. Resolved from project config by the core. */
export interface AgentProfile {
  role: AgentRole;
  /** Runtime-specific agent id from config; opaque to the core. */
  agent: string;
  /** Model id from config; opaque to the core. */
  model: string;
}

export interface ToolPolicy {
  /** Tool names or patterns the agent may use. Empty = runtime default set. */
  allow: string[];
  /** Always refused, even if allowed above. */
  deny: string[];
  /**
   * Shell commands the agent may not run, by leading words (`git push` refuses
   * `git push origin main`). The runtime refuses them and reports each as a `denied` event.
   */
  commands?: string[];
}

export interface AgentRunRequest {
  runId: string;
  profile: AgentProfile;
  sandbox: SandboxHandle;
  rolePrompt: string;
  /** The station input, rendered as text (task, spec excerpt, rework notes). */
  input: string;
  /** Context pack files, relative to the workspace, the agent should read first. */
  contextFiles: string[];
  tools: ToolPolicy;
  limits: Limits;
  /** Run-scoped secrets such as model keys. Never logged. */
  env?: Record<string, string>;
}

export interface AgentRun {
  readonly runId: string;
  /** Ends with exactly one `done` event. Can be iterated once. */
  readonly events: AsyncIterable<AgentEvent>;
  stop(reason: string): Promise<void>;
  getUsage(): Promise<Usage>;
}

export interface AgentRuntime {
  readonly id: string;
  /**
   * Hosts the agent must reach from inside the sandbox (its model API), in allow-list
   * form. The core adds them to the sandbox's network policy for the run.
   */
  requiredHosts(profile: AgentProfile): string[];
  start(request: AgentRunRequest): Promise<AgentRun>;
}

// The `cli-agent` runtime: one AgentRuntime that hands each run to the CLI agent its profile
// names (`runtime.agent`, or `runtime.roles.<role>.agent`), so roles can use different agents.
// Each agent's runtime, and so its credential, is set up on first use only: a project that
// uses one agent never needs the other's credential.

import { AdapterError, type AgentProfile, type AgentRun, type AgentRunRequest, type AgentRuntime } from '@cradleworks/interfaces';

export class AgentsByName implements AgentRuntime {
  readonly id = 'cli-agent';
  readonly #factories: Record<string, () => AgentRuntime>;
  readonly #made = new Map<string, AgentRuntime>();

  constructor(factories: Record<string, () => AgentRuntime>) {
    this.#factories = factories;
  }

  requiredHosts(profile: AgentProfile): string[] {
    return this.#for(profile, 'requiredHosts').requiredHosts(profile);
  }

  start(request: AgentRunRequest): Promise<AgentRun> {
    return Promise.resolve().then(() => this.#for(request.profile, 'start').start(request));
  }

  get agents(): string[] {
    return Object.keys(this.#factories);
  }

  /** Sets up one agent's runtime now (and so reads its credential); undefined if unknown. */
  runtimeFor(agent: string): AgentRuntime | undefined {
    return this.#factories[agent] ? this.#for({ role: 'implementer', agent, model: '' }, 'runtimeFor') : undefined;
  }

  #for(profile: AgentProfile, operation: string): AgentRuntime {
    const made = this.#made.get(profile.agent);
    if (made) return made;
    const factory = this.#factories[profile.agent];
    if (!factory) {
      throw new AdapterError('invalid_input', `no agent "${profile.agent}" for the ${profile.role}; known agents: ${Object.keys(this.#factories).join(', ')}`, { adapter: this.id, operation });
    }
    const runtime = factory();
    this.#made.set(profile.agent, runtime);
    return runtime;
  }
}

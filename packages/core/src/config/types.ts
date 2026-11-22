// A project's resolved configuration: what `.factory/factory.yaml` says, merged over the
// factory-wide defaults and validated (Build spec, section 6). Parsing lives outside the
// core; the core only consumes this shape.

import type { AgentRole, NetworkPolicy } from '@cradleworks/interfaces';
import type { GateMode } from '../domain/types.ts';

export interface AgentChoice {
  /** Runtime-specific agent id; opaque to the core. */
  agent: string;
  /** Model id; opaque to the core. */
  model: string;
}

export interface StackCommands {
  build: string;
  test: string;
  lint?: string;
  /** Any further named commands, e.g. a frontend test run. */
  [name: string]: string | undefined;
}

export interface ProjectConfig {
  project: string;
  /** Registry ids of the adapters this project uses. */
  adapters: {
    scm: string;
    ci: string;
    tracker: string;
    sandbox: string;
    runtime: string;
  };
  runtime: AgentChoice & {
    /** Per-role overrides, e.g. a different model for the reviewer. */
    roles: Partial<Record<AgentRole, Partial<AgentChoice>>>;
  };
  stack: {
    image: string;
    commands: StackCommands;
  };
  context: {
    /** Paths, relative to the repo root, that the repo map covers. */
    include: string[];
    /** Glob patterns for rule files loaded into every agent. */
    rules: string[];
  };
  gates: {
    specApproval: GateMode;
    planCheck: GateMode;
    changeApproval: GateMode;
    autoMerge: boolean;
  };
  budgets: {
    perTaskUsd: number;
    perUserDailyUsd?: number;
    perUserMonthlyUsd?: number;
    maxReworkLoops: number;
  };
  /** Where approved specs are stored. */
  specs: 'repo' | 'factory';
  /** Tasks run at once for this project. */
  concurrency: number;
  verify: {
    /** Run the tester agent on work items that have a spec (from an issue). */
    tester: boolean;
  };
  /** Other repositories, by local path from this one, that the planner may give tasks to. */
  relatedRepos: string[];
  /** Paths, beyond the built-in ones, whose changes need a person and are never auto-merged. */
  protectedPaths?: string[];
  /** Commands, beyond the built-in ones, agents may not run in the sandbox. */
  commands?: { deny: string[] };
  /** Sandbox network egress. */
  network: NetworkPolicy;
}

/** The agent and model for a role: the role's override where set, else the project default. */
export function resolveAgent(config: ProjectConfig, role: AgentRole): AgentChoice {
  const override = config.runtime.roles[role] ?? {};
  return { agent: override.agent ?? config.runtime.agent, model: override.model ?? config.runtime.model };
}

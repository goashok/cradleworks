import type { WorkingCopy } from './source-control.ts';

export interface NetworkPolicy {
  mode: 'none' | 'allowlist';
  /** Host names or host:port pairs reachable in `allowlist` mode. */
  allow: string[];
}

export interface SandboxSpec {
  /** Task this sandbox serves; one sandbox per task. */
  taskId: string;
  /** Checkout the sandbox branches from. */
  source: WorkingCopy;
  baseRef: string;
  /** New branch created for the task. */
  branch: string;
  /** Environment image for build and test tools. */
  image: string;
  network: NetworkPolicy;
  /** Run-scoped variables, e.g. a short-lived repo token. Never logged. */
  env?: Record<string, string>;
  resources?: { cpus?: number; memoryMb?: number };
}

export interface SandboxHandle {
  id: string;
  taskId: string;
  branch: string;
  /** Host path of the task's own checkout; the agent works here. */
  workspacePath: string;
  /** The same checkout as seen from inside the sandbox. */
  sandboxPath: string;
}

export interface ExecOptions {
  /** Relative to the sandbox workspace. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  stdin?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Sandbox {
  readonly id: string;

  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** `command` is argv, never a shell string. */
  exec(sandbox: SandboxHandle, command: string[], options?: ExecOptions): Promise<ExecResult>;
  copyIn(sandbox: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void>;
  copyOut(sandbox: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void>;
  setNetworkPolicy(sandbox: SandboxHandle, policy: NetworkPolicy): Promise<void>;
  /** Removes the sandbox and its checkout. Safe to call twice. */
  destroy(sandbox: SandboxHandle): Promise<void>;
}

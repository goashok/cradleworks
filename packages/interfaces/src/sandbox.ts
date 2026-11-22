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

export interface CredentialGatewayInput {
  /** HTTPS host the gateway forwards to. */
  host: string;
  /** Header the gateway sets, replacing whatever the client sent in it. */
  header: string;
  value: string;
  /** Headers the gateway strips from the client's request (e.g. the other auth header). */
  strip?: string[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** A command started with `spawn`, whose output is read as it arrives. */
export interface SandboxProcess {
  /** Standard output, one line at a time (without the line break). Can be iterated once. */
  readonly lines: AsyncIterable<string>;
  /** Settles when the command ends. Its `stdout` is empty: it was delivered through `lines`. */
  readonly result: Promise<ExecResult>;
  /** Ends the command and everything it started. Safe to call after it ended. */
  kill(): Promise<void>;
}

export interface Sandbox {
  readonly id: string;

  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** `command` is argv, never a shell string. */
  exec(sandbox: SandboxHandle, command: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Like `exec`, but streams standard output. For long-running commands such as agents. */
  spawn(sandbox: SandboxHandle, command: string[], options?: ExecOptions): Promise<SandboxProcess>;
  copyIn(sandbox: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void>;
  copyOut(sandbox: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void>;
  setNetworkPolicy(sandbox: SandboxHandle, policy: NetworkPolicy): Promise<void>;
  /**
   * Optional. Lets the sandbox reach `host` over HTTPS through a gateway outside it that
   * sets `header` to `value` on every request, so the credential never enters the sandbox.
   * Returns the plain-HTTP base URL to use from inside, or undefined when this sandbox
   * can't (then the caller falls back to giving the sandbox the credential).
   */
  credentialGateway?(sandbox: SandboxHandle, input: CredentialGatewayInput): Promise<string | undefined>;
  /** Removes the sandbox and its checkout. Safe to call twice. */
  destroy(sandbox: SandboxHandle): Promise<void>;
}

/** One parsed allow-list entry. `ports` empty = the web ports, 80 and 443. */
export interface AllowRule {
  /** Lower-case host name or IPv4 address, without any `*.` prefix. */
  host: string;
  /** `*.example.com`: any name under example.com, but not example.com itself. */
  subdomains: boolean;
  ports: number[];
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/**
 * Parses an allow-list entry: `host`, `host:port`, `*.domain` or `*.domain:port`.
 * Returns an explanation instead of a rule when the entry is not valid.
 */
export function parseAllowEntry(entry: string): AllowRule | { error: string } {
  const text = entry.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) return { error: `"${entry}" should be a host name, not a URL` };
  const match = /^(\*\.)?([^:]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return { error: `"${entry}" is not a host, host:port or *.domain` };
  const [, star, host = '', port] = match;
  const ip = IPV4.test(host);
  if (!ip && !HOST_NAME.test(host)) return { error: `"${entry}" is not a valid host name (wildcards are allowed only as a leading "*.")` };
  if (ip && star) return { error: `"${entry}": a wildcard cannot be used with an IP address` };
  const portNumber = port === undefined ? undefined : Number(port);
  if (portNumber !== undefined && (portNumber < 1 || portNumber > 65535)) return { error: `"${entry}" has a port outside 1-65535` };
  return { host, subdomains: star !== undefined, ports: portNumber === undefined ? [] : [portNumber] };
}

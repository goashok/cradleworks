// Local Sandbox: one git worktree and one Docker container per task.
//
// The worktree lives on the host and is bind-mounted at /workspace, so the host sees the
// agent's changes as they happen. Because the host later runs git on that folder, the
// agent must not be able to change git's own files: the worktree's `.git` link and the
// repository's git folder are mounted read-only. Otherwise a hook or `core.fsmonitor`
// written by the agent would run on the host at commit time.
//
// The container drops every capability, cannot gain privileges, runs as the host user
// (so files it writes are the host user's), and has no network unless a policy allows it.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdapterError,
  parseAllowEntry,
  type AllowRule,
  type CredentialGatewayInput,
  type ExecOptions,
  type ExecResult,
  type NetworkPolicy,
  type Sandbox,
  type SandboxHandle,
  type SandboxProcess,
  type SandboxSpec,
} from '@cradleworks/interfaces';
import { runProgram, streamProgram, type RunResult } from './run.ts';

const ADAPTER = 'local-docker';
export const WORKSPACE = '/workspace';
export const SANDBOX_LABEL = 'dev.cradleworks.sandbox';
/** The pid of the factory process that made a container or network; prune spares live owners. */
export const OWNER_LABEL = 'dev.cradleworks.owner';
const EXEC_MARKER = 'CRADLEWORKS_EXEC';
const PROXY_ALIAS = 'egress-proxy';
const PROXY_PORT = 3128;
/** The proxy's credential gateway, reachable only from the sandbox's internal network. */
const GATEWAY_PORT = 3129;
/** Maven's resolver ignores Java's proxy properties, so it gets a settings file naming the proxy. */
const MAVEN_SETTINGS = '/etc/cradleworks/maven-settings.xml';
/** Stock Node image the egress proxy runs in. */
export const DEFAULT_PROXY_IMAGE = 'node:22.11.0-alpine3.20';
const PROXY_SCRIPT = fileURLToPath(new URL('./egress-proxy.mjs', import.meta.url));

/** One decision the egress proxy made. */
export interface EgressDecision {
  at: string;
  method: string;
  host: string;
  port: number;
  decision: 'allow' | 'deny';
  reason?: string;
  /** Gateway requests: the path asked for, without its query. */
  path?: string;
}

export interface DockerSandboxOptions {
  /** Holds one worktree per task. */
  rootDir: string;
  /** Path to the docker CLI. Default: found on PATH, then in the usual install folders. */
  docker?: string;
  /** Image for the per-sandbox egress proxy. Needs `node` 18 or later. */
  proxyImage?: string;
  /** Defaults for every container. */
  defaults?: { cpus?: number; memoryMb?: number; pidsLimit?: number };
  /** The owner pid recorded on containers. Default: this process. */
  ownerPid?: number;
}

interface Entry {
  handle: SandboxHandle;
  container: string;
  sourcePath: string;
  env: Record<string, string>;
  network: NetworkPolicy;
  /** Present while an allow-list policy is in force. */
  egress?: Egress;
  /** Credential gateways by id; kept here so a restarted proxy gets them back. */
  gateways: Record<string, CredentialGatewayInput>;
}

interface Egress {
  proxy: string;
  network: string;
  policyFile: string;
}

export class DockerSandbox implements Sandbox {
  readonly id = ADAPTER;
  readonly #root: string;
  readonly #docker: string;
  readonly #options: DockerSandboxOptions;
  readonly #owner: number;
  readonly #entries = new Map<string, Entry>();
  readonly #mavenSettings: string;

  constructor(options: DockerSandboxOptions) {
    this.#options = options;
    this.#owner = options.ownerPid ?? process.pid;
    this.#root = resolve(options.rootDir);
    mkdirSync(this.#root, { recursive: true });
    // Docker Desktop maps only some host folders into its VM; resolve symlinks such as
    // macOS's /var → /private/var so the paths we mount are the real ones.
    this.#root = realpathSync(this.#root);
    this.#docker = options.docker ?? findDocker();
    this.#mavenSettings = join(this.#root, '.tools', 'maven-settings.xml');
    mkdirSync(dirname(this.#mavenSettings), { recursive: true });
    writeFileSync(this.#mavenSettings, mavenSettings());
  }

  /** True if the docker CLI is installed and its engine answers. */
  static async available(docker = findDocker()): Promise<boolean> {
    try {
      return (await runProgram(docker, ['info', '--format', '{{.ServerVersion}}'], { env: dockerEnv(docker), timeoutMs: 15_000 })).exitCode === 0;
    } catch {
      return false;
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.taskId)) throw fail('invalid_input', 'create', `unsafe task id ${spec.taskId}`);
    const rules = allowRules(spec.network, 'create');
    const workspacePath = join(this.#root, spec.taskId);
    const container = containerName(spec.taskId);
    if (existsSync(workspacePath)) throw fail('conflict', 'create', `a sandbox for task ${spec.taskId} already exists`);

    const added = await runProgram('git', ['worktree', 'add', '--quiet', '-b', spec.branch, workspacePath, spec.baseRef], { cwd: spec.source.path });
    if (added.exitCode !== 0) {
      throw fail(/already exists/.test(added.stderr) ? 'conflict' : 'invalid_input', 'create', added.stderr.trim());
    }

    let egress: Egress | undefined;
    try {
      if (rules.length > 0) egress = await this.#startEgress(spec.taskId, rules);
      const gitDir = (await this.#gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], workspacePath)).trim();
      const resources = { ...this.#options.defaults, ...spec.resources };
      const args = [
        'run',
        '--detach',
        '--init',
        '--name',
        container,
        '--label',
        `${SANDBOX_LABEL}=${spec.taskId}`,
        '--label',
        `${OWNER_LABEL}=${this.#owner}`,
        '--network',
        egress?.network ?? 'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        String(this.#options.defaults?.pidsLimit ?? 1024),
        '--tmpfs',
        '/tmp:exec,mode=1777',
        ...userArgs(),
        '--mount',
        `type=bind,source=${workspacePath},target=${WORKSPACE}`,
        '--mount',
        `type=bind,source=${join(workspacePath, '.git')},target=${WORKSPACE}/.git,readonly`,
        '--mount',
        `type=bind,source=${gitDir},target=${gitDir},readonly`,
        '--mount',
        `type=bind,source=${this.#mavenSettings},target=${MAVEN_SETTINGS},readonly`,
        '--workdir',
        WORKSPACE,
        ...(resources.cpus !== undefined ? ['--cpus', String(resources.cpus)] : []),
        ...(resources.memoryMb !== undefined ? ['--memory', `${resources.memoryMb}m`] : []),
        '--entrypoint',
        'sh',
        spec.image,
        '-c',
        'trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done',
      ];
      const started = await this.#run(args, 'create', { timeoutMs: 10 * 60_000 });
      if (started.exitCode !== 0) throw dockerFailure('create', started, spec.image);
      await this.#registerUser(container);
    } catch (error) {
      await this.#removeContainer(container);
      if (egress) await this.#stopEgress(egress);
      await this.#removeWorktree(workspacePath, spec.source.path);
      throw error;
    }

    const handle: SandboxHandle = { id: `${ADAPTER}-${spec.taskId}`, taskId: spec.taskId, branch: spec.branch, workspacePath, sandboxPath: WORKSPACE };
    this.#entries.set(handle.id, {
      handle,
      container,
      sourcePath: spec.source.path,
      env: { ...(spec.env ?? {}) },
      network: spec.network,
      gateways: {},
      ...(egress ? { egress } : {}),
    });
    return { ...handle };
  }

  /**
   * The container runs as the host uid, which the image's /etc/passwd usually lacks; tools
   * that look up the current user (Postgres's initdb, ssh, some JVM and git paths) then fail.
   * Adds an entry as root right after start. Root needs no capability for this: it owns the
   * files. Best effort: an image with a read-only /etc still works for everything else.
   */
  async #registerUser(container: string): Promise<void> {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0) return;
    const script = [
      `awk -F: -v id=${uid} '$3 == id { found = 1 } END { exit !found }' /etc/passwd || echo 'cradleworks:x:${uid}:${gid}:Cradleworks sandbox:/tmp:/bin/sh' >> /etc/passwd`,
      `awk -F: -v id=${gid} '$3 == id { found = 1 } END { exit !found }' /etc/group || echo 'cradleworks:x:${gid}:' >> /etc/group`,
    ].join('; ');
    await this.#run(['exec', '--user', '0:0', container, 'sh', '-c', script], 'create', { timeoutMs: 30_000 });
  }

  async exec(sandbox: SandboxHandle, command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const entry = this.#entry(sandbox, 'exec');
    const call = this.#execCall(entry, command, options, 'exec');
    let result: RunResult;
    try {
      result = await runProgram(this.#docker, call.args, {
        env: dockerEnv(this.#docker),
        stdin: options.stdin ?? '',
        ...(options.timeoutSeconds !== undefined
          ? { timeoutMs: options.timeoutSeconds * 1000, onTimeout: () => this.#killMarked(entry.container, call.marker) }
          : {}),
      });
    } catch (error) {
      throw fail('unavailable', 'exec', `cannot run docker: ${(error as Error).message}`, error, true);
    } finally {
      call.cleanup();
    }
    checkStarted(entry, command, result, 'exec');
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, timedOut: result.timedOut };
  }

  async spawn(sandbox: SandboxHandle, command: string[], options: ExecOptions = {}): Promise<SandboxProcess> {
    const entry = this.#entry(sandbox, 'spawn');
    const call = this.#execCall(entry, command, options, 'spawn');
    const kill = () => this.#killMarked(entry.container, call.marker);
    const program = streamProgram(this.#docker, call.args, {
      env: dockerEnv(this.#docker),
      stdin: options.stdin ?? '',
      onKill: kill,
      ...(options.timeoutSeconds !== undefined ? { timeoutMs: options.timeoutSeconds * 1000 } : {}),
    });
    const result = program.result
      .then((r) => {
        checkStarted(entry, command, r, 'spawn');
        return { exitCode: r.exitCode, stdout: '', stderr: r.stderr, durationMs: r.durationMs, timedOut: r.timedOut };
      })
      .catch((error: unknown) => {
        throw error instanceof AdapterError ? error : fail('unavailable', 'spawn', `cannot run docker: ${(error as Error).message}`, error, true);
      })
      .finally(call.cleanup);
    result.catch(() => undefined);
    return { lines: program.lines, result, kill: program.kill };
  }

  /** docker exec arguments for a command; variables go through a private env file. */
  #execCall(entry: Entry, command: string[], options: ExecOptions, operation: string): { args: string[]; marker: string; cleanup: () => void } {
    if (command.length === 0) throw fail('invalid_input', operation, 'command must not be empty');
    const cwd = insideWorkspace(options.cwd ?? '.', operation);
    const marker = randomUUID();
    const vars: Record<string, string> = { HOME: '/tmp', ...(entry.egress ? proxyEnv() : {}), ...entry.env, ...(options.env ?? {}), [EXEC_MARKER]: marker };
    for (const [name, value] of Object.entries(vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail('invalid_input', operation, `bad variable name ${name}`);
      if (/[\r\n]/.test(value)) throw fail('invalid_input', operation, `variable ${name} holds a line break, which docker env files cannot carry`);
    }
    // Values go through a private file, so they never appear in a process list on the host
    // and never mix with the docker client's own environment.
    const envDir = mkdtempSync(join(tmpdir(), 'cw-env-'));
    const envFile = join(envDir, 'env');
    writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
    const args = ['exec', '--interactive', '--workdir', cwd, ...userArgs(), '--env-file', envFile, entry.container, ...command];
    return { args, marker, cleanup: () => rmSync(envDir, { recursive: true, force: true }) };
  }

  /** Copies through the container, so a symlink the agent planted is resolved inside it, never on the host. */
  async copyIn(sandbox: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void> {
    const entry = this.#entry(sandbox, 'copyIn');
    const target = insideWorkspace(sandboxPath, 'copyIn');
    const result = await this.#run(['cp', '--archive', hostPath, `${entry.container}:${target}`], 'copyIn');
    if (result.exitCode !== 0) throw fail('invalid_input', 'copyIn', result.stderr.trim());
  }

  async copyOut(sandbox: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void> {
    const entry = this.#entry(sandbox, 'copyOut');
    const source = insideWorkspace(sandboxPath, 'copyOut');
    const result = await this.#run(['cp', `${entry.container}:${source}`, hostPath], 'copyOut');
    if (result.exitCode !== 0) throw fail(/Could not find/.test(result.stderr) ? 'not_found' : 'invalid_input', 'copyOut', result.stderr.trim());
  }

  async setNetworkPolicy(sandbox: SandboxHandle, policy: NetworkPolicy): Promise<void> {
    const entry = this.#entry(sandbox, 'setNetworkPolicy');
    const rules = allowRules(policy, 'setNetworkPolicy');
    if (rules.length > 0 && entry.egress) {
      writePolicy(entry.egress.policyFile, rules); // the proxy re-reads it on every request
    } else if (rules.length > 0) {
      const egress = await this.#startEgress(entry.handle.taskId, rules);
      try {
        await this.#switchNetwork(entry.container, 'none', egress.network);
      } catch (error) {
        await this.#stopEgress(egress);
        throw error;
      }
      entry.egress = egress;
      if (Object.keys(entry.gateways).length) writeGateways(egress.policyFile, entry.gateways);
    } else if (entry.egress) {
      await this.#switchNetwork(entry.container, entry.egress.network, 'none');
      await this.#stopEgress(entry.egress);
      delete entry.egress;
    }
    entry.network = policy;
  }

  /** What the egress proxy allowed and refused, oldest first. Empty without an allow-list. */
  async egressLog(sandbox: SandboxHandle): Promise<EgressDecision[]> {
    const entry = this.#entry(sandbox, 'egressLog');
    if (!entry.egress) return [];
    const logs = await this.#run(['logs', entry.egress.proxy], 'egressLog');
    return logs.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as EgressDecision & { ready?: boolean })
      .filter((d) => !d.ready);
  }

  networkLog(sandbox: SandboxHandle): Promise<EgressDecision[]> {
    return this.egressLog(sandbox);
  }

  async destroy(sandbox: SandboxHandle): Promise<void> {
    const entry = this.#entries.get(sandbox.id);
    if (!entry) return;
    this.#entries.delete(sandbox.id);
    await this.#removeContainer(entry.container);
    if (entry.egress) await this.#stopEgress(entry.egress);
    await this.#removeWorktree(entry.handle.workspacePath, entry.sourcePath);
  }

  /**
   * Removes containers and networks left by a factory process that died. Another live
   * process's sandboxes are never touched: each is labelled with its owner's pid, and only
   * those whose owner is gone (or unlabelled ones, from before the label) are removed.
   */
  async pruneOrphans(): Promise<string[]> {
    const mine = new Set([...this.#entries.values()].flatMap((e) => [e.container, ...(e.egress ? [e.egress.proxy, e.egress.network] : [])]));
    const orphaned = (out: string) =>
      out
        .split('\n')
        .map((line) => line.trim().split('\t'))
        .filter(([name, owner]) => name && !mine.has(name) && !ownerAlive(owner))
        .map(([name]) => name!);
    const listed = await this.#run(['ps', '--all', '--filter', `label=${SANDBOX_LABEL}`, '--format', `{{.Names}}\t{{.Label "${OWNER_LABEL}"}}`], 'prune');
    const orphans = orphaned(listed.stdout);
    for (const name of orphans) await this.#removeContainer(name);
    const nets = await this.#run(['network', 'ls', '--filter', `label=${SANDBOX_LABEL}`, '--format', `{{.Name}}\t{{.Label "${OWNER_LABEL}"}}`], 'prune');
    for (const name of orphaned(nets.stdout)) await this.#run(['network', 'rm', name], 'prune');
    return orphans;
  }

  /** Test helper: the container behind a sandbox. */
  containerOf(sandbox: SandboxHandle): string | undefined {
    return this.#entries.get(sandbox.id)?.container;
  }

  /**
   * Starts the sandbox's own egress proxy: an internal network with no route out, and a
   * proxy container attached to it and to the default bridge. The proxy is the only exit.
   */
  async #startEgress(taskId: string, rules: AllowRule[]): Promise<Egress> {
    const name = containerName(taskId);
    const egress: Egress = { proxy: `${name}-egress`, network: `${name}-net`, policyFile: join(this.#root, '.egress', taskId, 'allow.json') };
    writePolicy(egress.policyFile, rules);
    try {
      const net = await this.#run(['network', 'create', '--internal', '--label', `${SANDBOX_LABEL}=${taskId}`, '--label', `${OWNER_LABEL}=${this.#owner}`, egress.network], 'create');
      if (net.exitCode !== 0) throw dockerFailure('create', net);
      const proxy = await this.#run(
        [
          'run',
          '--detach',
          '--init',
          '--name',
          egress.proxy,
          '--label',
          `${SANDBOX_LABEL}=${taskId}`,
          '--label',
          `${OWNER_LABEL}=${this.#owner}`,
          '--network',
          'bridge',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--read-only',
          '--pids-limit',
          '256',
          '--memory',
          '128m',
          '--user',
          // The host user, so the proxy can read the credential file (mode 0600) it mounts.
          typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.() ?? process.getuid()}` : '1000:1000',
          '--mount',
          `type=bind,source=${PROXY_SCRIPT},target=/proxy/egress-proxy.mjs,readonly`,
          '--mount',
          `type=bind,source=${dirname(egress.policyFile)},target=/policy,readonly`,
          '--env',
          `PROXY_PORT=${PROXY_PORT}`,
          '--env',
          `GATEWAY_PORT=${GATEWAY_PORT}`,
          this.#options.proxyImage ?? DEFAULT_PROXY_IMAGE,
          'node',
          '/proxy/egress-proxy.mjs',
        ],
        'create',
        { timeoutMs: 10 * 60_000 },
      );
      if (proxy.exitCode !== 0) throw dockerFailure('create', proxy, this.#options.proxyImage ?? DEFAULT_PROXY_IMAGE);
      const joined = await this.#run(['network', 'connect', '--alias', PROXY_ALIAS, egress.network, egress.proxy], 'create');
      if (joined.exitCode !== 0) throw dockerFailure('create', joined);
      await this.#waitReady(egress.proxy);
      return egress;
    } catch (error) {
      await this.#stopEgress(egress);
      throw error;
    }
  }

  async #waitReady(proxy: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const logs = await this.#run(['logs', proxy], 'create');
      if (logs.stdout.includes('"ready":true')) return;
      if (logs.exitCode !== 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const logs = await this.#run(['logs', proxy], 'create');
    throw fail('unavailable', 'create', `egress proxy did not start: ${(logs.stderr || logs.stdout).trim().slice(-500)}`);
  }

  /**
   * A gateway on the sandbox's own egress proxy: the sandbox sends plain HTTP to it, and
   * the proxy forwards over HTTPS with the credential set. The credential is written to a
   * file only the proxy mounts, and is never in the sandbox's environment or filesystem.
   */
  async credentialGateway(sandbox: SandboxHandle, input: CredentialGatewayInput): Promise<string | undefined> {
    const entry = this.#entry(sandbox, 'credentialGateway');
    if (!entry.egress) return undefined; // no proxy (network "none"): nothing could reach it
    const id = `g${Object.keys(entry.gateways).length + 1}`;
    entry.gateways[id] = input;
    writeGateways(entry.egress.policyFile, entry.gateways);
    return `http://${PROXY_ALIAS}:${GATEWAY_PORT}/${id}`;
  }

  async #stopEgress(egress: Egress): Promise<void> {
    await this.#removeContainer(egress.proxy);
    await this.#run(['network', 'rm', egress.network], 'destroy').catch(() => undefined);
    rmSync(dirname(egress.policyFile), { recursive: true, force: true });
  }

  async #switchNetwork(container: string, from: string, to: string): Promise<void> {
    const off = await this.#run(['network', 'disconnect', '--force', from, container], 'setNetworkPolicy');
    if (off.exitCode !== 0) throw dockerFailure('setNetworkPolicy', off);
    const on = await this.#run(['network', 'connect', to, container], 'setNetworkPolicy');
    if (on.exitCode !== 0) throw dockerFailure('setNetworkPolicy', on);
  }

  async #killMarked(container: string, marker: string): Promise<void> {
    // Every process the command started inherits the marker, so this ends the whole tree.
    const script = `for d in /proc/[0-9]*; do if tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx '${EXEC_MARKER}=${marker}'; then kill -9 "\${d#/proc/}" 2>/dev/null; fi; done; true`;
    await runProgram(this.#docker, ['exec', ...userArgs(), container, 'sh', '-c', script], { env: dockerEnv(this.#docker), timeoutMs: 15_000 }).catch(() => undefined);
  }

  async #removeContainer(name: string): Promise<void> {
    await runProgram(this.#docker, ['rm', '--force', '--volumes', name], { env: dockerEnv(this.#docker), timeoutMs: 60_000 }).catch(() => undefined);
  }

  async #removeWorktree(path: string, sourcePath: string): Promise<void> {
    const removed = await runProgram('git', ['worktree', 'remove', '--force', path], { cwd: sourcePath }).catch(() => undefined);
    if (removed?.exitCode !== 0) {
      rmSync(path, { recursive: true, force: true });
      await runProgram('git', ['worktree', 'prune'], { cwd: sourcePath }).catch(() => undefined);
    }
  }

  async #gitOut(args: string[], cwd: string): Promise<string> {
    const r = await runProgram('git', args, { cwd });
    if (r.exitCode !== 0) throw fail('invalid_input', 'create', r.stderr.trim());
    return r.stdout;
  }

  async #run(args: string[], operation: string, options: { timeoutMs?: number } = {}): Promise<RunResult> {
    try {
      return await runProgram(this.#docker, args, { env: dockerEnv(this.#docker), timeoutMs: options.timeoutMs ?? 120_000 });
    } catch (error) {
      throw fail('unavailable', operation, `cannot run docker at ${this.#docker}: ${(error as Error).message}`, error, true);
    }
  }

  #entry(sandbox: SandboxHandle, operation: string): Entry {
    const entry = this.#entries.get(sandbox.id);
    if (!entry) throw fail('not_found', operation, `no sandbox ${sandbox.id}`);
    return entry;
  }
}

function allowRules(policy: NetworkPolicy, operation: string): AllowRule[] {
  if (policy.mode === 'none') return [];
  return policy.allow.map((entry) => {
    const parsed = parseAllowEntry(entry);
    if ('error' in parsed) throw fail('invalid_input', operation, `network allow-list: ${parsed.error}`);
    return parsed;
  });
}

/** Written whole and renamed into place, so the proxy never reads half a file. */
/** Whether the factory process with this pid still runs; an unlabelled resource has no owner. */
function ownerAlive(owner: string | undefined): boolean {
  const pid = Number(owner);
  if (!owner || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // alive, someone else's
  }
}

/** Credentials for the gateway, beside the policy, readable by the owner only. */
function writeGateways(policyFile: string, gateways: Record<string, CredentialGatewayInput>): void {
  const file = join(dirname(policyFile), 'gateways.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ gateways }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function writePolicy(file: string, rules: AllowRule[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ rules }), { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
}

/** Proxy settings most tools read: curl, wget, git, npm, pip, and the JVM. */
function proxyEnv(): Record<string, string> {
  const url = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  // The proxy's own name is reached directly: that's the credential gateway.
  const noProxy = `localhost,127.0.0.1,::1,${PROXY_ALIAS}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    JAVA_TOOL_OPTIONS: `-Dhttp.proxyHost=${PROXY_ALIAS} -Dhttp.proxyPort=${PROXY_PORT} -Dhttps.proxyHost=${PROXY_ALIAS} -Dhttps.proxyPort=${PROXY_PORT} -Dhttp.nonProxyHosts=localhost|127.0.0.1|${PROXY_ALIAS}`,
    // Maven 3.9+ adds MAVEN_ARGS to every command line. Global settings, so a project's own
    // ~/.m2/settings.xml still applies on top.
    MAVEN_ARGS: `--global-settings ${MAVEN_SETTINGS}`,
  };
}

function mavenSettings(): string {
  const proxy = (protocol: string) =>
    `    <proxy><id>cradleworks-${protocol}</id><active>true</active><protocol>${protocol}</protocol><host>${PROXY_ALIAS}</host><port>${PROXY_PORT}</port><nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Written by Cradleworks: routes Maven through the sandbox's egress proxy. -->\n<settings>\n  <proxies>\n${proxy('https')}\n${proxy('http')}\n  </proxies>\n</settings>\n`;
}

function checkStarted(entry: Entry, command: string[], result: RunResult, operation: string): void {
  if (result.timedOut || result.exitCode === 0) return;
  // docker exec reports 126/127 itself when the command cannot be started.
  if ((result.exitCode === 126 || result.exitCode === 127) && /OCI runtime exec failed|executable file not found/.test(result.stderr)) {
    throw fail('invalid_input', operation, `cannot run ${command[0]}: ${result.stderr.trim()}`);
  }
  if (/No such container|is not running/.test(result.stderr)) {
    throw fail('unavailable', operation, `sandbox container ${entry.container} is gone: ${result.stderr.trim()}`);
  }
}

/** Resolves a sandbox path (relative, or absolute under /workspace) and refuses escapes. */
function insideWorkspace(path: string, operation: string): string {
  const full = posix.isAbsolute(path) ? posix.normalize(path) : posix.join(WORKSPACE, path);
  if (full !== WORKSPACE && !full.startsWith(`${WORKSPACE}/`)) throw fail('invalid_input', operation, `${path} is outside the sandbox`);
  if (full === `${WORKSPACE}/.git` || full.startsWith(`${WORKSPACE}/.git/`)) throw fail('invalid_input', operation, `${path} is git's own data`);
  return full;
}

function containerName(taskId: string): string {
  return `cradleworks-${taskId}`.slice(0, 128);
}

function userArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && gid !== undefined ? ['--user', `${uid}:${gid}`] : [];
}

/** The docker CLI finds its credential helpers on PATH, so its own folder goes first. */
function dockerEnv(docker: string): NodeJS.ProcessEnv {
  const dir = isAbsolute(docker) ? dirname(docker) : undefined;
  return { ...process.env, ...(dir ? { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` } : {}) };
}

export function findDocker(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'docker'))) return join(dir, 'docker');
  }
  for (const candidate of [join(homedir(), '.docker', 'bin', 'docker'), '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'docker';
}

function dockerFailure(operation: string, result: RunResult, image?: string): AdapterError {
  const message = result.stderr.trim() || `docker exited ${result.exitCode}`;
  if (/Cannot connect to the Docker daemon|error during connect|docker daemon is not running/i.test(message)) {
    return fail('unavailable', operation, `the Docker engine is not running: ${message}`, undefined, true);
  }
  if (/Conflict\. The container name/.test(message)) return fail('conflict', operation, message);
  if (image && /Unable to find image|pull access denied|manifest unknown|not found/i.test(message)) {
    return fail('invalid_input', operation, `cannot get image ${image}: ${message}`);
  }
  return fail('unknown', operation, message);
}

function fail(code: AdapterError['code'], operation: string, message: string, cause?: unknown, retryable?: boolean): AdapterError {
  return new AdapterError(code, message, { adapter: ADAPTER, operation, cause, ...(retryable !== undefined ? { retryable } : {}) });
}

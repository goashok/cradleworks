// Live AgentRuntime contract: real Claude Code in a real Docker sandbox, talking to the
// model API through the egress proxy. Opt in with CRADLEWORKS_CLAUDE_CONTRACT=1; it spends
// a few cents per run (Haiku, each run capped at $0.25). Runs once per credential found:
// API key and/or subscription token.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandbox, findDocker } from '@cradleworks/adapter-local';
import { describeAgentRuntimeContract } from '@cradleworks/contracts';
import { createBareRepo, LocalGitSourceControl, localRepoRef } from '@cradleworks/contracts/fakes';
import type { SandboxHandle } from '@cradleworks/interfaces';
import { describe, expect, it } from 'vitest';
import { secretOf } from './auth.ts';
import { PLACEHOLDER } from './claude-code-runtime.ts';
import { ClaudeCodeRuntime, findApiKey, findOAuthToken, type ClaudeAuth } from './index.ts';

export const AGENT_IMAGE = 'cradleworks/agent-claude-code:2.1.319-test';
const MODEL = process.env.CRADLEWORKS_CLAUDE_MODEL ?? 'claude-haiku-5-5';
const enabled = process.env.CRADLEWORKS_CLAUDE_CONTRACT === '1';
const docker = findDocker();

function ensureImage(): void {
  try {
    execFileSync(docker, ['image', 'inspect', AGENT_IMAGE], { stdio: 'ignore' });
  } catch {
    execFileSync(docker, ['build', '--quiet', '--tag', AGENT_IMAGE, new URL('../image', import.meta.url).pathname], { stdio: 'inherit' });
  }
}

const credentials: Array<[string, ClaudeAuth | undefined]> = enabled
  ? [
      ['API key', findApiKey()],
      ['subscription', findOAuthToken()],
    ]
  : [];

if (!enabled) describe.skip('Claude Code live contract (set CRADLEWORKS_CLAUDE_CONTRACT=1)', () => it('skipped', () => undefined));

for (const [label, auth] of credentials) {
  if (!auth) {
    describe.skip(`AgentRuntime contract: claude code, ${label} (no credential found)`, () => it('skipped', () => undefined));
    continue;
  }
  describeAgentRuntimeContract(
    `claude code, ${label}`,
    async () => {
      ensureImage();
      const root = mkdtempSync(join(tmpdir(), 'cw-claude-live-'));
      await createBareRepo(join(root, 'remote.git'), { 'README.md': '# Fixture\n' });
      const source = await new LocalGitSourceControl().clone(localRepoRef(join(root, 'remote.git')), join(root, 'source'));
      const sandbox = new DockerSandbox({ rootDir: join(root, 'sandboxes'), docker });
      const runtime = new ClaudeCodeRuntime({ sandbox, auth, defaultMaxSpendUsd: 0.25 });
      const opened: SandboxHandle[] = [];
      let n = 0;
      return {
        runtime,
        profile: { role: 'implementer', agent: 'claude-code', model: MODEL },
        newSandbox: async () => {
          const taskId = `live-${Date.now().toString(36)}-${++n}`;
          const s = await sandbox.create({
            taskId,
            source,
            baseRef: 'main',
            branch: `factory/${taskId}`,
            image: AGENT_IMAGE,
            network: { mode: 'allowlist', allow: runtime.requiredHosts() },
          });
          opened.push(s);
          return s;
        },
        tasks: {
          writeFile: { input: 'Create a file named hello.txt in the current directory containing exactly the word hi. Do nothing else, then reply done.', path: 'hello.txt', content: 'hi' },
          slow: { input: 'Use the Bash tool to run exactly this command: sleep 120. Wait for it to finish, then reply done.' },
        },
        cleanup: async () => {
          for (const s of opened) await sandbox.destroy(s);
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
    { timeoutMs: 600_000 },
  );

  describe(`credential gateway: claude code, ${label}`, () => {
    it('keeps the credential out of the sandbox and reaches the model through the gateway', { timeout: 600_000 }, async () => {
      ensureImage();
      const root = mkdtempSync(join(tmpdir(), 'cw-claude-gw-'));
      const sandbox = new DockerSandbox({ rootDir: join(root, 'sandboxes'), docker });
      try {
        await createBareRepo(join(root, 'remote.git'), { 'README.md': '# Fixture\n' });
        const source = await new LocalGitSourceControl().clone(localRepoRef(join(root, 'remote.git')), join(root, 'source'));
        const runtime = new ClaudeCodeRuntime({ sandbox, auth, defaultMaxSpendUsd: 0.25 });
        const taskId = `gw-${Date.now().toString(36)}`;
        const s = await sandbox.create({ taskId, source, baseRef: 'main', branch: `factory/${taskId}`, image: AGENT_IMAGE, network: { mode: 'allowlist', allow: runtime.requiredHosts() } });
        const run = await runtime.start({
          runId: `run-${taskId}`,
          profile: { role: 'implementer', agent: 'claude-code', model: MODEL },
          sandbox: s,
          rolePrompt: 'Answer briefly.',
          input: 'Use the Bash tool to run: env | sort > env.txt   Then reply done.',
          contextFiles: [],
          tools: { allow: [], deny: [] },
          limits: { maxWallSeconds: 300, maxSpendUsd: 0.25 },
        });
        let done: { outcome: string } | undefined;
        for await (const e of run.events) if (e.type === 'done') done = e;
        expect(done?.outcome).toBe('succeeded');
        const env = readFileSync(join(s.workspacePath, 'env.txt'), 'utf8');
        // Claude Code may hide credential variables from its tools; any it shows hold the placeholder.
        for (const line of env.split('\n').filter((l) => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=/.test(l))) expect(line.endsWith(`=${PLACEHOLDER}`)).toBe(true);
        expect(env).toMatch(/^ANTHROPIC_BASE_URL=http:\/\/egress-proxy:3129\/g\d+$/m);
        expect(env).not.toContain(secretOf(auth));
        const log = await sandbox.egressLog(s);
        expect(log.some((d) => d.method === 'GATEWAY' && d.decision === 'allow' && d.host === 'api.anthropic.com')).toBe(true);
        await sandbox.destroy(s);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

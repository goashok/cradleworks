// Live AgentRuntime contract: real Claude Code in a real Docker sandbox, talking to the
// model API through the egress proxy. Opt in with CRADLEWORKS_CLAUDE_CONTRACT=1; it spends
// a few cents per run (Haiku, each run capped at $0.25). Runs once per credential found:
// API key and/or subscription token.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandbox, findDocker } from '@cradleworks/adapter-local';
import { describeAgentRuntimeContract } from '@cradleworks/contracts';
import { createBareRepo, LocalGitSourceControl, localRepoRef } from '@cradleworks/contracts/fakes';
import type { SandboxHandle } from '@cradleworks/interfaces';
import { describe, it } from 'vitest';
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
}

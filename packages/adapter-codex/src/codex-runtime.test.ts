// Offline tests: the real runtime, a process sandbox, and a stand-in `codex` that answers like
// `codex exec --json`. A live run against the real CLI waits for an OpenAI key (M6-7).

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeAgentRuntimeContract } from '@cradleworks/contracts';
import { createBareRepo, LocalGitSourceControl, localRepoRef, ProcessSandbox } from '@cradleworks/contracts/fakes';
import type { AgentEvent, AgentRunRequest, Sandbox, SandboxHandle } from '@cradleworks/interfaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexMapper, CodexRuntime, DEFAULT_PRICES, FALLBACK_PRICE, promptOf, refusedCommand, resolveCodexAuth } from './index.ts';

const TRANSCRIPT = readFileSync(new URL('./fixtures/write-file.jsonl', import.meta.url), 'utf8');
const KEY = { kind: 'api_key' as const, apiKey: 'sk-proj-test-0123456789abcdef' };

let root: string;
let sandbox: ProcessSandbox;
let source: Awaited<ReturnType<LocalGitSourceControl['clone']>>;
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-codex-'));
  await createBareRepo(join(root, 'remote.git'), { 'README.md': '# Fixture\n' });
  source = await new LocalGitSourceControl().clone(localRepoRef(join(root, 'remote.git')), join(root, 'source'));
  sandbox = new ProcessSandbox(join(root, 'sandboxes'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A stand-in `codex`: records argv, env and stdin, then acts on the prompt.
 *   WRITE <path> <content>  writes the file and reports it like Codex would
 *   SLOW                    runs for a minute
 *   RUN <command>           reports starting <command>, then waits a little
 *   REPLAY                  prints the recorded transcript
 *   SPEND <tokens>          finishes with that many output tokens
 */
function fakeCodex(): { command: string; calls: string } {
  const dir = mkdtempSync(join(root, 'bin-'));
  const calls = join(dir, 'calls');
  const command = join(dir, 'codex');
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(calls)} + '.argv', process.argv.slice(2).join('\\n'));
fs.writeFileSync(${JSON.stringify(calls)} + '.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n'));
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(calls)} + '.stdin', prompt);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const done = (tokens = 40) => out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: tokens } });
out({ type: 'thread.started', thread_id: 't' });
out({ type: 'turn.started' });
let m;
if ((m = /WRITE (\\S+) (.+)/.exec(prompt))) {
  fs.writeFileSync(m[1], m[2] + '\\n');
  out({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: m[1], kind: 'add' }], status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Wrote ' + m[1] + '. Key: ' + (process.env.OPENAI_API_KEY || '') } });
  done();
} else if (/SLOW/.test(prompt)) {
  setTimeout(done, 60000);
} else if ((m = /RUN (.+)/.exec(prompt))) {
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: m[1], status: 'in_progress' } });
  setTimeout(() => { out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: m[1], aggregated_output: '', exit_code: 0, status: 'completed' } }); done(); }, 3000);
} else if (/REPLAY/.test(prompt)) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(new URL('./fixtures/write-file.jsonl', import.meta.url).pathname)}, 'utf8'));
} else if ((m = /SPEND (\\d+)/.exec(prompt))) {
  done(Number(m[1]));
} else {
  process.stderr.write('stand-in: no instruction\\n');
  process.exit(2);
}
`,
  );
  chmodSync(command, 0o755);
  return { command, calls };
}

async function newSandbox(): Promise<SandboxHandle> {
  const taskId = `t${++n}`;
  return sandbox.create({ taskId, source, baseRef: 'main', branch: `factory/${taskId}`, image: 'none', network: { mode: 'none', allow: [] } });
}

async function request(input: string, overrides: Partial<AgentRunRequest> = {}): Promise<AgentRunRequest> {
  return {
    runId: `run-${++n}`,
    profile: { role: 'implementer', agent: 'codex', model: 'gpt-5-codex' },
    sandbox: await newSandbox(),
    rolePrompt: 'You are the implementer.',
    input,
    contextFiles: ['.factory/rules/style.md'],
    tools: { allow: [], deny: [], commands: ['git push'] },
    limits: { maxWallSeconds: 60 },
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describeAgentRuntimeContract('Codex (stand-in CLI)', async () => {
  const { command } = fakeCodex();
  return {
    runtime: new CodexRuntime({ sandbox, auth: KEY, command }),
    profile: { role: 'implementer', agent: 'codex', model: 'gpt-5-codex' },
    newSandbox,
    tasks: { writeFile: { input: 'WRITE hello.txt hi there', path: 'hello.txt', content: 'hi there' }, slow: { input: 'SLOW' } },
    cleanup: async () => {},
  };
});

describe('CodexRuntime', () => {
  it('runs codex exec with the prompt on stdin, its own sandbox off, and a fresh home', async () => {
    const { command, calls } = fakeCodex();
    const runtime = new CodexRuntime({ sandbox, auth: KEY, command });
    const req = await request('WRITE a.txt x');
    await collect((await runtime.start(req)).events);
    expect(readFileSync(`${calls}.argv`, 'utf8').split('\n')).toEqual(['exec', '--json', '--model', 'gpt-5-codex', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-']);
    const stdin = readFileSync(`${calls}.stdin`, 'utf8');
    expect(stdin.indexOf('You are the implementer.')).toBe(0);
    expect(stdin).toContain('- .factory/rules/style.md');
    expect(stdin.trimEnd().endsWith('WRITE a.txt x')).toBe(true);
    const env = readFileSync(`${calls}.env`, 'utf8');
    expect(env).toContain(`OPENAI_API_KEY=${KEY.apiKey}`);
    expect(env).toContain('CODEX_HOME=/tmp/.codex');
  });

  it('keeps the key out of every event', async () => {
    const { command } = fakeCodex();
    const events = await collect((await new CodexRuntime({ sandbox, auth: KEY, command }).start(await request('WRITE b.txt y'))).events);
    expect(JSON.stringify(events)).not.toContain(KEY.apiKey);
    expect(JSON.stringify(events)).toContain('[redacted]');
  });

  it('gives the agent a placeholder and the gateway when the sandbox holds the credential', async () => {
    const { command, calls } = fakeCodex();
    const seen: unknown[] = [];
    // The runtime only spawns and asks for a gateway.
    const gated = {
      spawn: sandbox.spawn.bind(sandbox),
      credentialGateway: async (_s: SandboxHandle, input: unknown) => (seen.push(input), 'http://gateway.internal:8080'),
    } as unknown as Sandbox;
    await collect((await new CodexRuntime({ sandbox: gated, auth: KEY, command }).start(await request('WRITE c.txt z'))).events);
    expect(seen).toEqual([{ host: 'api.openai.com', header: 'authorization', value: `Bearer ${KEY.apiKey}`, strip: [] }]);
    const env = readFileSync(`${calls}.env`, 'utf8');
    expect(env).not.toContain(KEY.apiKey);
    expect(env).toContain('OPENAI_BASE_URL=http://gateway.internal:8080/v1');
  });

  it('stops a run that starts a refused command, and says so', async () => {
    const { command } = fakeCodex();
    const events = await collect((await new CodexRuntime({ sandbox, auth: KEY, command }).start(await request("RUN bash -lc 'git add -A && git -C . push origin main'"))).events);
    expect(events.find((e) => e.type === 'denied')).toMatchObject({ tool: 'shell', detail: expect.stringContaining('git -C . push') });
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'failed', error: expect.stringContaining('git push') });
  });

  it('ends limit_reached when the priced spend passes the cap', async () => {
    const { command } = fakeCodex();
    const events = await collect((await new CodexRuntime({ sandbox, auth: KEY, command }).start(await request('SPEND 200000', { limits: { maxWallSeconds: 60, maxSpendUsd: 1 } }))).events);
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'limit_reached', error: expect.stringContaining('over the $1 cap') });
  });

  it('says plainly when the image has no codex command', async () => {
    const events = await collect((await new CodexRuntime({ sandbox, auth: KEY, command: 'codex-not-installed-here' }).start(await request('x'))).events);
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'failed' });
    expect((events.at(-1) as { error: string }).error).toMatch(/codex|not found|ENOENT/);
  });

  it('refuses a profile for another agent', async () => {
    await expect(new CodexRuntime({ sandbox, auth: KEY }).start(await request('x', { profile: { role: 'implementer', agent: 'claude-code', model: 'm' } }))).rejects.toThrow(/drives "codex"/);
  });
});

describe('CodexMapper on the recorded transcript', () => {
  it('maps commands, results, patches and the closing message, and prices the tokens', () => {
    const mapper = new CodexMapper(DEFAULT_PRICES['gpt-5-codex']!);
    const drafts = TRANSCRIPT.split('\n').flatMap((l) => mapper.map(l));
    expect(drafts.map((d) => d.type)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'message', 'usage']);
    expect(drafts[0]).toEqual({ type: 'tool_call', callId: 'item_1', tool: 'shell', input: { command: 'bash -lc ls' } });
    expect(drafts[3]).toMatchObject({ type: 'tool_result', callId: 'item_2', isError: true });
    expect(drafts[4]).toMatchObject({ tool: 'apply_patch', input: { changes: [{ path: 'hello.txt', kind: 'add' }] } });
    // 315 fresh input, 24448 cached, 122 output at 1.25 / 0.125 / 10 per million.
    expect(mapper.usage).toEqual({ inputTokens: 315, outputTokens: 122, cacheReadTokens: 24448, costUsd: 0.004670 });
    expect(mapper.ending).toEqual({ outcome: 'succeeded', summary: 'Added hello.txt with a greeting.' });
  });

  it('reports a failed turn and stream errors', () => {
    const m = new CodexMapper(FALLBACK_PRICE);
    m.map('{"type":"error","message":"stream disconnected before completion"}');
    expect(m.ending).toEqual({ outcome: 'failed', error: 'stream disconnected before completion' });
    m.map('{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}');
    expect(m.ending).toEqual({ outcome: 'failed', error: 'unexpected status 401 Unauthorized' });
    expect(m.map('not json')).toEqual([]);
  });
});

describe('refusedCommand', () => {
  it('matches the leading words in any part of a wrapped or compound command', () => {
    const rules = ['git push', 'gh'];
    expect(refusedCommand("bash -lc 'git push origin main'", rules)).toBe('git push');
    expect(refusedCommand('/bin/bash -lc "cd x && git --no-pager push"', rules)).toBe('git push');
    expect(refusedCommand('bash -lc "echo $(gh auth token)"', rules)).toBe('gh');
    expect(refusedCommand('sudo git push', rules)).toBe('git push');
    expect(refusedCommand("bash -lc 'git status && git pushd'", rules)).toBeUndefined();
    expect(refusedCommand("bash -lc 'echo git push'", rules)).toBeUndefined();
    expect(refusedCommand('anything', [])).toBeUndefined();
  });
});

describe('auth and prompt', () => {
  it('reads the key from the environment, and explains a missing one', () => {
    expect(resolveCodexAuth({ env: { OPENAI_API_KEY: 'sk-a' }, keychain: () => undefined })).toEqual({ kind: 'api_key', apiKey: 'sk-a' });
    expect(resolveCodexAuth({ env: { CRADLEWORKS_OPENAI_API_KEY: 'sk-b', OPENAI_API_KEY: 'sk-a' } }).apiKey).toBe('sk-b');
    expect(() => resolveCodexAuth({ env: {}, keychain: () => undefined })).toThrow(/OPENAI_API_KEY/);
  });

  it('leaves out the rules section when there are no rule files', async () => {
    expect(promptOf({ ...(await request('do it')), contextFiles: [] })).toBe('You are the implementer.\n\n---\n\ndo it');
  });
});

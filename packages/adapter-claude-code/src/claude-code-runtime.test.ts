// Offline tests: the real runtime, a process sandbox, and a stand-in `claude` script that
// replays a recorded transcript. The live contract runs in claude-code.contract.test.ts.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareRepo, LocalGitSourceControl, localRepoRef, ProcessSandbox } from '@cradleworks/contracts/fakes';
import type { AgentEvent, AgentRunRequest, SandboxHandle } from '@cradleworks/interfaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeRuntime, resolveClaudeAuth, StreamMapper, type ClaudeAuth } from './index.ts';

const FIXTURE = readFileSync(new URL('./fixtures/denied-tools.jsonl', import.meta.url), 'utf8');
const API_KEY: ClaudeAuth = { kind: 'api_key', apiKey: 'sk-test-0123456789abcdef' };

let root: string;
let sandbox: ProcessSandbox;
let source: Awaited<ReturnType<LocalGitSourceControl['clone']>>;
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cw-claude-'));
  await createBareRepo(join(root, 'remote.git'), { 'README.md': '# Fixture\n' });
  source = await new LocalGitSourceControl().clone(localRepoRef(join(root, 'remote.git')), join(root, 'source'));
  sandbox = new ProcessSandbox(join(root, 'sandboxes'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in `claude`: records argv, env and stdin, runs `body`, then prints `transcript`. */
function fakeClaude(transcript: string, body = ''): { command: string; calls: string } {
  const dir = mkdtempSync(join(root, 'bin-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'transcript'), transcript);
  const command = join(dir, 'claude');
  writeFileSync(
    command,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${calls}.argv'\nenv > '${calls}.env'\ncat > '${calls}.stdin'\n${body}\ncat '${join(dir, 'transcript')}'\n`,
  );
  chmodSync(command, 0o755);
  return { command, calls };
}

async function newSandbox(): Promise<SandboxHandle> {
  const taskId = `t${++n}`;
  return sandbox.create({ taskId, source, baseRef: 'main', branch: `factory/${taskId}`, image: 'none', network: { mode: 'none', allow: [] } });
}

async function request(overrides: Partial<AgentRunRequest> = {}): Promise<AgentRunRequest> {
  return {
    runId: `run-${++n}`,
    profile: { role: 'implementer', agent: 'claude-code', model: 'claude-haiku-5-5' },
    sandbox: await newSandbox(),
    rolePrompt: 'You are the implementer.',
    input: '# Add hello.txt\n\nWrite hi.',
    contextFiles: ['.factory/rules/style.md'],
    tools: { allow: [], deny: ['WebFetch'] },
    limits: { maxWallSeconds: 60, maxSpendUsd: 0.5 },
    ...overrides,
  };
}

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of run.events) out.push(e);
  return out;
}

describe('StreamMapper', () => {
  it('maps a recorded transcript to normalised events', () => {
    const mapper = new StreamMapper();
    const drafts = FIXTURE.trim().split('\n').flatMap((line) => mapper.map(line));
    expect(drafts.map((d) => d.type)).toEqual([
      'message', // init
      'tool_call',
      'usage',
      'message', // permission refused
      'tool_result',
      'usage',
      'message',
      'tool_call',
      'message', // permission refused
      'tool_result',
      'usage', // third model message
      'message',
      'usage', // final totals from the result line
    ]);
    expect(drafts[1]).toMatchObject({ type: 'tool_call', tool: 'Bash', input: { command: 'echo "hi" > hello.txt && cat hello.txt' } });
    expect(drafts[4]).toMatchObject({ type: 'tool_result', isError: true });
    expect(mapper.ending).toMatchObject({ outcome: 'succeeded', summary: expect.stringContaining("couldn't create") });
    expect(mapper.usage).toEqual({ inputTokens: 8, outputTokens: 742, cacheReadTokens: 3664, cacheWriteTokens: 2678, costUsd: 0.00074319 });
  });

  it('counts each model message once, though its usage repeats on every content line', () => {
    const mapper = new StreamMapper();
    const msg = (content: object[]) => JSON.stringify({ type: 'assistant', message: { id: 'm1', content, usage: { input_tokens: 10, output_tokens: 5 } } });
    mapper.map(msg([{ type: 'text', text: 'a' }]));
    mapper.map(msg([{ type: 'tool_use', id: 't', name: 'Write', input: {} }]));
    expect(mapper.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('reads a budget stop as limit_reached and other errors as failed', () => {
    const budget = new StreamMapper();
    budget.map(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.5, usage: {} }));
    expect(budget.ending?.outcome).toBe('limit_reached');
    const broken = new StreamMapper();
    broken.map(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {} }));
    expect(broken.ending).toEqual({ outcome: 'failed', error: 'boom' });
  });
});

describe('ClaudeCodeRuntime', () => {
  it('runs claude headless in the sandbox with the right flags, prompt and credential', async () => {
    const fake = fakeClaude(FIXTURE);
    const runtime = new ClaudeCodeRuntime({ sandbox, auth: API_KEY, command: fake.command });
    expect(runtime.requiredHosts()).toEqual(['api.anthropic.com']);
    const events = await collect(await runtime.start(await request()));

    const argv = readFileSync(`${fake.calls}.argv`, 'utf8').trim().split('\n');
    expect(argv.slice(0, 10)).toEqual(['--print', '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-5-5', '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--bare']);
    expect(argv).toEqual(expect.arrayContaining(['--max-budget-usd', '0.5', '--disallowedTools', 'WebFetch']));
    const prompt = argv[argv.indexOf('--append-system-prompt') + 1];
    expect(prompt).toContain('You are the implementer.');
    expect(readFileSync(`${fake.calls}.argv`, 'utf8')).toContain('- .factory/rules/style.md');
    expect(readFileSync(`${fake.calls}.stdin`, 'utf8')).toBe('# Add hello.txt\n\nWrite hi.');
    const env = readFileSync(`${fake.calls}.env`, 'utf8');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-test-0123456789abcdef');
    expect(env).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    expect(argv.join(' ')).not.toContain('sk-test');

    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'succeeded', total: { costUsd: 0.00074319 } });
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('uses the subscription token without --bare', async () => {
    const fake = fakeClaude(FIXTURE);
    const runtime = new ClaudeCodeRuntime({ sandbox, auth: { kind: 'oauth_token', token: 'oat-test-0123456789' }, command: fake.command });
    await collect(await runtime.start(await request()));
    expect(readFileSync(`${fake.calls}.argv`, 'utf8').split('\n')).not.toContain('--bare');
    const env = readFileSync(`${fake.calls}.env`, 'utf8');
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=oat-test-0123456789');
    expect(env).not.toContain('ANTHROPIC_API_KEY=');
  });

  it('reports the files the agent changed, and scrubs the credential from every event', async () => {
    const leak = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ANTHROPIC_API_KEY=sk-test-0123456789abcdef' }] } });
    const fake = fakeClaude(`${leak}\n${FIXTURE}`, 'echo hi > hello.txt; rm README.md');
    const runtime = new ClaudeCodeRuntime({ sandbox, auth: API_KEY, command: fake.command });
    const events = await collect(await runtime.start(await request()));
    expect(JSON.stringify(events)).not.toContain('sk-test-0123456789abcdef');
    expect(JSON.stringify(events)).toContain('[redacted]');
    expect(events.filter((e) => e.type === 'file_change').map((e) => e.type === 'file_change' && [e.path, e.change])).toEqual([
      ['README.md', 'deleted'],
      ['hello.txt', 'added'],
    ]);
  });

  it('times out, stops on request, and refuses a repeated run id', async () => {
    const slow = fakeClaude('', 'sleep 30');
    const runtime = new ClaudeCodeRuntime({ sandbox, auth: API_KEY, command: slow.command });
    const timed = await collect(await runtime.start(await request({ limits: { maxWallSeconds: 1 } })));
    expect(timed.at(-1)).toMatchObject({ type: 'done', outcome: 'timed_out' });

    const req = await request();
    const run = await runtime.start(req);
    setTimeout(() => void run.stop('test'), 300);
    expect((await collect(run)).at(-1)).toMatchObject({ type: 'done', outcome: 'stopped' });
    await expect(runtime.start(req)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('explains a sandbox image without claude', async () => {
    const runtime = new ClaudeCodeRuntime({ sandbox, auth: API_KEY, command: join(root, 'no-such-claude') });
    const done = (await collect(await runtime.start(await request()))).at(-1);
    expect(done).toMatchObject({ type: 'done', outcome: 'failed' });
    expect(done?.type === 'done' && done.error).toMatch(/claude|no-such-claude/);
  });

  it('refuses a profile for another agent', async () => {
    const runtime = new ClaudeCodeRuntime({ sandbox, auth: API_KEY });
    await expect(runtime.start(await request({ profile: { role: 'implementer', agent: 'other', model: 'x' } }))).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('resolveClaudeAuth', () => {
  const none = () => undefined;
  it('prefers an API key, and can be told to use the subscription', () => {
    const env = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' };
    expect(resolveClaudeAuth({ env, keychain: none })).toEqual({ kind: 'api_key', apiKey: 'k' });
    expect(resolveClaudeAuth({ env: { ...env, CRADLEWORKS_CLAUDE_AUTH: 'subscription' }, keychain: none })).toEqual({ kind: 'oauth_token', token: 't' });
  });
  it('falls back to the Keychain, and explains what to do when nothing is set', () => {
    const keychain = (service: string) => (service === 'cradleworks-claude-oauth-token' ? 'from-keychain' : undefined);
    expect(resolveClaudeAuth({ env: {}, keychain })).toEqual({ kind: 'oauth_token', token: 'from-keychain' });
    expect(() => resolveClaudeAuth({ env: {}, keychain: none })).toThrow(/claude setup-token/);
  });
});

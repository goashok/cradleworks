import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareRepo, git, ScriptedAgentRuntime } from '@cradleworks/contracts/fakes';
import type { AgentRunRequest, AgentRuntime } from '@cradleworks/interfaces';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsByName } from './agents.ts';
import { defaultRegistry, run, type Registry } from './index.ts';

function stub(name: string, made: string[]): () => AgentRuntime {
  return () => {
    made.push(name);
    return { id: name, requiredHosts: () => [`${name}.example`], start: async (r: AgentRunRequest) => ({ runId: r.runId, events: (async function* () {})(), stop: async () => {}, getUsage: async () => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 }) }) };
  };
}
const profile = (agent: string) => ({ role: 'reviewer' as const, agent, model: 'm' });

describe('AgentsByName', () => {
  it('hands each profile to its agent, setting each up once and only when used', async () => {
    const made: string[] = [];
    const agents = new AgentsByName({ 'claude-code': stub('claude-code', made), codex: stub('codex', made) });
    expect(made).toEqual([]);
    expect(agents.requiredHosts(profile('codex'))).toEqual(['codex.example']);
    expect(agents.requiredHosts(profile('codex'))).toEqual(['codex.example']);
    expect(made).toEqual(['codex']);
    expect(agents.agents).toEqual(['claude-code', 'codex']);
  });

  it('names the known agents when a profile asks for another', async () => {
    const agents = new AgentsByName({ codex: stub('codex', []) });
    expect(() => agents.requiredHosts(profile('aider'))).toThrow(/no agent "aider" for the reviewer; known agents: codex/);
    await expect(agents.start({ profile: profile('aider') } as AgentRunRequest)).rejects.toThrow(/no agent "aider"/);
    expect(agents.runtimeFor('aider')).toBeUndefined();
  });
});

describe('the CLI with agents per role', () => {
  let root: string | undefined;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  async function project(runtimeYaml: string) {
    root = mkdtempSync(join(tmpdir(), 'cw-agents-'));
    await createBareRepo(join(root, 'remote.git'), {
      '.factory/factory.yaml': `project: demo\nadapters: { scm: local-git, ci: none, tracker: none, sandbox: process, runtime: cli-agent }\n${runtimeYaml}\nstack: { image: unused, build: "true", test: "true" }\n`,
      '.factory/rules/style.md': 'Short.\n',
    });
    const checkout = join(root, 'checkout');
    await git(['clone', '--quiet', join(root, 'remote.git'), checkout]);
    writeFileSync(join(root, 'task.md'), '# Add a changelog\n\nCreate CHANGELOG.md.\n');
    return checkout;
  }

  function registry(made: string[], missing: string): Registry {
    const base = defaultRegistry();
    const scripted = () => new ScriptedAgentRuntime(() => [{ kind: 'message', text: 'ok' }]);
    return {
      ...base,
      runtime: {
        'cli-agent': () =>
          new AgentsByName({
            'claude-code': () => (made.push('claude-code'), scripted()),
            codex: () => {
              made.push('codex');
              throw new Error(missing);
            },
          }),
      },
    };
  }

  const submit = async (checkout: string, reg: Registry) => {
    let stderr = '';
    const code = await run(['submit', join(root!, 'task.md')], { cwd: checkout, env: { CRADLEWORKS_HOME: join(root!, 'home'), USER: 't' }, stdout: () => {}, stderr: (t) => (stderr += t), registry: reg });
    return { code, stderr };
  };

  it("reports a role's missing credential before any work starts", async () => {
    const made: string[] = [];
    const checkout = await project('runtime: { agent: claude-code, model: m, roles: { reviewer: { agent: codex, model: gpt-5-codex } } }');
    expect(await submit(checkout, registry(made, 'no OpenAI API key for the Codex runtime'))).toMatchObject({ code: 2, stderr: expect.stringMatching(/cannot set up runtime "cli-agent": no OpenAI API key/) });
    expect(made).toEqual(['claude-code', 'codex']);
  });

  it('never sets up an agent no role uses, and refuses an unknown one', async () => {
    const made: string[] = [];
    const checkout = await project('runtime: { agent: claude-code, model: m }');
    await submit(checkout, registry(made, 'unused'));
    expect(made).toEqual(['claude-code']);

    const other = await project('runtime: { agent: claude-code, model: m, roles: { tester: { agent: aider, model: x } } }');
    expect((await submit(other, registry([], 'unused'))).stderr).toMatch(/no agent "aider" \(known: claude-code, codex\)/);
  });
});

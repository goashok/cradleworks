// Runs every contract suite against the fakes: the harness itself is tested here,
// and the fakes are proven fit for end-to-end tests of the core.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunRequest, SandboxHandle } from '@cradleworks/interfaces';
import {
  describeAgentRuntimeContract,
  describeCIContract,
  describeSandboxContract,
  describeSourceControlContract,
  describeStateStoreContract,
} from './index.ts';
import {
  createBareRepo,
  FakeCI,
  InMemoryStateStore,
  LocalGitSourceControl,
  localRepoRef,
  ProcessSandbox,
  ScriptedAgentRuntime,
  type ScriptStep,
} from './fakes/index.ts';

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A bare remote with README.md on main, and a local clone of it. */
async function seededCheckout() {
  const root = temp('cw-fixture-');
  const bare = join(root, 'remote.git');
  await createBareRepo(bare, { 'README.md': '# Fixture\n' });
  const scm = new LocalGitSourceControl();
  const source = await scm.clone(localRepoRef(bare), join(root, 'source'));
  return { root, bare, scm, source };
}

describeSourceControlContract('local git fake', async () => {
  const root = temp('cw-scm-');
  const bare = join(root, 'remote.git');
  await createBareRepo(bare, { 'README.md': '# Fixture\n' });
  return {
    adapter: new LocalGitSourceControl(),
    repo: localRepoRef(bare),
    workDir: join(root, 'work'),
    missingPR: { id: `${bare}#999`, url: '' },
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});

describeSandboxContract('process fake', async () => {
  const { root, source } = await seededCheckout();
  return {
    adapter: new ProcessSandbox(join(root, 'sandboxes')),
    source,
    baseRef: 'main',
    image: 'unused-by-process-sandbox',
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});

describeAgentRuntimeContract('scripted fake', async () => {
  const { root, source } = await seededCheckout();
  const sandbox = new ProcessSandbox(join(root, 'sandboxes'));
  const opened: SandboxHandle[] = [];
  let n = 0;

  const script = (req: AgentRunRequest): ScriptStep[] =>
    req.input === 'write hello'
      ? [
          { kind: 'message', text: 'Writing the file.' },
          { kind: 'usage', inputTokens: 1200, outputTokens: 80, costUsd: 0.004 },
          { kind: 'tool', tool: 'write_file', input: { path: 'hello.txt' }, output: 'ok' },
          { kind: 'write', path: 'hello.txt', content: 'hi\n' },
          { kind: 'usage', inputTokens: 300, outputTokens: 20, costUsd: 0.001 },
          { kind: 'message', text: 'Done.' },
        ]
      : [{ kind: 'message', text: 'Thinking for a long time.' }, { kind: 'wait', ms: 60_000 }];

  return {
    runtime: new ScriptedAgentRuntime(script),
    profile: { role: 'implementer', agent: 'scripted', model: 'none' },
    newSandbox: async () => {
      const taskId = `agent-${++n}`;
      const handle = await sandbox.create({
        taskId,
        source,
        baseRef: 'main',
        branch: `factory/${taskId}`,
        image: 'unused',
        network: { mode: 'none', allow: [] },
      });
      opened.push(handle);
      return handle;
    },
    tasks: { writeFile: { input: 'write hello', path: 'hello.txt', content: 'hi\n' }, slow: { input: 'think forever' } },
    cleanup: async () => {
      for (const h of opened) await sandbox.destroy(h);
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describeStateStoreContract('in-memory fake', async () => ({ store: new InMemoryStateStore(), cleanup: async () => {} }));

describeCIContract('fake CI', async () => {
  const ci = new FakeCI();
  const repo = { id: 'owner/demo', url: 'https://ci.invalid/owner/demo' };
  ci.addRun(repo, 'a'.repeat(40), { state: 'passed', pendingPolls: 1, artifacts: { 'report.txt': 'all good' } });
  ci.addRun(repo, 'b'.repeat(40), { state: 'failed', jobs: [{ name: 'lint' }, { name: 'test', failed: true, log: 'running\nFAILED: expected 2 got 3' }] });
  return {
    adapter: ci,
    repo,
    passingSha: 'a'.repeat(40),
    failingSha: 'b'.repeat(40),
    failingJob: 'test',
    failureMarker: 'FAILED: expected 2 got 3',
    unbuiltSha: 'c'.repeat(40),
    waitSeconds: 5,
    artifact: { name: 'report.txt', containsText: 'all good' },
    cleanup: async () => undefined,
  };
});

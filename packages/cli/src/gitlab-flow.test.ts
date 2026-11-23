// The whole issue flow on GitLab: an issue on the GitLab stand-in goes through the spec gate
// to a merged merge request, with scripted agents. Checks the GitLab adapters fit the core
// together, not just one by one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitLab } from '@cradleworks/adapter-gitlab/fake';
import { GitLabIssuesTracker, GitLabSourceControl, gitlabRepoRef } from '@cradleworks/adapter-gitlab';
import { git, ScriptedAgentRuntime, type ScriptStep } from '@cradleworks/contracts/fakes';
import { afterEach, expect, it } from 'vitest';
import { defaultRegistry, run, type Registry } from './index.ts';

const YAML = `project: shop
adapters: { scm: gitlab, ci: none, tracker: gitlab-issues, sandbox: process, runtime: scripted }
runtime: { agent: scripted, model: none }
stack: { image: unused, build: "true", test: "true" }
gates: { spec_approval: human, plan_check: ai, change_approval: ai, auto_merge: true }
`;
const json = (v: unknown): ScriptStep => ({ kind: 'message', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });

let root: string | undefined;
let gl: FakeGitLab | undefined;
afterEach(() => {
  gl?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('takes a GitLab issue through the spec gate to a merged merge request', async () => {
  gl = new FakeGitLab();
  const lab = gl;
  lab.addProject('acme/shop');
  lab.pushCommit('acme/shop', 'main', '.factory/factory.yaml', YAML);
  const iid = lab.addIssue('acme/shop', { title: 'Add a changelog', description: 'We need a changelog.', labels: ['factory'] });
  root = mkdtempSync(join(tmpdir(), 'cw-gitlab-flow-'));
  const checkout = join(root, 'checkout');
  await git(['clone', '--quiet', `${lab.gitBase}/acme/shop.git`, checkout]);

  const token = async () => 'glpat-test';
  const options = { token, baseUrl: lab.baseUrl, gitBase: lab.gitBase, fetch: lab.fetch };
  const base = defaultRegistry();
  const registry: Registry = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      gitlab: {
        create: () => new GitLabSourceControl(options),
        repoFromRemote: (url) => (url.startsWith(lab.gitBase) ? gitlabRepoRef(url.slice(lab.gitBase.length + 1).replace(/\.git$/, ''), lab.baseUrl) : undefined),
      },
    },
    tracker: { 'gitlab-issues': { create: () => new GitLabIssuesTracker({ ...options, pollSeconds: 0.05 }), scm: ['gitlab'] } },
    runtime: {
      scripted: () =>
        new ScriptedAgentRuntime((req) => {
          switch (req.profile.role) {
            case 'specifier':
              return [json({ title: 'Add a changelog', problem: 'No changelog.', acceptance_criteria: ['CHANGELOG.md exists'], out_of_scope: [], assumptions: [] })];
            case 'planner':
              return [json({ tasks: [{ key: 't1', title: 'Write the changelog', description: 'Create CHANGELOG.md.', size: 'small', depends_on: [], criteria: [1] }] })];
            case 'tester':
              return [{ kind: 'message', text: 'Done.' }, { kind: 'write', path: 'changelog.acceptance.sh', content: 'test -f CHANGELOG.md\n' }];
            case 'reviewer':
              return [req.input.startsWith('# Spec check') || req.input.startsWith('# Plan check') ? json({ verdict: 'approved', reasons: [] }) : json({ verdict: 'pass', risk: 'low', reasons: [] })];
            default:
              return [{ kind: 'message', text: 'Added it.' }, { kind: 'write', path: 'CHANGELOG.md', content: '# Changelog\n' }];
          }
        }),
    },
  };
  const factory = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await run(args, { cwd: checkout, env: { CRADLEWORKS_HOME: join(root!, 'home'), USER: 'tester' }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), registry });
    return { code, stdout, stderr };
  };

  const first = await factory(['watch', '--once']);
  expect(first, first.stderr).toMatchObject({ code: 0 });
  expect(first.stdout).toContain(`#${iid} awaiting_spec_approval`);
  const wiId = /picked up as (wi_\S+)/.exec(first.stdout)![1]!;
  expect((await factory(['approve', wiId])).code).toBe(0);

  const second = await factory(['watch', '--once']);
  expect(second.stdout, second.stderr).toContain(`#${iid} merged`);

  // On the stand-in: the change is on main, through a merged merge request, and the issue
  // carries one status label and the factory's notes.
  const main = join(root, 'after');
  await git(['clone', '--quiet', `${lab.gitBase}/acme/shop.git`, main]);
  expect((await git(['-C', main, 'show', 'HEAD:CHANGELOG.md'])).stdout).toBe('# Changelog\n');
  const tracker = new GitLabIssuesTracker(options);
  const issue = await tracker.getItem({ id: `acme/shop#${iid}`, url: '' });
  expect(issue.labels.filter((l) => l.startsWith('factory:'))).toEqual(['factory:merged']);
  expect(issue.comments.some((c) => c.byFactory && /Merge request/.test(c.body))).toBe(true);
});

// Maps the adapter ids in factory.yaml to implementations. This is the one place that
// names vendors; the core only ever sees the interfaces.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeRuntime, resolveClaudeAuth } from '@cradleworks/adapter-claude-code';
import { CodexRuntime, resolveCodexAuth } from '@cradleworks/adapter-codex';
import { GitHubActionsCI, GitHubIssuesTracker, GitHubSourceControl, githubRepoRef } from '@cradleworks/adapter-github';
import { baseUrlFrom, GitLabCI, GitLabIssuesTracker, GitLabSourceControl, gitlabRepoFromRemote } from '@cradleworks/adapter-gitlab';
import { DockerSandbox } from '@cradleworks/adapter-local';
import { LocalGitSourceControl, localRepoRef, ProcessSandbox } from '@cradleworks/contracts/fakes';
import type { AgentRuntime, CI, RepoRef, Sandbox, SourceControl, Tracker } from '@cradleworks/interfaces';
import { AgentsByName } from './agents.ts';

export interface SourceControlEntry {
  create(): SourceControl;
  /** The repository behind a git remote URL, or undefined if this adapter does not serve it. */
  repoFromRemote(remoteUrl: string): RepoRef | undefined;
}

export interface Registry {
  sourceControl: Record<string, SourceControlEntry>;
  sandbox: Record<string, (factoryHome: string) => Sandbox>;
  /** Gets the sandbox the run will use, since an agent runs inside it. */
  runtime: Record<string, (context: { sandbox: Sandbox; env: Record<string, string | undefined> }) => AgentRuntime>;
  /** CI systems Verify can wait on. `none` (or any id missing here) means no CI. */
  ci: Record<string, { create: () => CI; /** Source control adapters whose repositories it builds. */ scm: string[] }>;
  /** Where `factory watch` takes requests from. The tracker project is the repository's id. */
  tracker: Record<string, { create: () => Tracker; /** Source control adapters whose repositories it tracks. */ scm: string[] }>;
  /** Sandboxes that do not isolate; the CLI warns when one is used. */
  testOnlySandboxes: ReadonlySet<string>;
}

const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export function defaultRegistry(): Registry {
  return {
    sourceControl: {
      github: {
        create: () => new GitHubSourceControl(),
        repoFromRemote: (url) => {
          const m = GITHUB_REMOTE.exec(url.trim());
          return m ? githubRepoRef(m[1]!, m[2]!) : undefined;
        },
      },
      // gitlab.com, or a self-managed instance at $CRADLEWORKS_GITLAB_URL.
      gitlab: {
        create: () => new GitLabSourceControl(),
        repoFromRemote: (url) => gitlabRepoFromRemote(url, baseUrlFrom({})),
      },
      'local-git': {
        create: () => new LocalGitSourceControl(),
        repoFromRemote: (url) => {
          const path = url.startsWith('file://') ? fileURLToPath(url) : url.startsWith('/') ? url : undefined;
          return path ? localRepoRef(resolve(path)) : undefined;
        },
      },
    },
    sandbox: {
      'local-docker': (home) => new DockerSandbox({ rootDir: resolve(home, 'sandboxes') }),
      process: (home) => new ProcessSandbox(resolve(home, 'sandboxes')),
    },
    runtime: {
      // runtime.agent (or runtime.roles.<role>.agent) picks the CLI agent per role.
      'cli-agent': ({ sandbox, env }) =>
        new AgentsByName({
          'claude-code': () => new ClaudeCodeRuntime({ sandbox, auth: resolveClaudeAuth({ env }) }),
          codex: () => new CodexRuntime({ sandbox, auth: resolveCodexAuth({ env }) }),
        }),
    },
    ci: {
      'github-actions': { create: () => new GitHubActionsCI(), scm: ['github'] },
      'gitlab-ci': { create: () => new GitLabCI(), scm: ['gitlab'] },
    },
    tracker: {
      'github-issues': { create: () => new GitHubIssuesTracker(), scm: ['github'] },
      'gitlab-issues': { create: () => new GitLabIssuesTracker(), scm: ['gitlab'] },
    },
    testOnlySandboxes: new Set(['process']),
  };
}

/** When an adapter id is known but not built yet, say which milestone brings it. */
export const PLANNED_ADAPTERS: Record<string, string> = {};

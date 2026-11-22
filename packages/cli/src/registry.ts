// Maps the adapter ids in factory.yaml to implementations. This is the one place that
// names vendors; the core only ever sees the interfaces.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeRuntime, resolveClaudeAuth } from '@cradleworks/adapter-claude-code';
import { GitHubSourceControl, githubRepoRef } from '@cradleworks/adapter-github';
import { DockerSandbox } from '@cradleworks/adapter-local';
import { LocalGitSourceControl, localRepoRef, ProcessSandbox } from '@cradleworks/contracts/fakes';
import type { AgentRuntime, RepoRef, Sandbox, SourceControl } from '@cradleworks/interfaces';

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
      'cli-agent': ({ sandbox, env }) => new ClaudeCodeRuntime({ sandbox, auth: resolveClaudeAuth({ env }) }),
    },
    testOnlySandboxes: new Set(['process']),
  };
}

/** When an adapter id is known but not built yet, say which milestone brings it. */
export const PLANNED_ADAPTERS: Record<string, string> = {
  'github-actions': 'M2 (CI adapter)',
  'github-issues': 'M3 (tracker adapter)',
};

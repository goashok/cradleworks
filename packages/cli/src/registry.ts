// Maps the adapter ids in factory.yaml to implementations. This is the one place that
// names vendors; the core only ever sees the interfaces.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubSourceControl, githubRepoRef } from '@cradleworks/adapter-github';
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
  runtime: Record<string, () => AgentRuntime>;
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
      process: (home) => new ProcessSandbox(resolve(home, 'sandboxes')),
    },
    runtime: {},
    testOnlySandboxes: new Set(['process']),
  };
}

/** When an adapter id is known but not built yet, say which milestone brings it. */
export const PLANNED_ADAPTERS: Record<string, string> = {
  'local-docker': 'M1-8 (local Docker sandbox)',
  'cli-agent': 'M1-9 (headless CLI agent runtime)',
  'claude-code': 'M1-9 (headless CLI agent runtime)',
  'github-actions': 'M2 (CI adapter)',
  'github-issues': 'M3 (tracker adapter)',
};

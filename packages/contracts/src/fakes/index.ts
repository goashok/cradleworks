// Working fakes of the adapter interfaces. Each passes its contract suite, so the core
// can be tested end to end on them without accounts, containers or a model.
export { createBareRepo, git } from './git.ts';
export { LocalGitSourceControl, localRepoRef } from './local-git-source-control.ts';
export { ProcessSandbox } from './process-sandbox.ts';
export { ScriptedAgentRuntime, type Script, type ScriptStep } from './scripted-agent-runtime.ts';
export { InMemoryStateStore } from './in-memory-state-store.ts';
export { FakeCI, type FakeRunSpec } from './fake-ci.ts';

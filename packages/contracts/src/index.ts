// Contract suites: every adapter runs the suite for its interface against a real
// instance. A new vendor adapter is done when its suite passes (Build spec, section 5).
export { expectAdapterError } from './assert.ts';
export { describeSourceControlContract, type ContractOptions, type SourceControlFixture } from './source-control.contract.ts';
export { describeSandboxContract, type SandboxFixture } from './sandbox.contract.ts';
export { describeAgentRuntimeContract, type AgentRuntimeFixture } from './agent-runtime.contract.ts';
export { describeStateStoreContract, type StateStoreFixture } from './state-store.contract.ts';
export { describeCIContract, type CIFixture } from './ci.contract.ts';

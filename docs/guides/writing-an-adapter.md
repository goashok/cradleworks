# Write an adapter

Every outside service Cradleworks uses (source control, sandboxes, agents, storage) sits behind an
interface. Supporting GitLab, a cloud sandbox or another coding agent means writing one adapter
package. The core doesn't change.

## The rules

1. **Implement an interface from `@cradleworks/interfaces`.** That's all the core knows about.
2. **Throw only `AdapterError`**, with a `code` (`not_found`, `conflict`, `invalid_input`,
   `unauthorized`, `rate_limited`, `unavailable`, `timeout`, …). The core decides whether to retry
   from the code and `retryable`, never from vendor error text.
3. **Pass the contract suite** from `@cradleworks/contracts` against a real instance. The adapter
   is done when its suite passes.
4. **Register it** in `packages/cli/src/registry.ts` under an id that projects can name in
   `factory.yaml`. This is the only file outside adapters that names vendors.

The core may never import an adapter, and `pnpm check:core-rule` fails CI if a vendor name shows
up in `packages/core`.

## The interfaces

| Interface | Methods | Contract suite |
| --- | --- | --- |
| `SourceControl` | `clone`, `createBranch`, `commit`, `push`, `openPR`, `getPRStatus`, `merge`, `comment` | `describeSourceControlContract` |
| `Sandbox` | `create`, `exec`, `spawn`, `copyIn`, `copyOut`, `setNetworkPolicy`, `destroy` | `describeSandboxContract` |
| `AgentRuntime` | `requiredHosts`, `start` → an `AgentRun` with `events`, `stop`, `getUsage` | `describeAgentRuntimeContract` |
| `StateStore` | append events, query, snapshot | `describeStateStoreContract` |
| `CI`, `Tracker`, `Notifier`, `ModelProvider`, `SpecStore` | defined; used from M2 on | coming with their first adapter |

Read the interface file itself for the exact types and guarantees. Each one is short and
documented, for example `packages/interfaces/src/sandbox.ts`.

### Agent runtimes: normalised events

An `AgentRuntime` turns whatever its agent prints into five event types:

| Event | Carries |
| --- | --- |
| `message` | text from the agent (role, text) |
| `tool_call` / `tool_result` | the tool, its input, its output, and whether it errored |
| `file_change` | a path added, modified, deleted or renamed |
| `usage` | running token counts and cost |
| `done` | the outcome (`succeeded`, `failed`, `stopped`, `timed_out`, `limit_reached`), total usage, and a summary |

The runtime must respect `limits.maxWallSeconds` and `limits.maxSpendUsd`, report the hosts it
needs in `requiredHosts()` so the sandbox can allow them, and keep credentials out of every event.
See `packages/adapter-claude-code` for a complete example: it maps Claude Code's `stream-json`
output and runs the agent inside the task's sandbox.

## Running a contract suite

A contract suite is a function you call from a Vitest file with a setup that returns a real
instance:

```ts
import { describeSandboxContract } from '@cradleworks/contracts';
import { MySandbox } from './index.ts';

describeSandboxContract('my sandbox', async () => {
  const { source, cleanup } = await makeScratchRepo();     // your fixture
  return {
    adapter: new MySandbox({ /* … */ }),
    source,
    baseRef: 'main',
    image: 'alpine:3.20',
    cleanup,
  };
});
```

Suites that need real accounts are opt-in, so `pnpm test` stays offline:

```sh
CRADLEWORKS_GITHUB_CONTRACT=1 pnpm test        # GitHub; uses a private scratch repo it creates
CRADLEWORKS_CLAUDE_CONTRACT=1 pnpm vitest run packages/adapter-claude-code   # Claude Code; Haiku, ≤ $0.25 a run
```

The Docker sandbox suite runs whenever Docker is available.

## Fakes for tests

`@cradleworks/contracts/fakes` has working adapters that pass the same suites, with no accounts,
containers or model:

- `LocalGitSourceControl`: bare repos on disk as the remote, PRs in a JSON file. It's also the
  `local-git` adapter used in the quick start.
- `ProcessSandbox`: runs commands as local processes. Tests only; it doesn't isolate.
- `ScriptedAgentRuntime`: plays back a scripted list of agent events.
- `InMemoryStateStore`

The orchestrator's own tests run the whole Build station on these fakes.

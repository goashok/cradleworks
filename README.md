# Cradleworks

A software factory for building with AI agents: a thin, vendor-neutral core that drives existing coding agents through adapters, from an issue to a reviewed, merged PR.

## Layout

```text
packages/
  core/         pipeline, state machine, domain model, policies (no vendor names)
  interfaces/   adapter interfaces and shared event types
  store-sqlite/ StateStore on SQLite (node:sqlite built-in, append-only event log)
  config/       loads .factory/factory.yaml over defaults/factory.yaml, with line-numbered errors
  contracts/    contract test suites every adapter must pass, and fakes that pass them
  adapter-github/  GitHub SourceControl (git over HTTPS + REST); signs in with GITHUB_TOKEN or the gh login
  adapter-local/   Sandbox: one git worktree + one Docker container per task (`local-docker`)
  adapter-claude-code/  AgentRuntime: Claude Code headless inside the sandbox (`runtime: cli-agent`, `agent: claude-code`)
  cli/          the `factory` command
defaults/
  factory.yaml  factory-wide defaults for any key a project omits
scripts/
  check-core-rule.ts   fails CI if the core names a vendor, stack or project
```

More packages (vendor adapters, orchestrator, CLI) arrive with milestone M1.

## Adding an adapter

Implement the interface from `@cradleworks/interfaces`, then run its suite from `@cradleworks/contracts` (`describeSourceControlContract`, `describeSandboxContract`, `describeAgentRuntimeContract`, `describeStateStoreContract`) against a real instance. The adapter is done when its suite passes. Contract suites against real services are opt-in, e.g. `CRADLEWORKS_GITHUB_CONTRACT=1 pnpm test` (uses a private `cradleworks-contract-scratch` repo on the signed-in account, created on first run). `@cradleworks/contracts/fakes` has working fakes for tests that need an adapter without accounts, containers or a model.

## Develop

Requires Node 22.18+ (CI uses the version in `.nvmrc`) and pnpm (pinned in `package.json`; run `npx pnpm@12.18.0` if it is not installed).

```sh
pnpm install
pnpm check   # core rule, typecheck, tests
```

## Use

```sh
# inside a repository with .factory/factory.yaml
factory submit task.md        # task.md starts with "# Title"; builds it and opens a PR
factory status                # list work items
factory status <work-item-id> # tasks, PRs, runs and gate decisions
factory validate [<dir>]      # check a project's .factory/ setup without running anything
```

Until the package is installed globally, run it as `packages/cli/src/main.ts`. State lives in `~/.cradleworks` (override with `CRADLEWORKS_HOME`).

## Claude Code credentials

The agent runs inside the task's sandbox, so the sandbox image (`stack.image`) needs a `claude` command and git; `packages/adapter-claude-code/image/Dockerfile` is a minimal example. Two ways to sign in:

- **API key** (billed to the API account): `ANTHROPIC_API_KEY`, or the macOS Keychain:
  `security add-generic-password -s cradleworks-anthropic-api-key -a "$USER" -w`
- **Subscription**: run `claude setup-token`, then `CLAUDE_CODE_OAUTH_TOKEN`, or the Keychain:
  `security add-generic-password -s cradleworks-claude-oauth-token -a "$USER" -w`

With both present the API key is used; `CRADLEWORKS_CLAUDE_AUTH=subscription` picks the subscription. The model API host is added to the sandbox's network allow-list for the run; nothing else is opened. The live contract test is opt-in: `CRADLEWORKS_CLAUDE_CONTRACT=1 pnpm vitest run packages/adapter-claude-code` (Haiku, each run capped at $0.25).

## Sandbox network

`sandbox.network` in `.factory/factory.yaml` is enforced by a per-sandbox egress proxy: the sandbox sits on an internal Docker network with no route out, and the proxy lets through only listed hosts (`host`, `host:port`, or `*.domain`; no port means 80 and 443). Names that resolve to private or loopback addresses are refused. Tools find the proxy through the usual `HTTP(S)_PROXY` variables and `JAVA_TOOL_OPTIONS`.

## The core rule

Nothing in `packages/core` may name a vendor, stack or project, and the core may import only `@cradleworks/interfaces`, Node built-ins and its own files. `pnpm check:core-rule` enforces this.

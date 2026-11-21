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

## The core rule

Nothing in `packages/core` may name a vendor, stack or project, and the core may import only `@cradleworks/interfaces`, Node built-ins and its own files. `pnpm check:core-rule` enforces this.

# Cradleworks

A software factory for building with AI agents: a thin, vendor-neutral core that drives existing coding agents through adapters, from an issue to a reviewed, merged PR.

## Layout

```text
packages/
  core/         pipeline, state machine, domain model, policies (no vendor names)
  interfaces/   adapter interfaces and shared event types
scripts/
  check-core-rule.ts   fails CI if the core names a vendor, stack or project
```

More packages (contracts, adapters, store, CLI) arrive with milestone M1.

## Develop

Requires Node 22.18+ (CI uses the version in `.nvmrc`) and pnpm (pinned in `package.json`; run `npx pnpm@12.18.0` if it is not installed).

```sh
pnpm install
pnpm check   # core rule, typecheck, tests
```

## The core rule

Nothing in `packages/core` may name a vendor, stack or project, and the core may import only `@cradleworks/interfaces`, Node built-ins and its own files. `pnpm check:core-rule` enforces this.

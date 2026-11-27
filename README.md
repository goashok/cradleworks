# Cradleworks

**Cradleworks is a software factory.** You hand it a GitHub issue or a written task. It writes a
spec, splits the work into tasks, runs a coding agent on each task in a locked-down sandbox,
checks the result, and hands you back pull requests. Every step the agents took is recorded, so
you can replay exactly what they did.

```console
$ factory submit tasks/farewell.md
Submitted "Add a farewell function" as wi_5eb83867-…
Building task_6dca1aa4-…...
Opened https://github.com/you/your-repo/pull/12
  branch factory/task-6dca1aa4
  run    run_d4d34200-…
```

Cradleworks does not write code itself. It drives the coding agents that already exist (Claude Code
today), and it adds what one person typing into one chat window lacks: the same setup every
time, isolation, a record of every step, limits on spend, and a pipeline that can grow gates and
checks around the agent.

## Why

Coding agents can now finish real tasks, but most teams still use them one chat at a time. What
comes out depends on who asked, what they pasted in and how carefully they read the result. That
doesn't scale to many people or many tasks at once. Cradleworks makes those parts of the work
shared and repeatable:

| Instead of… | Cradleworks gives you… |
| --- | --- |
| Context pasted by hand | Project rules in the repo (`.factory/rules/`), loaded into every run |
| An agent running on your laptop with your credentials | A fresh container per task. It can reach only the hosts you list, and it never sees your GitHub credentials. |
| "Trust me, it works" | A pull request, plus an event log of every tool call, file change and decision |
| Unknown cost | A spend cap per task, and token and dollar usage recorded on every run |
| One vendor baked in | Every outside service behind an interface. GitHub and Claude Code are adapters, not assumptions. |

## What it does today

Cradleworks is early. This is the honest picture:

- ✅ **Task → pull request.** `factory submit` turns a Markdown task into a branch, a commit and a PR.
  It works on GitHub, or on a plain git repo on disk for trying it out.
- ✅ **Isolated runs.** Each task gets its own git worktree and Docker container. All
  capabilities are dropped, and outbound network goes through an allow-list proxy.
- ✅ **Checked before you see it.** A Verify step runs the project's build and tests in a fresh
  sandbox, waits for CI, and asks a second agent to review the diff. Failures go back to the agent
  with the reasons, and the fix lands on the same PR. The evidence is posted on the PR.
- ✅ **A real change gate.** A task that passes waits for `factory approve` (or an approving
  review on the PR). The factory merges only the exact commit it verified.
- ✅ **Issues to merged PRs.** `factory watch` picks up issues labelled `factory`. A spec agent
  writes acceptance criteria (asking first if it must), and you `/approve` the spec on the issue.
  A planner splits it into tasks, which build in parallel and merge in dependency order. A tester
  agent writes acceptance tests from the spec for Verify to run ([guide](docs/guides/issues.md)).
- ✅ **Full record.** Every step goes to an append-only event log. `factory log <run>` replays it.
- ✅ **Per-project setup.** One `.factory/` folder describes a project: image, commands, rules and
  limits. `factory validate` checks it.
- ✅ **Measured.** It has been run against a private suite of 30 graded tasks on two reference
  projects. The first baseline passed 26 of 29, for $2.27 in total ([results](docs/guides/evaluating.md)).
- 🚧 **Not yet:** per-user budgets and scoped tokens (M4), the eval running on every change and a
  learning loop (M5), and a web console (M6). See the [roadmap](docs/roadmap.md).

## How it works, in one picture

```text
 task.md ──► factory submit
               │
               ▼
        ┌─────────────────── Build station ────────────────────┐
        │ 1. clone the repo                                    │
        │ 2. start a sandbox (worktree + Docker, network       │
        │    limited to the allow-list)                        │
        │ 3. load the project rules (.factory/rules/*.md)      │
        │ 4. run the agent inside the sandbox, with limits     │
        │ 5. commit, push the branch, open the pull request    │
        └──────────────────────────────────────────────────────┘
               │                                ▲
               ▼                                │ rework, with the reasons
        ┌─ Verify (fresh sandbox) ───────────────┴─────────────┐
        │ build + lint + tests · CI on the commit · reviewer   │
        │ agent → pass / rework / escalate, evidence on the PR │
        └──────────────────────────────────────────────────────┘
               │ pass
               ▼
         change gate: factory approve [--merge]   event log (~/.cradleworks)
                                                  factory status / factory log
```

The longer version is in [How it works](docs/how-it-works.md).

## Try it

The [quick start](docs/quickstart.md) runs the factory on a tiny example project in about ten
minutes. You need Node 22.18+, Docker, git and a Claude credential. No GitHub account is
needed.

```sh
git clone https://github.com/goashok/cradleworks && cd cradleworks
npx pnpm@12.18.0 install
alias factory="node $PWD/packages/cli/src/main.ts"
```

## Documentation

**Start here**
- [Quick start](docs/quickstart.md): your first factory run, end to end
- [How it works](docs/how-it-works.md): work items, tasks, runs, stations, the event log and adapters
- [Get help as you go](docs/guides/getting-help.md): `factory docs`, `factory config explain`, and a skill for your coding assistant

**Guides**
- [Add your own project](docs/guides/add-a-project.md): write a `.factory/` folder (rules, prompt additions, skills) and switch to GitHub
- [Make it your team's](docs/guides/customizing.md): which of rules, prompt additions, skills, agent checks and drill cases to use for what
- [Write good tasks](docs/guides/writing-tasks.md): what to put in a task file, and what the agent sees
- [From an issue to merged PRs](docs/guides/issues.md): `factory watch`, the spec and plan gates, parallel tasks, the tester
- [Verify, rework and approve](docs/guides/verify-and-approve.md): what's checked, the evidence,
  the change gate, agent checks and drilling them, and what to do when a task escalates
- [Follow and replay runs](docs/guides/runs-and-logs.md): `status`, `log`, and where state lives
- [Sandbox and credentials](docs/guides/security.md): what the agent can and cannot reach
- [GitHub App tokens](docs/guides/github-app.md): short-lived, repo-scoped tokens instead of yours
- [Measure your own factory](docs/guides/measuring.md): an eval suite on your code, config variants, the noise band, `factory stats`
- [How Cradleworks is measured](docs/guides/evaluating.md): its own eval suite and baselines
- [Write an adapter](docs/guides/writing-an-adapter.md): plug in another SCM, sandbox or agent
- [Releasing the factory](docs/guides/releasing.md): the package on each GitHub release, `cradleworks/hosting`, and depending on it

**Reference**
- [Configuration](docs/reference/configuration.md): every `factory.yaml` key, and which ones take effect today
- [CLI](docs/reference/cli.md): every command, option and exit code
- [Roadmap](docs/roadmap.md): milestones, what's done and what's next

## Develop

```sh
npx pnpm@12.18.0 install
pnpm check      # core rule, typecheck, all tests
```

The repository is a pnpm workspace of small packages:

```text
packages/
  core/                 pipeline, state machine, domain model; names no vendor
  interfaces/           the adapter interfaces and the normalised agent events
  contracts/            contract test suites every adapter must pass, plus working fakes
  config/               loads .factory/factory.yaml over defaults/factory.yaml
  store-sqlite/         StateStore: append-only event log on SQLite
  store-postgres/       StateStore on PostgreSQL, for a factory run as a service
  adapter-github/       SourceControl for GitHub
  adapter-local/        Sandbox: git worktree + Docker container + egress proxy
  adapter-claude-code/  AgentRuntime: Claude Code, headless, inside the sandbox
  runner/               one pass over a project's issues; `factory watch` runs it on a timer
  cli/                  the `factory` command
defaults/factory.yaml   defaults for any key a project leaves out
examples/hello-node/    the quick start project
```

**The core rule:** nothing in `packages/core` may name a vendor, stack or project, and the core
imports only `@cradleworks/interfaces`, Node built-ins and its own files. That's what keeps
GitHub, Docker and Claude Code replaceable. `pnpm check:core-rule` enforces it in CI.

## License

[MIT](LICENSE)

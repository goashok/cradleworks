# Cradleworks

[![CI](https://github.com/goashok/cradleworks/actions/workflows/ci.yml/badge.svg)](https://github.com/goashok/cradleworks/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/goashok/cradleworks)](https://github.com/goashok/cradleworks/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

**A software factory for coding agents.** Label a GitHub or GitLab issue, and Cradleworks takes it
from there: it writes a spec for you to approve, plans the work as small tasks, builds each one
with a coding agent in a locked-down sandbox, verifies the result with your own tests and a
reviewer agent, and stops at a gate until a person approves the merge. Every step is recorded, so
you can replay exactly what an agent did and why.

```console
$ factory submit tasks/farewell.md
Submitted "Add a farewell function" as wi_5eb83867-…
Building task_6dca1aa4-…...
Opened https://github.com/you/your-repo/pull/12
  branch factory/task-6dca1aa4
  run    run_d4d34200-…
Verifying...
  checks: build ✓, test ✓   CI: passed   reviewer: pass (low risk)
Passed: checks passed, CI passed, reviewer passed (low risk)
Ready for review: https://github.com/you/your-repo/pull/12
  approve with  factory approve task_6dca1aa4-… [--merge]
  or send back  factory reject task_6dca1aa4-… --reason "..."
```

Cradleworks doesn't replace your coding agent. It runs the agents you already use (Claude Code or
the Codex CLI) and adds what a single chat session can't give a team: the same setup on every
run, isolation, hard limits on spend and access, independent checks, and a complete record.

## Hosted for your team: Cradleworks Cloud

[**cradleworks.dev**](https://www.cradleworks.dev) is the hosted version of Cradleworks. It runs
the same released factory as this repository, so nothing needs to run on anyone's laptop.
Your team signs in with GitHub, labels issues, and approves specs and changes in a shared web
console that shows every agent at work, what it costs, and what waits on a person.

Each partner gets a **completely isolated environment** of its own: its own service, its own
database, its own sandboxes for the agents, its own GitHub App with access only to the
repositories you choose, and its own keys. Nothing is shared with another customer: no
infrastructure, no data and no credentials.

Prefer to run it yourself? Everything below is the open-source factory, and works on its own.

## Why Cradleworks

Coding agents can now finish real tasks, but most teams still use them one chat at a time. The
result depends on who asked, what they pasted in, and how carefully they read the output. That
doesn't scale to many people or many tasks at once. Cradleworks makes those parts of the work
shared and repeatable.

| Instead of… | Cradleworks gives you… |
| --- | --- |
| Context pasted by hand | Project rules, prompt additions and skills in the repo (`.factory/`), loaded into every run |
| An agent on your laptop, with your credentials | A fresh container per task. It reaches only the hosts you allow, and never sees your Git or model credentials. |
| "Trust me, it works" | A pull request with evidence: build, tests, CI, acceptance tests and a review, plus an event log of every tool call and file change |
| A merge on someone's say-so | Gates for the spec, the plan and the change. By default a person approves each one, and the factory merges only the exact commit it verified. |
| Unknown cost | Spend caps per task and per requester, with token and dollar usage recorded on every run |
| One vendor baked in | Every outside service behind an interface. GitHub, GitLab, Docker, Claude Code and Codex are adapters, not assumptions. |

## Features

**From an issue to merged pull requests**
- `factory watch` picks up issues labelled `factory` and reports progress on the issue.
- A **spec agent** writes acceptance criteria, asking on the issue first if something is unclear,
  and you approve the spec with `/approve`.
- A **planner** splits the spec into small tasks with dependencies. Independent tasks build in
  parallel; dependent ones start after their dependencies merge.
- Or skip the issue: `factory submit task.md` builds a hand-written task.

**Checked before you see it**
- **Verify** runs the project's build, lint and tests in a fresh sandbox and waits for CI on the
  pushed commit.
- A **tester agent** writes acceptance tests from the spec without seeing the change.
- A **reviewer agent** reads the diff against the spec and rates its risk. It can't edit files.
- Failures go back to the coding agent with the reasons, and the fix lands on the same pull
  request. The evidence is posted on the pull request.

**Safe by default**
- One git worktree and one container per task, with every Linux capability dropped and outbound
  traffic through an allow-list proxy.
- The model credential stays outside the sandbox. A gateway adds it to the agent's requests.
- Short-lived, repository-scoped [GitHub App tokens](docs/guides/github-app.md), if you set one up.
- Hard rules that no configuration turns off. The factory pushes only to `factory/*` branches.
  Changes to CI config, `.factory/` or `CODEOWNERS` always wait for a person. A secret scan runs
  before every push.
- Commands the agent may not run, and every network decision in the run log.

**Under your control**
- Spend caps per task, and daily and monthly caps per requester. At a cap, the work pauses; it
  doesn't fail. `factory budget` shows the spend.
- Each gate can be `human` (the default), `ai` or `skip`.
- Pick the agent and the model per role, for example Codex reviewing what Claude Code built.
- `factory console`: a local web page of the work, what waits on you, spend and run logs, with
  buttons to approve, send back, retry, extend a budget or cancel.

**Easy to adopt**
- `factory init` writes the `.factory/` folder for a repository, then builds its image and
  checks that its build and tests pass inside it.
- `factory docs` and `factory config explain` answer questions at the terminal, from the docs of
  the version you run. A [skill](docs/guides/getting-help.md) lets your coding assistant do the same.
- `factory skills` pins agent skills from other repositories into your project.

**Measurable**
- `factory log` replays any run from its append-only event log.
- `factory stats` shows gates, send-backs, rework, cost and time per merged change.
- `factory eval` measures the factory on your own code, and `factory eval mine` builds a suite of
  tasks from your merge history. `factory drill` checks that the reviewer still catches known-bad
  changes.

## How it works

```text
 issue labelled "factory"            task.md
          │                             │
          ▼                             │ factory submit
   Specify ─► spec gate (/approve)      │
          ▼                             │
   Plan ──► plan check                  │
          │  tasks, run in parallel     │
          ▼                             ▼
   ┌──────────────────────── Build ──────────────────────┐
   │ fresh sandbox (worktree + container, allow-listed   │
   │ network) · project rules loaded · agent runs with   │
   │ limits · secret scan · commit, push, pull request   │
   └─────────────────────────────────────────────────────┘
          │                              ▲
          ▼                              │ rework, with the reasons
   ┌─ Verify (fresh sandbox) ────────────┴───────────────┐
   │ build · lint · tests · CI · acceptance tests ·      │
   │ reviewer agent → pass / rework / escalate           │
   └─────────────────────────────────────────────────────┘
          │ pass
          ▼
   change gate (a person, by default) ─► merge

   Every step is an event in an append-only log: factory status, factory log
```

The [core](packages/core) names no vendor. Source control, CI, issue tracking, sandboxes, agents
and the event store are interfaces, each with adapters, and contract tests every adapter must
pass. See [How it works](docs/how-it-works.md).

| Interface | Adapters today |
| --- | --- |
| Source control | GitHub, GitLab, a plain git repository on disk |
| CI | GitHub Actions, GitLab CI |
| Issue tracker | GitHub Issues, GitLab issues |
| Coding agent | Claude Code, Codex CLI |
| Sandbox | Git worktree + Docker container + egress proxy |
| Event store | SQLite (one machine), PostgreSQL (a service) |

## Results

Cradleworks is measured on a suite of 30 graded tasks across two reference projects. Hidden tests
the agents never see decide each result. A run takes each task the whole way: issue, spec, plan,
build, verify and merge.

- The latest full run passed **25 of 30**, with every merged change clean (no whitespace churn,
  stray lockfile changes or duplicated tests). The tester fix behind that score is in
  [How Cradleworks is measured](docs/guides/evaluating.md).
- Before that fix, the same factory scored 19 to 21 from run to run. A change only counts as a
  real improvement when its score falls outside the range a factory reaches by chance.
- A **reviewer drill** checks the reviewer directly, with known-wrong changes it must send back
  and correct ones it must pass.

[How Cradleworks is measured](docs/guides/evaluating.md) covers the method and the results.

## Get started

You need Node 22.18 or later, git, Docker, and a Claude credential (or an OpenAI key for Codex). The
[quick start](docs/quickstart.md) runs the factory on a small example project in about ten
minutes, with a git repository on your disk standing in for GitHub.

```sh
git clone https://github.com/goashok/cradleworks && cd cradleworks
npx pnpm@12.18.0 install
alias factory="node $PWD/packages/cli/src/main.ts"
factory help
```

Each release is also published as an installable package, for use on your own repositories. See
[Install a release](docs/quickstart.md#1-install-cradleworks).

## Status

Cradleworks is pre-1.0 (currently 0.1.x). The pipeline above runs end to end on GitHub, and
GitLab is supported through the same interfaces. Changes to the factory are checked against the
evaluation suite before they ship. Configuration keys and commands may still change between
minor versions.

Before you point it at something sensitive, read
[what the sandbox does not protect against yet](docs/guides/security.md#what-this-does-not-protect-against-yet).
In short: containers are not VMs, and you should keep branch protection and the human change gate
on. See the [roadmap](docs/roadmap.md) for what's done and what's next, including a shared console
with sign-in for teams.

## Documentation

**Start here**
- [Quick start](docs/quickstart.md): your first factory run, end to end
- [How it works](docs/how-it-works.md): work items, tasks, runs, stations, the event log and adapters
- [Get help as you go](docs/guides/getting-help.md): `factory docs`, `factory config explain`, and a skill for your coding assistant

**Guides**
- [Add your own project](docs/guides/add-a-project.md): `factory init`, or write `.factory/` by hand (rules, prompt additions, skills), and switch to GitHub
- [Make it your team's](docs/guides/customizing.md): which of rules, prompt additions, skills, agent checks and drill cases to use for what
- [Write good tasks](docs/guides/writing-tasks.md): what to put in a task file, and what the agent sees
- [From an issue to merged PRs](docs/guides/issues.md): `factory watch`, the spec and plan gates, parallel tasks, the tester
- [Verify, rework and approve](docs/guides/verify-and-approve.md): what's checked, the evidence, the change gate, agent checks and drills, and what to do when a task escalates
- [Follow and replay runs](docs/guides/runs-and-logs.md): `status`, `log`, the console, and where state lives
- [Sandbox and credentials](docs/guides/security.md): what the agent can and cannot reach
- [GitHub App tokens](docs/guides/github-app.md): short-lived, repo-scoped tokens instead of yours
- [Measure your own factory](docs/guides/measuring.md): an eval suite on your code, config variants, the noise band, `factory stats`
- [How Cradleworks is measured](docs/guides/evaluating.md): its own eval suite, the method and the results
- [Write an adapter](docs/guides/writing-an-adapter.md): plug in another source control, sandbox or agent

**Reference**
- [Configuration](docs/reference/configuration.md): every `factory.yaml` key, and which ones take effect today
- [CLI](docs/reference/cli.md): every command, option and exit code
- [Roadmap](docs/roadmap.md): milestones, what's done and what's next

## Develop

```sh
npx pnpm@12.18.0 install
pnpm check                                  # core rule, typecheck, all tests
pnpm build:package && pnpm check:package    # the installable package, and a check of it installed
```

CI runs `pnpm check` on every push to `main`. Pushing a tag `v<version>` (the version in
`package.json`) runs the Release workflow. It runs the checks, builds
`cradleworks-<version>.tgz`, installs it in an empty project to test it, and attaches it to the
GitHub release. Release steps are in [For maintainers](docs/maintainers/README.md).

The repository is a pnpm workspace of small packages:

```text
packages/
  core/                 pipeline, state machine, domain model; names no vendor
  interfaces/           the adapter interfaces and the normalised agent events
  contracts/            contract test suites every adapter must pass, plus working fakes
  config/               loads .factory/factory.yaml over defaults/factory.yaml
  store-sqlite/         event store on SQLite
  store-postgres/       event store on PostgreSQL, for a factory run as a service
  adapter-github/       GitHub: pull requests, Actions, issues
  adapter-gitlab/       GitLab: merge requests, CI pipelines, issues
  adapter-local/        sandbox: git worktree + Docker container + egress proxy
  adapter-claude-code/  coding agent: Claude Code, headless, inside the sandbox
  adapter-codex/        coding agent: the Codex CLI, headless, inside the sandbox
  runner/               one pass over a project's issues; `factory watch` runs it on a timer
  cli/                  the `factory` command and the local console
defaults/factory.yaml   defaults for any key a project leaves out
examples/hello-node/    the quick start project
skills/cradleworks/     the skill for your coding assistant
```

**The core rule:** nothing in `packages/core` may name a vendor, stack or project, and the core
imports only `@cradleworks/interfaces`, Node built-ins and its own files. That's what keeps every
vendor replaceable. `pnpm check:core-rule` enforces it in CI.

## Contributing

Cradleworks is open source but doesn't take outside pull requests. Bug reports and ideas are
welcome as issues, and security problems can be reported privately. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE). Versions up to and including 0.1.1 were
released under the MIT License.

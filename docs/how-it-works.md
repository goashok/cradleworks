# How it works

This page explains the ideas behind Cradleworks: what the factory is meant to become, which part of
it runs today, and the few concepts you need to read its output.

## The idea: a pipeline around the agents

A coding agent is good at doing a task. Cradleworks is everything around the task: where the
request comes from, what the agent is told, where it runs, what it may touch, how its work is
checked, who approves it, and what's learned when it goes wrong.

The full design is a pipeline of eight **stations**. People set direction and approve at two
**gates**. Agents do the work in between.

| # | Station | Who | In → out | Today |
| --- | --- | --- | --- | --- |
| 1 | Intake | adapter | issue or CLI request → work item | ✅ CLI (`factory submit`) · ✅ GitHub Issues (`factory watch`, M3) |
| 2 | Specify | spec agent + requester | work item → spec with acceptance criteria | ✅ **M3**: one round of questions at most. A task file is its own spec. |
| 3 | Approve spec | **human gate** | spec → approved spec | ✅ **M3**: `/approve` on the issue. Recorded as skipped for hand-written tasks. |
| 4 | Plan | planner agent | spec → tasks with dependencies | ✅ **M3**: up to 8 tasks, checked, then run in parallel in dependency order |
| 5 | **Build** | implementer agent | task → branch + pull request | ✅ **M1** |
| 6 | **Verify** | checks + CI + reviewer agent + tester agent | PR → evidence, or back to Build | ✅ **M2** · tester (M3) |
| 7 | **Approve change** | **human gate** | PR + evidence → approved PR | ✅ **M2** |
| 8 | Merge and learn | adapter + learning loop | approved PR → merged; failures → rules | ✅ merge (M2) · 🚧 learning (M5) |

The first version (milestone M1, the "walking skeleton") builds the spine all eight stations hang
on: the state machine, the event log, the adapters, the sandbox and the CLI. It also builds one
complete station, **Build**, which is the one that writes the code. M2 added **Verify**, the
rework loop and the **change gate**, so a task now goes from the task file to a merged commit
([guide](guides/verify-and-approve.md)). M3 added the front of the line. An issue becomes a
spec, a plan and several tasks that run in parallel and merge in order
([guide](guides/issues.md)). Each milestone adds stations without changing what's already
there. See the [roadmap](roadmap.md).

## The things you'll see in the output

```text
work item  wi_…     one request ("Add a farewell function"); has tasks
  task     task_…   one unit of change; becomes one branch and one pull request
    run    run_…    one attempt by one station at one task; has its own event log
```

- A **work item** is one request from one person. It moves through states such as
  `received → specifying → … → in_progress → awaiting_change_approval → merged`, or ends `failed`
  or `cancelled`.
- A **task** is one change with **one PR**. A work item from an issue is planned into one or more
  tasks with dependencies. A task starts once the tasks it depends on have merged. A hand-written
  task submitted with `factory submit` is a work item with exactly one task.
- A **run** is one execution of a station. A task that's reworked twice has five runs: build,
  verify, build, verify, build… A retry is a new run, so nothing is overwritten.
- A task moves `queued → building → verifying → ready → approved → merged`. Verify can send it
  to `rework` (and back to building), and it can end `escalated` when it needs a person.

## The event log is the source of truth

Cradleworks never stores "the current state" as a mutable record. Every decision and every step is
an **event** appended to a log (SQLite, in `~/.cradleworks/state.db`):

- The work item's stream holds the business events: `work_item_received`, `tasks_planned`,
  `gate_decided`, `run_started`, `task_pr_opened`, `task_failed`, and so on.
- Each run's stream holds the steps: `checkout_cloned`, `sandbox_created`, `context_pack_built`,
  every agent `tool_call`, `tool_result`, `file_change` and `usage` event, then `changes_committed`,
  `branch_pushed`, `pr_opened` and `sandbox_destroyed`.

The current state of a work item is computed by replaying its events through a pure state machine,
which rejects illegal transitions. That gives you three things:

1. **Replay.** `factory log <run>` reconstructs the whole run from the log alone, long after the
   sandbox and checkout are gone.
2. **Audit.** Gate decisions record who decided, how (human, AI or skipped) and why.
3. **Measurement.** Token counts and cost are recorded on every run from day one, so budgets and
   reports have data to work from.

## What happens during a Build run

```text
factory submit task.md
  │
  ├─ record work item + one task (spec and plan gates recorded as "skipped": you wrote the spec)
  │
  └─ Build station
       1. clone        fresh checkout of the base branch (default main)
       2. sandbox      git worktree on branch factory/task-xxxxxxxx, bind-mounted into a new
                       Docker container from stack.image; network only via the allow-list proxy
       3. context      .factory/rules/*.md matched and size-budgeted (256 KB); the list is logged
       4. agent        Claude Code runs headless inside the container with:
                         - a role prompt: "implement this task and only this; follow the rules;
                           run the build and tests before you finish; don't commit"
                         - the project's commands from stack (build, test, lint, …)
                         - your task text
                         - limits: 30 minutes wall time, budgets.per_task_usd spend
       5. commit       the factory, not the agent, commits on the host
       6. push         branch factory/task-xxxxxxxx
       7. pr           title = task title; body = task, agent summary, ids, context files
       ─ sandbox and checkout destroyed, whatever happened
```

If any step fails, the run records `step_failed` with the reason and the task ends `failed`. If
the agent finishes without changing anything, the run fails at `commit` with "the agent finished
without changing any files". Its summary, which says why, is still in the log.

## Adapters: why nothing is hard-wired

The core (`packages/core`) talks to the outside world only through interfaces
(`packages/interfaces`). Each vendor is an **adapter**, and a project picks its adapters by id in
`.factory/factory.yaml`.

| Interface | What it does | Built | Planned next |
| --- | --- | --- | --- |
| `SourceControl` | clone, branch, commit, push, open/read/merge PRs | `github`, `gitlab`, `local-git` | Bitbucket |
| `Sandbox` | create an isolated workspace, run commands, network policy, destroy | `local-docker` (`process` for tests only) | Docker Sandboxes (microVMs), AWS Fargate, Kubernetes |
| `AgentRuntime` | start an agent, stream normalised events, stop, report usage | `cli-agent` (Claude Code, Codex CLI; chosen per role) | Agent SDK |
| `StateStore` | append events, query, snapshot | SQLite | Postgres |
| `CI` | find runs for a commit, status, logs, artifacts | GitHub Actions, GitLab CI | |
| `Tracker` | list and watch issues, comment, set status, check who may approve | `github-issues`, `gitlab-issues` | Jira, Linear |
| `Notifier` | tell a person a gate is waiting | interface only | GitHub comments, Slack |
| `ModelProvider` | direct model calls for the core's own agents | interface only | direct API, Bedrock, gateways |
| `SpecStore` | every version of every spec | factory store (approved specs also go to `.factory/specs/` in the PR) | |

Every agent runtime maps its output onto the same five normalised events: `tool_call`,
`file_change`, `message`, `usage` and `done`. That's why the log and the cost accounting look the
same whichever agent ran.

Every adapter has a **contract test suite** in `packages/contracts`. An adapter is done when its
suite passes against the real service. See [Write an adapter](guides/writing-an-adapter.md).

## Where project knowledge lives

Everything specific to a project lives in that project's repo, in `.factory/`, and is reviewed
like code:

- `factory.yaml`: the image, commands, rules to load, gates, limits, adapters, and which skills
  and agent checks each role gets
- `rules/*.md`: conventions, constraints and "never do X" notes, loaded into every run
- `prompts/<role>.md`: how one role (say, the reviewer) should work differently on this codebase
- `skills/<name>/` and `skills.lock`: instructions for one kind of work, vendored and pinned
- `drill/`: changes with a known verdict, which show that a check still catches what it should
- `specs/`: the approved specs, committed with the work they asked for
- `image/Dockerfile` (by convention): the sandbox image

Agents read all of it from the base branch, so a change takes effect once it's merged, and a
person must approve any change to it. Onboarding a new stack, or teaching the factory how your
team works, means writing this folder. It never means changing the factory. See
[Make it your team's](guides/customizing.md).

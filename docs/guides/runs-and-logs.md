# Follow and replay runs

Everything the factory does is written to its event log. This guide shows how to read the log, and
how to tell what happened when a run fails.

## Submitting

```sh
factory submit task.md                  # PR against main
factory submit task.md --base develop   # PR against another branch
```

`submit` runs in the foreground and prints the PR link, branch and run id when it finishes:

```text
Submitted "Add a farewell function" as wi_5eb83867-…
Building task_6dca1aa4-…...
Opened https://github.com/you/repo/pull/12
  branch factory/task-6dca1aa4
  run    run_d4d34200-…
```

If the build fails, it prints the failing step and the run id, and exits with code 1:

```text
Build failed: commit: the agent finished without changing any files
  run run_372e68f9-…
```

## Status: where is everything?

```console
$ factory status
WORK ITEM                                STATE        TASKS  PROJECT     TITLE
wi_5eb83867-b216-4ed4-ae28-57e85860a243  awaiting_change_approval  0/1    hello-node  Add a farewell function

$ factory status wi_5eb83867-b216-4ed4-ae28-57e85860a243
wi_5eb83867-b216-4ed4-ae28-57e85860a243  awaiting_change_approval
  title      Add a farewell function
  project    hello-node
  requester  you
  …
Tasks
  task_6dca1aa4-…  ready  Add a farewell function
    pr      https://github.com/you/repo/pull/12
    branch  factory/task-6dca1aa4
    verify  pass at b9ccd6836f76: checks passed, CI passed, reviewer passed (low risk)
            checks: build ✓, test ✓   CI: passed   reviewer: pass (low risk)
    next    factory approve task_6dca1aa4-… [--merge], or factory reject task_6dca1aa4-… --reason "..."

Runs
  run_d4d34200-…  build   succeeded  2026-11-22T15:14:43.023Z
  run_c5131ffe-…  verify  succeeded  2026-11-22T15:14:52.410Z

Gates
  spec_approval  approved (skipped) by you
  plan_check  approved (skipped) by you
```

How to read it:

- **TASKS `0/1`** counts merged tasks.
- **verify** is the latest evidence: the commit checked, each check, CI and the reviewer. A
  reworked task also shows a `rework` line with its attempts against the limit.
- **next** is the command that moves the task on. See
  [Verify, rework and approve](verify-and-approve.md).
- **Gates** shows each recorded decision. A hand-written task skips the spec and plan gates,
  because you wrote it. The reason is stored with the decision.
- A failed task shows a `reason` line with the step that failed.

## Log: what exactly happened?

```sh
factory log <run-id>               # one run
factory log <work-item-id>         # every run of a work item
factory log <run-id> --full        # whole tool inputs and outputs, not first lines
factory log <run-id> --json        # the raw events, one JSON object per line
```

Each line is one event: the time, what happened, and the detail.

| Line | Meaning |
| --- | --- |
| `checkout` | the fresh clone the run started from |
| `sandbox … network allowlist: …` | the container, its branch, and every host it could reach |
| `context` | the rule files the agent was given (and any dropped for size) |
| `agent … limits 1800s / $5.0000` | the agent, model, and the wall-clock and spend limits |
| `budget_stopped` | the run didn't start: a spend cap is used up (which one, and how much was spent) |
| `✗ denied shell` | a command the agent wasn't allowed to run, refused |
| `→ Read`, `→ Bash`, `→ Edit` … | a tool call by the agent |
| `←` / `← error` | the result of that call |
| `says` | the agent's messages |
| `file modified src/x.ts` | a file the agent changed |
| `agent succeeded; N in / M out tokens, $X` | the run's total usage and cost |
| `summary` | the agent's closing summary (also in the PR body) |
| `secrets_found` | the secret scan's hits (file, line, kind; never the value); nothing was pushed |
| `protected_paths_changed` | protected files the change touches; the task will wait for a person |
| `commit`, `push`, `pr` | what the factory did with the result |
| `network N allowed, M denied` | the sandbox proxy's decisions, with each refusal (`--full`: all of them) |
| `step_failed` | the step that failed and why |
| `sandbox … destroyed` | cleanup, which always happens |

The log is complete on its own: it doesn't need the sandbox, the checkout or the PR to still
exist. `--json` gives you the same events to process with `jq` or any other tool.

## When a run fails

Find the failing step in `factory status <work-item>` or at the end of `factory log`:

| Failed at | Usually means | Look at |
| --- | --- | --- |
| `clone` | no access to the repo, or a wrong base branch | your GitHub sign-in; `--base` |
| `sandbox` | image missing, or Docker not running | `docker image ls`; `factory validate` |
| `agent` | the agent stopped: a time or spend limit, or an error | the last `says` and `← error` lines |
| (declined) | the agent decided not to change anything; the task escalates | its `summary`, which says why |
| `scan` | the secret scan found something; nothing was pushed | the `secrets_found` line; remove the secret and `factory retry` |
| (paused for budget) | a spend cap is used up; the task waits | `factory budget`; `factory budget extend <task>` |
| `push` / `pr` | no permission to push, or a PR for that branch already exists | the token's scopes; open PRs |

A failed **build** run fails the task: submit it again, which makes a new work item with fresh
ids. A task that **escalated** (declined, out of rework, or Verify couldn't decide) can carry on:
`factory retry <task> [--note "…"]`.

A **verify** run's log has `check`, `ci`, `review` and `verdict` lines. `--full` adds each failed
check's output and every reviewer reason.

## Where state lives

```text
~/.cradleworks/          (or $CRADLEWORKS_HOME)
  state.db               the event log: every work item and every run
  work/                  temporary checkouts, removed after each run
  sandboxes/             temporary worktrees and proxy state, removed after each run
```

Set `CRADLEWORKS_HOME` to keep separate histories, for example one for experiments and one for
real work. Deleting the folder forgets every run, but not the branches and PRs already pushed.

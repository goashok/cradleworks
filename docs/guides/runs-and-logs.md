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
wi_5eb83867-b216-4ed4-ae28-57e85860a243  in_progress  0/1    hello-node  Add a farewell function

$ factory status wi_5eb83867-b216-4ed4-ae28-57e85860a243
wi_5eb83867-b216-4ed4-ae28-57e85860a243  in_progress
  title      Add a farewell function
  project    hello-node
  requester  you
  …
Tasks
  task_6dca1aa4-…  verifying  Add a farewell function
    pr      https://github.com/you/repo/pull/12
    branch  factory/task-6dca1aa4

Runs
  run_d4d34200-…  build  succeeded  2026-11-22T15:14:43.023Z

Gates
  spec_approval  approved (skipped) by you
  plan_check  approved (skipped) by you
```

How to read it:

- **TASKS `0/1`** counts merged tasks. A task with an open PR sits in `verifying`, waiting for
  the Verify station (M2) and for you to review the PR.
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
| `→ Read`, `→ Bash`, `→ Edit` … | a tool call by the agent |
| `←` / `← error` | the result of that call |
| `says` | the agent's messages |
| `file modified src/x.ts` | a file the agent changed |
| `agent succeeded; N in / M out tokens, $X` | the run's total usage and cost |
| `summary` | the agent's closing summary (also in the PR body) |
| `commit`, `push`, `pr` | what the factory did with the result |
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
| `commit` "without changing any files" | the agent decided not to change anything | its `summary`, which says why |
| `push` / `pr` | no permission to push, or a PR for that branch already exists | the token's scopes; open PRs |

To try again, submit the task again. Each submit is a new work item with fresh ids, so nothing
is overwritten.

## Where state lives

```text
~/.cradleworks/          (or $CRADLEWORKS_HOME)
  state.db               the event log: every work item and every run
  work/                  temporary checkouts, removed after each run
  sandboxes/             temporary worktrees and proxy state, removed after each run
```

Set `CRADLEWORKS_HOME` to keep separate histories, for example one for experiments and one for
real work. Deleting the folder forgets every run, but not the branches and PRs already pushed.

# CLI reference

```text
factory submit <task.md> [--base <branch>] [--build-only]
factory status [<id>]
factory approve <id> [--merge] [--reason <text>]
factory reject <id> --reason <text> [--no-run]
factory retry <id> [--loops <n>] [--note <text>] [--no-run]
factory resume <id>
factory sync [<id>]
factory cancel <id> [--reason <text>]
factory validate [<dir>]
factory log <run-id|work-item-id> [--full] [--json]
factory help
```

`<id>` is a task id (`task_…`) or a work item id (`wi_…`, which stands for its only task).

Run every command except `status`, `log` and `cancel` inside a repository that has
`.factory/factory.yaml`, in its root or any folder below it. `status`, `log` and `cancel` work
from anywhere. They read the state in
`$CRADLEWORKS_HOME` (default `~/.cradleworks`).

Until Cradleworks is published as a package, run the CLI from a checkout:

```sh
alias factory="node /path/to/cradleworks/packages/cli/src/main.ts"
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The task didn't reach the change gate: the build failed, or the task escalated (declined, out of rework attempts, or Verify couldn't decide). |
| `2` | Bad usage or setup: unknown command, missing file, invalid `factory.yaml`, unknown adapter, no `origin` remote, or a problem found by `validate`. |

## `factory submit <task.md>`

Records the task as a work item and takes it as far as it can go without you: Build opens the PR,
Verify checks it, rework repeats until it passes or runs out of attempts, and then the change
gate. It runs in the foreground.

| Option | Meaning |
| --- | --- |
| `--base <branch>` | The branch to start from and open the PR against. Default `main`. |
| `--build-only` | Stop after the PR opens, without Verify (the M1 behaviour). |

The task file must start with a `# Title` line. The rest is the description. See
[Write good tasks](../guides/writing-tasks.md).

It prints the work item id, then `Opened <pr-url>` with the branch and run id. For each Verify
run it prints the evidence line and `Passed`, `Sent back for rework` or `Needs a human`, with the
run id. For each rework it prints `Pushed rework <n> to <pr-url>`. It ends with one of:

- `Ready for review: <pr-url>` and the `approve` and `reject` commands (exit 0)
- `Approved and ready to merge`, or `Merged <sha>`, when the gates are `ai` or `skip` (exit 0)
- `Escalated: <reason>` and the `retry` and `cancel` commands (exit 1)
- `Build failed: <step>: <reason>` (exit 1)

The branch is always `factory/task-<8 chars>`.

## `factory approve <id>`

Passes a `ready` task through the change gate as you.

| Option | Meaning |
| --- | --- |
| `--merge` | Also squash-merge it. Refused if the PR's head has moved since Verify passed it. |
| `--reason <text>` | Stored with the decision. |

## `factory reject <id> --reason <text>`

Sends a `ready` task back. The reason reaches the agent as rework feedback, and the task carries
on straight away (Build, Verify, the gate). Use `--no-run` to only record the rejection. A
rejection counts against `max_rework_loops`.

## `factory retry <id>`

Gives an `escalated` (or failed) task more attempts and carries on.

| Option | Meaning |
| --- | --- |
| `--loops <n>` | How many more attempts. Default 1. |
| `--note <text>` | Feedback for the agent, e.g. what to do differently. |
| `--no-run` | Record the retry without running. |

## `factory resume <id>`

Carries on a task from where it stands: one that was interrupted, or one that `sync` sent back.

## `factory sync [<id>]`

Reads the project's open pull requests and records what people did on them since the last Verify:
an approving review (gate approved), a request for changes (back to rework, with the review as the
feedback), a merge (task merged), or a close (task cancelled). Without an id, it checks every open
work item of the project. It doesn't start any runs.

## `factory cancel <id>`

Cancels the work item. Its pull requests stay open. `--reason` is stored.

## `factory status [<work-item-id>]`

Without an id, it lists every work item, newest first, with its state, merged and total tasks,
project and title.

With an id, it shows the work item in detail: its tasks (state, PR, branch, reason, rework
attempts, the latest Verify evidence, and the next command to run), its runs (station, outcome,
start time) and its gate decisions (gate, verdict, mode, who).

## `factory validate [<dir>]`

Checks a project's `.factory/` setup without touching git, the network or the state store. It
looks in `<dir>` (default: the current folder) and the folders above it.

It reports:

- YAML and schema errors, with line numbers
- unknown adapter ids (adapters planned for a later milestone are listed as notes)
- `context.rules` patterns that match no file
- `context.include` paths that don't exist
- whether `stack.image` has been built on this machine (a note, not an error)

It prints `ok` and exits 0 when there are no problems.

## `factory log <id>`

Replays a run from its stored events. Pass a run id (`run_…`) for one run, or a work item id
(`wi_…`) for all of its runs, each with a heading.

| Option | Meaning |
| --- | --- |
| `--full` | Show tool inputs, outputs and messages in full, instead of their first line. |
| `--json` | Print the raw stored events, one JSON object per line. |

See [Follow and replay runs](../guides/runs-and-logs.md) for how to read the output.

# CLI reference

```text
factory submit <task.md> [--base <branch>]
factory status [<work-item-id>]
factory validate [<dir>]
factory log <run-id|work-item-id> [--full] [--json]
factory help
```

Run `submit` and `validate` inside a repository that has `.factory/factory.yaml`, in its root or
any folder below it. `status` and `log` work from anywhere. They read the state in
`$CRADLEWORKS_HOME` (default `~/.cradleworks`).

Until Cradleworks is published as a package, run the CLI from a checkout:

```sh
alias factory="node /path/to/cradleworks/packages/cli/src/main.ts"
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The work failed: the build didn't produce a PR. |
| `2` | Bad usage or setup: unknown command, missing file, invalid `factory.yaml`, unknown adapter, no `origin` remote, or a problem found by `validate`. |

## `factory submit <task.md>`

Records the task as a work item and runs the Build station on it. It runs in the foreground and
returns when the PR is open or the build has failed.

| Option | Meaning |
| --- | --- |
| `--base <branch>` | The branch to start from and open the PR against. Default `main`. |

The task file must start with a `# Title` line. The rest is the description. See
[Write good tasks](../guides/writing-tasks.md).

It prints the work item id, then either `Opened <pr-url>` with the branch and run id, or
`Build failed: <step>: <reason>` with the run id. The branch is always `factory/task-<8 chars>`.

## `factory status [<work-item-id>]`

Without an id, it lists every work item, newest first, with its state, merged and total tasks,
project and title.

With an id, it shows the work item in detail: its tasks (state, PR, branch, failure reason), its
runs (station, outcome, start time) and its gate decisions (gate, verdict, mode, who).

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

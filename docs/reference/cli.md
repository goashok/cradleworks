# CLI reference

```text
factory watch [<dir>...] [--once] [--interval <seconds>] [--label <name>]
factory submit <task.md> [--base <branch>] [--build-only]
factory status [<id>]
factory approve <id> [--merge] [--reason <text>]
factory reject <id> --reason <text> [--no-run]
factory retry <id> [--loops <n>] [--note <text>] [--no-run]
factory resume <id>
factory verify <task-id> [--note <text>]
factory sync [<id>]
factory cancel <id> [--reason <text>]
factory budget [<user>]
factory budget extend <id> [--usd <n>] [--no-run]
factory budget extend --user <name> --usd <n> [--month]
factory review <change.patch> --title <text> [--task <file.md>] [--base <branch>] [--check <name>] [--json]
factory drill [--check <name>] [--base <branch>] [--json]
factory eval run <suite> [<task> | @<set> ...] [--variant <file>] [--label <name>] [--out <file>] [--jobs <n>]
factory eval check <suite> [<task> | @<set> ...]
factory eval report <results.jsonl>...
factory eval compare --base <results.jsonl>... --variant <results.jsonl>... [--json]
factory stats [--days <n>] [--project <name>] [--json]
factory validate [<dir>] [--json]
factory docs [<topic> [<section>]] [--sections] [--search <words>]
factory config explain [<key>...]
factory skills list | add <git-url|folder> [--path <dir>] [--ref <ref>] [--name <name>] | update <name> [--ref <ref>] | lock <name>
factory log <run-id|work-item-id> [--full] [--json]
factory help
```

`<id>` is a task id (`task_…`) or a work item id (`wi_…`). A work item id stands for its only
task, or for the work item itself at the spec and plan gates and when it's blocked.

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
| `0` | Success. For `watch`, it stopped when asked, or `--once` finished its pass. |
| `1` | The task didn't reach the change gate: the build failed, or the task escalated (declined, out of rework attempts, or Verify couldn't decide). |
| `2` | Bad usage or setup: unknown command, missing file, invalid `factory.yaml`, unknown adapter, no `origin` remote, or a problem found by `validate`. |
| `3` | `review` only: the change couldn't be reviewed (the patch doesn't apply, the reviewer hit its budget, or its run failed). For `review`, `1` means rework or escalate. |

## `factory watch [<dir>...]`

Takes GitHub issues labelled `factory` from spec to merged pull requests. See
[From an issue to merged PRs](../guides/issues.md) for the whole flow.

Each pass lists the open issues with the label, records new ones as work items, picks up what
people did on the PRs (like `sync`), and moves every open work item as far as it can go: Specify,
the spec gate, Plan, the plan check, then the tasks, in parallel up to `concurrency`. It prints a
line for each step, and one when a work item starts waiting on a person.

| Option | Meaning |
| --- | --- |
| `<dir>...` | Project folders to watch. Default: the current one. |
| `--once` | Make one pass and exit. |
| `--interval <seconds>` | Time between passes. Default 60. |
| `--label <name>` | The label that hands an issue to the factory. Default `factory`. |

The project needs a tracker (`adapters.tracker: github-issues`). On start, `watch` closes runs that
a previous stop cut off and builds again any build that was cut off. Only one `watch` may run
per `$CRADLEWORKS_HOME`. A second one exits with code 2. The first Ctrl-C finishes the steps in
progress and the second stops at once.

A closed issue cancels its work item. An issue whose label was removed is left alone until the
label is back.

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

Passes a `ready` task through the change gate as you. Given a work item waiting at the spec or
plan gate, it approves the spec or plan instead, the same as `/approve` on the issue, and
`factory watch` carries on from there.

| Option | Meaning |
| --- | --- |
| `--merge` | Also squash-merge it. Refused if the PR's head has moved since Verify passed it. |
| `--reason <text>` | Stored with the decision. |

## `factory reject <id> --reason <text>`

Sends a `ready` task back. The reason reaches the agent as rework feedback, and the task carries
on straight away (Build, Verify, the gate). Use `--no-run` to only record the rejection. A
rejection counts against `max_rework_loops`.

Given a work item at the spec or plan gate, it rejects the spec or plan. The next `watch` pass
writes a new version with your reason.

## `factory retry <id>`

Gives an `escalated` task more attempts and carries on. A `failed` task (its build broke) is final: submit the task again.

| Option | Meaning |
| --- | --- |
| `--loops <n>` | How many more attempts. Default 1. |
| `--note <text>` | Feedback for the agent, e.g. what to do differently. |
| `--no-run` | Record the retry without running. |

## `factory resume <id>`

Carries on a task from where it stands: one that was interrupted, or one that `sync` sent back.
Given a blocked work item, it unblocks it (the same as `/retry` on the issue), and `factory watch`
carries on from there.

## `factory sync [<id>]`

Reads the project's open pull requests and records what people did on them since the last Verify:
an approving review (gate approved), a request for changes (back to rework, with the review as the
feedback), a merge (task merged), or a close (task cancelled). Without an id, it checks every open
work item of the project. It doesn't start any runs.

## `factory cancel <id>`

Cancels the work item. Its pull requests stay open. `--reason` is stored.

## `factory verify <task-id>`

Verifies a task's branch as it stands, without building: for commits a person pushed to the
branch, or to see how the checks judge it now. The task must have a pull request and be ready,
sent back or escalated. Build's hard rules run on the whole branch first, since hand-pushed
commits never went through them: a secret escalates the task without reviewing, and protected
paths are recorded so the change needs a person at the gate. Then Verify runs as usual (checks,
acceptance tests, CI, the reviewer and agent checks) and its verdict moves the task, counting a
send-back toward `max_rework_loops`. A previous approval at the change gate no longer counts.
Nothing builds afterwards: `factory resume` reworks a task that was sent back.

`--note` is recorded as the reason. Exit status: 0 passed, 1 sent back or escalated, 2 the task
can't be verified now.

## `factory eval`

Measures the factory on a suite of tasks with hidden tests. See
[Measure your own factory](../guides/measuring.md) for the suite format.

| Command | Does |
| --- | --- |
| `run <suite> [<task> \| @<set> ...]` | For each task (all by default), runs `factory submit` on a scratch copy of the project at the task's base commit, with local git, no CI or tracker, and the change gate decided by the reviewer and merged. Then grades the merged result with the hidden tests, on this machine. Appends one JSON line per task to `--out` (default `<suite>/results/<date>-<label>.jsonl`) and skips tasks already there. `--variant <file>` applies a config variant first; `--label` names the run (default the variant's name, or `base`); `--jobs` runs tasks in parallel. Exit 0, or 3 when a task could not run |
| `check <suite> [<task> ...]` | Checks the tasks: hidden tests fail at the base commit (or pass with `expect_base: pass`), pass with `solution.patch`, fail with each `wrong/*.patch`. Exit 0 when every case is as expected, 1 otherwise |
| `report <results.jsonl>...` | Each file's score, cost and time, and each task's outcome |
| `compare --base <file>... --variant <file>...` | Scores over the tasks every file has, the noise band (the range of the base scores; needs two or more), and a verdict: better or worse only when every variant run lands outside the band |

## `factory stats`

How the factory did on work received in the last `--days` days (default 30), from the event store:
work items and tasks by outcome, first-time passes, rework rounds per merged task, Verify's
verdicts, each gate's decisions, each agent check's catches, cost per merged task, the median time
from request to merge, and Verify runs by the `.factory/` config they ran under. `--project`
narrows it to one project; `--json` prints the numbers as one object.

## `factory drill`

Hands each agent check (`verify.agent_checks`) its known-bad changes from
`.factory/drill/<check>/` and every known-good one from `.factory/drill/controls/`, and the
reviewer its own from `.factory/drill/reviewer/` when there are any. Each case is a `.patch`
with a `.md` of the task beside it. A known-bad case passed once runs again, and is missed only
if it passes both times; `known-misses.txt` lists cases reported but not counted.

| Flag | Does |
| --- | --- |
| `--check <name>` | Only that check, or `reviewer` |
| `--base <branch>` | Apply the cases to, and read the checks' skills and rules from, that branch (default the project's base) |
| `--json` | One JSON object: `code`, `flagged`, each case's verdicts, reason, cost and runs |

Exit status: 0 every case judged right, 1 flagged (a missed known-bad case, or more than half the
controls sent back by one check), 2 bad usage or no cases, 3 inconclusive (a run gave no verdict).
See [Drill your checks](../guides/verify-and-approve.md#drill-your-checks).

## `factory review <change.patch>`

Has the reviewer judge a change the factory didn't build: the patch is applied to `--base` (the
project's base branch by default) in a fresh sandbox, and the reviewer gets the same prompt, rules
and verdict reading as Verify's, with `--title` and the text of `--task` as the task. No checks
run (the reviewer may run what it needs), nothing is pushed, and no work item is charged; the run
is capped at `budgets.per_task_usd`. Prints the verdict, risk and reasons, or with `--json` one
JSON object with `review`, `cost` and `runId`. `factory log <runId>` replays it.

Use it to review a branch by hand (`git diff main...feature > change.patch`), or to check the
reviewer itself: the eval suite's reviewer drill hands it changes known to be wrong.

With `--check <name>`, one of the project's agent checks judges it instead, as in Verify; its
spend is capped at its `max_share` of the per-task budget, and a check that gives no verdict exits 3.

## `factory budget`

`factory budget [<user>]` shows what a requester (default: your git user) has spent today and
this month, UTC, against `per_user_daily_usd` and `per_user_monthly_usd`, with any extensions
granted, and the per-task cap.

`factory budget extend <id> [--usd <n>]` raises a paused task's cap by `n` dollars (default 0,
for when it was the requester's cap that stopped it) and carries on with the task in the
foreground; `--no-run` only records it. A build cut off by its budget builds again; a verify
carries on where it stopped.

`factory budget extend --user <name> --usd <n> [--month]` raises a requester's daily cap (or
monthly, with `--month`) by `n` dollars for the current day or month only. Paused tasks then
need `factory budget extend <id>` to carry on.

Every extension is an event with who made it, and shows in `factory status`.

## `factory status [<work-item-id>]`

Without an id, it lists every work item, newest first, with its state, merged and total tasks,
project and title.

With an id, it shows the work item in detail. For work from an issue, that starts with the issue
link, the base branch, why it's blocked, the questions asked, the spec version and whether it's
approved, and the proposed plan. Then come its tasks (state, PR, branch, reason, rework
attempts, spend so far, any protected files it changes, the latest Verify evidence, and the next
command to run), the work item's total spend, its runs (station, outcome,
start time) and its gate decisions (gate, verdict, mode, who).

## `factory skills`

Vendors agent skills into `.factory/skills/` and pins them in `.factory/skills.lock`. Fetching
happens on this machine; nothing is committed, so the result is a change to review and commit.

| Command | Does |
| --- | --- |
| `list` | Each vendored skill: locked, not locked or changed since locked; where it came from; which roles use it |
| `add <git-url> [--path <dir>] [--ref <ref>]` | Clones the repository, takes the folder at `--path` (with a `SKILL.md`), copies it to `.factory/skills/<name>/`, and records the URL, path, ref, commit and a content hash. Prints the files, the whole `SKILL.md` and any scripts, and records what its scripts look like they need in the image (`--requires <command>`, repeatable, sets that instead). `--name` overrides the name in `SKILL.md` |
| `add <folder>` | The same for a folder on this machine, recorded as your own (`local`) |
| `update <name> [--ref <ref>]` | Fetches the locked source again (at `--ref`, or the locked ref), shows what changed, and replaces the copy and its lock entry |
| `require <name> [<command>...]` | Sets the commands that must succeed in the project's image for the skill to work, replacing the ones `add` guessed from its scripts; with none, drops them. `factory validate` runs them |
| `lock <name>` | Records the folder as it is now. A changed copy of someone else's skill becomes your own, with where it was forked from |

Exit status: 0 done, 2 refused (bad source, an existing skill on `add`, a local skill on `update`).

## `factory validate [<dir>] [--json]`

Checks a project's `.factory/` setup without touching git, the network or the state store. It
looks in `<dir>` (default: the current folder) and the folders above it.

It reports:

- YAML and schema errors, with line numbers
- unknown adapter ids, a CI or tracker that doesn't suit the `scm`, and `related_repos` that
  have no `.factory/factory.yaml`
- `context.rules` patterns that match no file
- `context.include` paths that don't exist
- prompt additions (`.factory/prompts/*.md`) not named for a role, and empty ones (a note)
- agent checks and drill cases: a `.factory/drill/` folder that isn't `reviewer`, `controls` or a check's name is a problem; a blocking check without known-bad cases (it runs advisory), a case without its `.md`, and a known miss that names no case are notes
- skills: a folder without a valid `SKILL.md`, one not in `.factory/skills.lock` or changed since it was locked, a lock entry with no folder, and a role naming a skill that isn't there; a vendored skill no role uses is a note
- a skill's requirements: each command recorded with `factory skills require` (or guessed by `add`) for a skill a role uses is run in a throwaway container of `stack.image`, with no network; one that fails is a problem. When the image isn't built yet, it's a note instead
- whether `stack.image` has been built on this machine (a note, not an error)

It prints `ok` and exits 0 when there are no problems, or 2 when there are.

With `--json` it prints one object instead, for scripts and assistants: `ok`, `repoRoot`,
`project`, `ruleFiles`, `promptAdditions`, `skills`, `image`, `adapters`, `notes` and `problems`
(lists of strings), or `configErrors` (each with `file`, `line`, `col` and `message`) when
`factory.yaml` doesn't load.

## `factory docs`

The guides and reference that came with this version of the factory, at the terminal. They're
read from the `docs/` folder beside the CLI, so they match the version you run.

| Command | Prints |
| --- | --- |
| `factory docs` | Every topic by name and title: start here, guides, reference |
| `factory docs <topic>` | One topic, such as `add-a-project` or `configuration` |
| `factory docs <topic> --sections` | Its headings |
| `factory docs <topic> <section>` | One section, by heading or words of it: `factory docs verify-and-approve agent checks` |
| `factory docs --search <words>` | The sections that mention every word, best first, each with the command that prints it |

## `factory config explain [<key>...]`

What a `factory.yaml` key means. For each key, it gives:

- its type and allowed values, from the same schema that loading checks;
- its default, from `defaults/factory.yaml`;
- its value in this repository, when run inside a project;
- what it does, and where it's documented, from the [configuration reference](configuration.md).

Write keys with dots: `gates.change_approval`, `verify.agent_checks.security.blocks` (a name you
chose works where the reference says `<name>`). A mapping such as `gates` lists the keys under
it. A key that doesn't exist exits 2 and suggests the one you probably meant. With no key, it
lists every key.

## `factory log <id>`

Replays a run from its stored events. Pass a run id (`run_…`) for one run, or a work item id
(`wi_…`) for all of its runs, each with a heading.

| Option | Meaning |
| --- | --- |
| `--full` | Show tool inputs, outputs and messages in full, instead of their first line. |
| `--json` | Print the raw stored events, one JSON object per line. |

See [Follow and replay runs](../guides/runs-and-logs.md) for how to read the output.

## `factory console [--port <n>]`

A local web page over the factory's state, at `http://127.0.0.1:4747/` by default:

- **Dashboard**, the page it opens on: counts of what needs you, what is in progress, what merged
  this week, runs and spend this week, each linking to the list it counts; runs per day for the
  last two weeks; what waits on you, grouped by what it waits on (a spec or change to approve, a
  failed or escalated task, a budget); work in progress, marked **stalled** when nothing has run
  for over an hour (usually `factory watch` stopped or paused on a usage limit); the latest runs;
  and recently finished work. Pages refresh every 10 seconds.
- **Work**: every work item, where it is, tasks merged out of planned, and spend, filtered to
  needs you, in progress or finished.
- **Runs**: every agent run across all work, newest first, filtered to running or did not succeed.
- **Needs you**: work items at the spec gate, tasks waiting at the change gate, and tasks
  that escalated, failed or hit their budget.
- A work item's page tells its story: a sentence on where it stands and whether it needs you,
  its progress from request to merged, the spec (open for reading while it waits for approval),
  a card per task with its pull request and its latest check (project checks, CI, the reviewer's
  verdict and reasons), what happened in order, and every run with what it cost. The text of
  `factory status <id>` is folded at the bottom.
- A run's page leads with its result in the terms of its step (the checks and the reviewer's
  verdict for Verify, the decision for a spec or plan check, the commit and pull request for
  Build), then each agent's work as a conversation, its commands folded with their output. Where
  it ran (sandbox, network, rules, limits) and the text of `factory log --full` are folded below.

The buttons are the CLI's own commands, run in the directory the console started in: approve, send
back (`reject --no-run`), retry (`--no-run`), extend a budget (`--no-run`) and cancel. A running
`factory watch` carries the work on. They keep every rule the CLI has; for example, a change to
protected files still can't be approved by an AI gate.

The console listens on this machine only. Each button press carries a random token that only the
console's own pages have, and must come from the console's own address, so a web page elsewhere in
your browser can't press them.

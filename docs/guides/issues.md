# From an issue to merged pull requests

`factory submit` builds a task you wrote yourself. `factory watch` goes one step earlier. It
reads GitHub issues, writes a spec with acceptance criteria, gets it approved, splits it into
tasks, builds and verifies each one as a pull request, and merges them in dependency order. The
issue thread is where you see what happened and where you decide.

```text
 issue labelled "factory"
   │
   ▼
 Specify ─── spec agent (read-only) ─── may ask one round of questions on the issue
   │
   ▼
 spec gate ─ you: /approve or /reject <why>   (or an ai checker, or skip)
   │
   ▼
 Plan ────── planner agent: up to 8 tasks, each small or medium, with dependencies,
   │         every acceptance criterion covered; the factory checks those rules itself
   ▼
 plan check ─ an ai checker by default (or you, or skip)
   │
   ▼
 for each task, in parallel up to `concurrency`, a task starting only once the tasks it
 depends on have merged:
     Build → Verify (checks, CI, reviewer, and the tester's acceptance tests) → change gate → merge
   │
   ▼
 "Done: 3 pull requests merged" on the issue
```

## Set it up

1. **The project uses GitHub.** Set `scm: github` and `tracker: github-issues` in
   `.factory/factory.yaml`. `factory validate` checks that the two go together.
2. **The factory can read and write issues.** It uses the same GitHub sign-in as for pull
   requests (`GITHUB_TOKEN`, or your `gh` login). The token needs to read and write issues and
   labels, and to read collaborators, which is how it tells who may approve.
3. **Pick the gates.** The defaults are `spec_approval: human`, `plan_check: ai` and
   `change_approval: human`. To let the factory go from issue to merge on its own, use
   `change_approval: ai` with `auto_merge: true`. See [Gates](#gates).

Then, inside the repository:

```console
$ factory watch
Watching you/your-repo for open issues labelled "factory", every 60s
```

`watch` runs in the foreground. It checks for issues every 60 seconds (`--interval <s>`), and
moves every open work item as far as it can go each time. `--once` makes a single pass and exits,
which is handy for scripts and for trying it out. Give it several project folders to watch them
all: `factory watch ../orders ../web`.

The first Ctrl-C lets the steps in progress finish. A second Ctrl-C stops at once. Either way,
everything is in the event log, so the next `factory watch` carries on. It closes runs that were
cut off, and a build that was cut off is built again from the start. Only one `watch` may run per
factory home (`~/.cradleworks`).

## What happens on the issue

Open an issue and add the **`factory`** label (or the label you give `--label`). Issues without
the label are left alone.

**Picked up.** The factory comments `Picked up as wi_…` and labels the issue `factory:received`.
While it works, one `factory:<state>` label always shows where the issue stands:
`factory:awaiting_spec_approval`, `factory:planning`, `factory:in_progress`, `factory:merged`,
`factory:blocked`, and so on.

**Questions (sometimes).** If the issue leaves something important open, the spec agent asks up
to five questions in one comment, addressed to whoever opened the issue. Answer in a normal
comment, in your own words. On its next pass the factory writes the spec, with your answers in
it. There is only one round of questions. Anything still unclear after that becomes a stated
assumption in the spec, which you can correct when you review it.

**The spec.** The factory posts the spec as a comment:

```markdown
## Spec, version 1: Export orders as CSV

### Problem
Shop owners want their orders in a spreadsheet.

### Acceptance criteria
1. GET /orders/export returns text/csv with one row per order
2. …

### Out of scope
- Scheduled exports

### Assumptions
- Prices are exported in the order's currency, without conversion

_Reply **`/approve`** to start planning, or **`/reject <what to change>`** for a new version. Only people with write access can decide._
```

Reply `/approve`, or `/reject Exports must include refunds` to get version 2. The spec agent sees
your reason and its previous version. Only people with **write access** to the repository can
decide. Commands from anyone else are ignored, and so are commands written before the spec
version they would apply to.

**The plan.** Next the planner proposes the tasks, as a table on the issue: each task's title,
size, the tasks it waits for, and the repository it goes to. The factory itself checks the plan
first:

- at most 8 tasks, each `small` or `medium`, never `large`
- every acceptance criterion covered by at least one task
- dependencies that exist and don't form a cycle
- only repositories the project offers (see [More than one repository](#more-than-one-repository))

A plan that breaks these rules goes back to the planner once, with the problems listed. If the
second plan breaks them too, the work item stops as blocked. After that the plan check gate
decides, by default an ai checker.

**The tasks.** Each task is built and verified exactly as in
[Verify, rework and approve](verify-and-approve.md), and becomes its own pull request. The PR
says `Part of <issue>`, and the issue gets a link to it. Tasks that wait for nothing start
straight away, up to `concurrency` at a time. A task that depends on others starts only after
they have **merged**, from the updated base branch, so it builds on their work.

When a task passes Verify and the change gate is `human`, the issue says so with the PR link.
Approve it on the PR (or `factory approve <task>`), and merge it yourself or with
`factory approve <task> --merge`. The next pass of `watch` sees the merge and starts the tasks
that were waiting for it.

**Done.** When every task has merged, the factory comments `Done: 3 pull requests merged` with
the list and labels the issue `factory:merged`. The issue itself stays open, so close it when
you're happy.

## Commands

| Where | Command | Who | Does |
| --- | --- | --- | --- |
| issue | `/approve [note]` | write access | Approves the spec or plan that's waiting |
| issue | `/reject <reason>` | write access | Sends it back; the reason goes to the agent. A reject without a reason is ignored. |
| issue | `/retry` | write access | Continues a work item that's blocked |
| issue | any reply | the requester (or anyone) | Answers the spec agent's questions |
| CLI | `factory approve <wi>` | you | Same as `/approve` |
| CLI | `factory reject <wi> --reason <text>` | you | Same as `/reject` |
| CLI | `factory resume <wi>` | you | Same as `/retry` |
| CLI | `factory status <wi>` | you | Spec version, questions, proposed plan, tasks, runs and gates |

A command must start its own line. When several are waiting, the last one counts.

**Closing the issue** cancels the work item. Its open pull requests stay open, so close them on
GitHub if you want to. **Removing the label** pauses the work: `watch` stops moving it until the
label is back.

## Gates

`spec_approval` and `plan_check` each take `human`, `ai` or `skip`:

- `human`: you decide on the issue (or from the CLI).
- `ai`: a checker agent reads the issue and the spec (or the spec and the plan), approves or
  sends it back with reasons, and posts its verdict on the issue. If it sends the same work item
  back **twice**, the gate turns into `human` for that work item, so an argument between two
  agents can't loop.
- `skip`: approved on the spot, and recorded as skipped.

Every decision is recorded with who made it and why, and shows in `factory status` and
`factory log`.

## The spec in the repository

Drafts and every version live in the factory's event log. With `specs: repo` (the default), the
**approved** spec is also committed to `.factory/specs/issue-<n>-<title>.md` as part of the first
task's pull request, so it's reviewed and merged with the code. Each implementer and reviewer
sees the spec along with its own task. With `specs: factory` nothing is written to the
repository.

## The tester

With `verify.tester: true` (the default), Verify gets one more check for work from issues. A
tester agent writes acceptance tests for the criteria its task covers. It writes them from the
spec, on the base branch, **without seeing the implementer's change**. The tests are new files
named `*acceptance*`. They're written once per task and kept in the event log, not in the pull
request.

On every Verify, after the project's own checks pass, the tests are applied to the branch and the
project's `test` command runs as the `acceptance` check. If it fails, the task goes back for
rework, and the implementer sees the failing output and the tests themselves. If the tests don't
apply to the branch, the check is marked skipped and the reviewer decides as usual.

Set `verify.tester: false` to leave it out. Hand-written tasks from `factory submit` have no spec,
so there is nothing for the tester to work from.

## More than one repository

A change sometimes spans a service and its client. List the other repositories in
`related_repos`, as paths from this one:

```yaml
related_repos: [../ref-notifications-client]
```

Each must be a checkout with its own `.factory/factory.yaml` and the same `scm`. The planner is
told about them by project name and may give a task to one. That task is built, verified and
merged in its own repository, with that repository's image, commands, rules and gates. It still
appears in this issue's plan and progress. The issue is only ever watched in the repository
where it was opened.

## Working from another branch

To have the work start from a branch other than the default and merge back into it, put this
line in the issue body:

```markdown
<!-- cradleworks: base=release/2 -->
```

It's an HTML comment, so it doesn't show on GitHub. It applies to every repository the work
touches, so with `related_repos` the branch must exist in each of them.

## When it stops

`watch` prints one line whenever a work item's situation changes:

```text
#14 picked up as wi_8c2…
#14 spec v1: Export orders as CSV (4 acceptance criteria)
#14 awaiting_spec_approval, waiting for spec approval: /approve or /reject on the issue
#14 spec_approval approved (human) by sam
#14 plan_check approved (ai) by plan checker (claude-sonnet-5-5)
#14 [Add the CSV writer] Opened https://github.com/you/shop/pull/31
#14 [Add the CSV writer] ready, ready for review: https://github.com/you/shop/pull/31
#14 in_progress, waiting for tasks: 1 ready for review, 2 waiting on their dependencies
```

A work item that is **blocked** says why, both on the issue and in `factory status <wi>`. That
happens when the spec agent couldn't produce a spec, or the planner's plan broke the rules twice.
Fix what's needed, for example by making the issue clearer, then reply `/retry`. A task that
**escalates** or **fails** is handled the same way as one from `factory submit`
(`factory retry <task>`, or `factory cancel <wi>`). See
[Verify, rework and approve](verify-and-approve.md).

Every agent run, including the spec, plan, check and tester runs, has its own event log:
`factory log <wi>` replays them all.

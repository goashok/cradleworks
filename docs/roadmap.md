# Roadmap

Each milestone ends with something that runs. M0 to M5 are done.

| | Milestone | Delivers | Exit check | Status |
| --- | --- | --- | --- | --- |
| M0 | Reference projects and eval suite | Two reference projects; 30 tasks with hidden tests, reference solutions and a grader | Every task proven solvable | ✅ Done |
| M1 | Walking skeleton | State machine, event log, SQLite store, config, contract suites, GitHub adapter, Docker sandbox, Claude Code runtime, Build station, CLI | `factory submit` opens a PR on a reference project, logged and replayable | ✅ Done |
| M2 | Verify and gates | Verify station (build, tests, CI, reviewer agent), evidence bundle on the PR, the change gate, the rework loop | A task loops through rework and reaches the change gate with evidence | ✅ Done |
| M3 | Spec and plan | Intake from GitHub Issues, a spec agent and the spec gate, a planner that splits work into tasks, parallel tasks, a tester agent in Verify | An issue goes to merged PRs end to end on both projects | ✅ Done |
| M4 | Budgets and security | Per-user caps, a hard-deny list, scoped tokens, an evaluation of microVM sandboxes | Budget-stop and deny-list tests pass | ✅ Done |
| M5 | Eval and learning loop | The eval suite running on every core change, failure tagging, a weekly report | Changes that lower the pass rate are caught | ✅ Done. Exit check: a docs-only change is skipped; a weakened reviewer is caught by the reviewer drill ([how](guides/evaluating.md)) |
| M6 | Portability and console | A second agent runtime (OpenAI Codex CLI), a non-GitHub adapter, a local web console | The pass rate holds with no core change | |
| M7 | Real-codebase validation | The factory on a real repository the team didn't build | Results compared with today's baseline | |

## What M1 proved

- **The spine holds.** Every step of a run is an event, state is derived from events, and a run
  can be replayed after everything else is gone.
- **Vendors stay at the edge.** GitHub, Docker and Claude Code are adapters. The core names none
  of them, and CI checks that.
- **The Build station is already capable.** On the first baseline it passed 26 of 29 graded tasks
  for $2.27 in total ([details](guides/evaluating.md)). The failures were requirements the codebase
  implied but the task didn't state, which is what the M2 reviewer is meant to catch.

## What M2 added

- **Verify** runs the project's checks in a fresh sandbox, waits for CI on the pushed commit, and
  has a reviewer agent judge the diff. The verdict is pass, rework or escalate.
- **Rework** sends failures back to the implementer with the output or the reviewer's reasons,
  on the same branch and PR, up to `max_rework_loops`.
- **Evidence** goes on the PR as a comment and into `factory status`.
- **The change gate** (`human`, `ai` or `skip`) and **merge**: `factory approve [--merge]`,
  `reject`, `retry`, `resume`, `cancel` and `sync` (which picks up PR reviews and merges).
- **Declining** is an outcome: an agent that changes nothing and says why escalates to you, instead
  of failing the build.

## What M3 added

- **Intake from GitHub Issues.** `factory watch` polls issues labelled `factory` and reports back
  on the issue with comments and `factory:<state>` labels. A restart carries on where it stopped.
- **Specify** (spec agent, read-only, at most one round of questions) and the **spec gate**
  (`/approve` or `/reject <reason>` on the issue, by people with write access).
- **Plan** and the **plan check**: up to 8 small or medium tasks covering every acceptance
  criterion, with dependencies. The factory checks these rules itself before any agent does.
- **A scheduler.** Independent tasks run in parallel up to `concurrency`. A dependent task starts
  after its dependencies merge, from the updated branch.
- **A tester agent** in Verify writes acceptance tests from the spec without seeing the change.
- **More than one repository** through `related_repos`, and the approved spec committed with the
  first PR.

## What M4 added

- **Budgets that hold.** Every agent run's cost is recorded. `per_task_usd` covers all attempts
  of a task, and per-requester daily and monthly caps cover everything they asked for. At a cap
  the task pauses; `factory budget` shows spend and `factory budget extend` carries on.
- **Hard rules no config turns off.** The factory pushes only `factory/*` branches and merges only
  into the base branch. Changes to CI config, `.factory/` or `CODEOWNERS` wait for a person and
  are never merged automatically.
- **A secret scan before every push**, which escalates without ever repeating the value.
- **The model credential out of the sandbox**, set by the sandbox's proxy through a gateway.
- **Commands agents may not run**, and every network decision and refusal in the run log.
- **Optional GitHub App tokens**: an hour long, repo-scoped, least privilege.
- **Exit check:** on real issues with every gate set to `ai` and auto-merge on, a CI change was
  held for a person, a test secret was stopped before the push, and a task over its budget
  paused while smaller ones merged. See also [MicroVM sandboxes](design/microvm-sandboxes.md).

## What M5 added

- **A measured noise band.** The same factory scores 19 to 21 of 30 from run to run, so only a
  result outside that band means something.
- **Failure tags, a report, and a regression rule** that judges a run against the earlier runs of
  its own commit's history, run after each change to the factory.
- **Hygiene**: what a merged change holds besides the fix (whitespace-only files, lockfile churn,
  duplicated tests), which the pass rate can't see.
- **Two fixes the loop found.** The tester writes fewer wrong acceptance tests (25 of 30, from
  19 to 21), and agent answers that quote a brace are read instead of dropped.
- **Exit check met.** A docs-only change is skipped. A weakened reviewer scored as well as the
  real one on the 30 tasks, twice, since the outcomes only move when the implementer makes a
  mistake for the reviewer to catch. The reviewer drill checks it directly (`factory review` on
  known-wrong changes): the weakened reviewer is flagged on every run, the real one on none. See
  [How Cradleworks is measured](guides/evaluating.md).

## Later

Not scheduled; each becomes a milestone when it is planned.

- **A console for teams.** `factory console` is for one person on the machine the factory runs on:
  it listens on that machine only and has no sign-in. A team sharing one factory on a server
  needs a console each member opens from their own browser, with sign-in, and with the same
  permission the tracker applies to `/approve` (only people who may merge can decide a gate). Until
  then, a team's shared view is the issue and its pull requests.

- **Changes across repositories that work together.** A task that builds on a change in another
  repository now sees it, and the plan check wants such tasks ordered. Still missing: a check
  that runs the repositories together before the last of them merges, and holding every task's
  change until the whole work item passes, so half a feature never merges.

## Open questions

- Is the tester worth its cost? The M3 eval compares Verify with and without it.
- Should the per-task spend cap cover all attempts together, rather than each run?

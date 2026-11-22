# Roadmap

Each milestone ends with something that runs. M0 to M3 are done.

| | Milestone | Delivers | Exit check | Status |
| --- | --- | --- | --- | --- |
| M0 | Reference projects and eval suite | Two reference projects with planted difficulties; 30 tasks with hidden tests, reference solutions and a grader | Every task proven solvable; reviewed by someone outside the design team | ✅ Built and verified; outside review pending |
| M1 | Walking skeleton | State machine, event log, SQLite store, config, contract suites, GitHub adapter, Docker sandbox, Claude Code runtime, Build station, CLI | `factory submit` opens a PR on a reference project, logged and replayable | ✅ Done |
| M2 | Verify and gates | Verify station (build, tests, CI, reviewer agent), evidence bundle on the PR, the change gate, the rework loop | A task loops through rework and reaches the change gate with evidence | ✅ Done |
| M3 | Spec and plan | Intake from GitHub Issues, a spec agent and the spec gate, a planner that splits work into tasks, parallel tasks, a tester agent in Verify | An issue goes to merged PRs end to end on both projects | ✅ Done |
| M4 | Budgets and security | Per-user caps, a hard-deny list, scoped tokens, an evaluation of microVM sandboxes | Budget-stop and deny-list tests pass | Next |
| M5 | Eval and learning loop | The eval suite running on every core change, failure tagging, a weekly report | Changes that lower the pass rate are caught | |
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

## Open questions

- Is the tester worth its cost? The M3 eval compares Verify with and without it.
- Should the per-task spend cap cover all attempts together, rather than each run?

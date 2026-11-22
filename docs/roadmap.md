# Roadmap

Each milestone ends with something that runs. M0 and M1 are done. Their exit check was
`factory submit` opening a real PR on each reference project.

| | Milestone | Delivers | Exit check | Status |
| --- | --- | --- | --- | --- |
| M0 | Reference projects and eval suite | Two reference projects with planted difficulties; 30 tasks with hidden tests, reference solutions and a grader | Every task proven solvable; reviewed by someone outside the design team | ✅ Built and verified; outside review pending |
| M1 | Walking skeleton | State machine, event log, SQLite store, config, contract suites, GitHub adapter, Docker sandbox, Claude Code runtime, Build station, CLI | `factory submit` opens a PR on a reference project, logged and replayable | ✅ Done |
| M2 | Verify and gates | Verify station (build, tests, CI, reviewer agent), evidence bundle on the PR, the change gate, the rework loop | A task loops through rework and reaches the change gate with evidence | Next |
| M3 | Spec and plan | Intake from GitHub Issues, a spec agent and the spec gate, a planner that splits work into tasks, parallel tasks | An issue goes to merged PRs end to end on both projects | |
| M4 | Budgets and security | Per-user caps, a hard-deny list, scoped tokens, an evaluation of microVM sandboxes | Budget-stop and deny-list tests pass | |
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

## Open questions

- Should a refactor task be able to pass by deliberately changing nothing, as a distinct
  "declined" outcome instead of a failed build?
- Which checks belong in the Verify station itself, and which should be left to the project's CI?

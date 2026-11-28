# How Cradleworks is measured

A factory is only as good as the share of its pull requests that are actually right. Cradleworks
is measured against a fixed suite of graded tasks, so a change to the core, the prompts, the rules
or the model can be judged by numbers rather than by impressions.

This page is about Cradleworks' own suite. To measure the factory on your own code, see
[Measure your own factory](measuring.md).

## The suite

The suite has **30 tasks on two reference projects** built for it: a Java and Spring Boot service
with a React front end, and a Node and TypeScript service with a client library in a second
repository. Each project has the kinds of difficulty real codebases have, such as conventions
nobody wrote down, code without tests, rules enforced by architecture tests, and changes that
span modules or repositories.

| Type | Tasks |
| --- | --- |
| Feature | 12 |
| Bug fix | 8 |
| Refactor | 6 |
| Dependency upgrade | 4 |

By size, the suite has 12 small, 12 medium and 6 large tasks.

Each task has three parts:

- **the issue text**, which is all the factory ever sees
- **hidden tests** that decide pass or fail, which the factory never sees
- **a reference solution**, which proves the task can be solved

The tasks, hidden tests and grader live in a separate, private repository. Factory sandboxes have
no credentials for it, so no run can read the hidden tests. Only the issue text leaves it. Every
task is checked before it counts: its hidden tests must fail on the starting commit and pass with
the reference solution.

## How grading works

1. The factory gets only the issue text, and runs as a team would use it: the issue goes through
   spec, plan, build, verify and merge.
2. The grader checks out the result, adds the hidden tests, and runs the project's full test suite
   in the project's image.
3. **Pass** means the hidden tests ran and passed, and the project's existing tests still pass. A
   run where no hidden test executed counts as a fail, never a pass.

Each result also records the merged change's hygiene, which the pass rate can't see: files changed
only in whitespace, lockfile churn, and duplicated tests.

## Results

| Date | What ran | Score |
| --- | --- | --- |
| 2026-11-22 | Build only, each task handed straight to the coding agent | 26 of 29 |
| 2026-11-22 | Build and Verify, with rework | 26 of 29 |
| 2026-11-23 | The full pipeline from issues, three runs of the same factory | 21, 21 and 19 of 30 |
| 2026-11-23 | The full pipeline, after the tester fix below | **25 of 30**, every merged change clean |

The single-repository runs used 29 of the tasks; the full pipeline uses all 30. Runs used
Claude Code with `claude-sonnet-5-5`. The first baseline cost $2.27 for all 29 tasks, and its
median task took 82 seconds.

**Runs vary.** The same factory scored 19 to 21 across three runs, so a single run is meaningful
only outside that band, and one task changing is not a signal. Changes to the factory are judged
against that band.

**What the measurements changed.** The full pipeline first scored below the build-only baselines.
The failures showed why: the tester sometimes wrote acceptance tests that were themselves wrong.
The tester now reviews a disputed test once before it counts, which took the score from the 19 to
21 band to 25.

**What is left.** The remaining failures are mostly requirements a codebase implies but no task
states and no test checks, such as a change that is correct on its own but adds a dependency
between two modules that should stay apart. A reviewer prompt alone hasn't fixed these. Rules the
project can check, such as a dependency rule enforced by a test, are the likelier fix, and are
what [project rules](customizing.md) are for.

## The reviewer drill

A pass rate measures outcomes. On these tasks, a weaker reviewer often scores as well as the real
one, because it only matters when the coding agent makes a mistake for it to catch. So the
reviewer is also checked directly. `factory review` hands it changes the factory didn't build:
known-wrong changes it must send back, and correct ones it must pass. That costs about $0.60 and
catches a weakened reviewer that the pass rate misses. You can drill your own reviewer the same
way with `factory drill` ([guide](verify-and-approve.md)).

## Build your own suite

The same shape works for your projects: issue text the factory sees, hidden tests it doesn't, a
reference solution that proves each task is solvable, and a grader that runs on the result.
`factory eval` does this for you, and `factory eval mine` builds tasks from your own merge history.
See [Measure your own factory](measuring.md).

# Measure the factory

A factory is only as good as the share of its PRs that are actually right. Cradleworks is measured
against a fixed suite of graded tasks, so a change to the core, the prompts, the rules or the model
can be judged by numbers rather than by impressions.

## The eval suite

The suite has **30 tasks on two purpose-built reference projects**:

| Project | Stack | Built-in difficulties |
| --- | --- | --- |
| Orders service | Java 21, Spring Boot, React, Postgres, Flyway | an untested legacy billing module with odd conventions; a timing-dependent flaky test; changes that cross modules; "no raw SQL" and "audited endpoints" rules enforced by architecture tests |
| Notifications service | Node, TypeScript, queue worker, REST | a versioned public API that must not break, checked against released clients; an async retry path; a pinned dependency with a known vulnerability; a second repository for a change that spans two repos |

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

The suite lives in a separate, private repository. Factory sandboxes have no credentials for it,
so no run can read the hidden tests. Only the issue text leaves it.

**Each task is checked before it counts.** Its hidden tests must fail on the starting commit and
pass with the reference solution. Where a task has a known wrong answer, such as an upgrade that
skips the vulnerable dependency, that wrong answer is stored too and must fail.

## How grading works

For each task:

1. The factory gets only the issue text and runs `factory submit` on the reference project.
2. The grader checks out the branch the factory pushed, adds the hidden tests, and runs the
   project's full test suite in the project's image.
3. **Pass** means the hidden tests ran and passed, and the project's existing tests still pass.
   A run where no hidden test executed counts as a fail, never a pass.
4. The project has a deliberately flaky test. If a run fails only in tests outside the hidden
   set, the grader retries once and names the flaky test. A failure in a hidden test is never
   retried.

## First baseline (2026-11-22)

This is milestone M1 (the Build station only, with no Verify step), running Claude Code with
`claude-sonnet-5-5` under a $5 and 30-minute limit per task, on the 29 tasks that touch one
repository.

**26 of 29 passed.** The 29 runs cost **$2.27** in total, the most expensive task cost $0.22, and
the median run took **82 seconds**.

| Type | Passed |
| --- | --- |
| Bug fix | 8 / 8 |
| Feature | 10 / 11 |
| Refactor | 5 / 6 |
| Dependency upgrade | 3 / 4 |

The three that didn't pass:

- **A feature on a vulnerable dependency.** The feature worked, but the agent built it on the
  pinned version with a known vulnerability instead of upgrading.
- **A major framework upgrade.** Everything compiled and the existing tests passed, but the new
  version silently changed a field in every error response, which breaks callers.
- **A "tidy up" refactor.** The agent judged, reasonably, that the code was already as simple as
  it could safely be, and changed nothing. The factory records that as a failed build.

What we took from it:

- **The suite is too easy for a strong agent** when the work is fully stated. Both real failures
  were requirements the codebase implied but the issue didn't say. Harder tasks should lean that
  way.
- **The Verify station is where the remaining failures would be caught.** A reviewer agent that
  checks dependencies and API compatibility against project rules targets exactly these two.
- **Graders hit flaky tests too.** The planted flaky test failed twice while grading correct
  code, so the grader now retries non-hidden failures once and reports them.

## Running it

The eval tooling lives in the private eval repository: the grader, a script that submits each
task's issue text and grades the branch, and dated result files. The plan for M5 is to run the
suite on every core change and block changes that lower the pass rate.

If you build your own suite for your own projects, the shape above carries over: issue text the
factory sees, hidden tests it doesn't, a reference solution that proves each task is solvable,
and a grader that runs on the pushed branch.

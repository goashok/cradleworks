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

## With Verify: the M2 baseline (2026-11-22)

The same 29 tasks through milestone M2: Build, then Verify (the project's checks, CI, and a
reviewer agent that reads the diff against the project's rules), with rework when the reviewer
sends a change back.

**26 of 29 passed again**, though not the same 26: the "tidy up" refactor now made its change and
passed, and a large refactor that passed in M1 failed. What M2 adds is Verify's own verdict, and
how often it matches the grader:

| | Grader: pass | Grader: fail |
| --- | --- | --- |
| Verify: ready to merge | 22 | 3 |
| Verify: escalated or failed | 4 | 0 |

- **The three wrong "ready" verdicts are the requirements nobody wrote down**: the vulnerable
  dependency, the framework upgrade that changed error responses, and a module boundary that
  meant "no imports at all" rather than "not these classes". The reviewer judges against the
  project's rules, and no rule said any of this. Writing such rules down (no dependency with a
  known vulnerability; error responses are part of the API; what a module boundary means) is the
  cheapest fix, and the next thing to measure.
- **Two of the four wrong rejections were infrastructure**: a reviewer killed for memory, and a
  reviewer that answered without its verdict block. Both escalated to a person rather than
  passing, which is the safe failure.
- **Rework rounds paid off**: three tasks went through one or two; two of them then passed.
- **A usage limit stopped a whole batch.** On a subscription, every build after the five-hour
  limit failed. The factory now pauses on a usage limit instead (`factory retry` resumes).

## From issues: the M3 exit check (2026-11-22)

The same tasks can be run the way a team would use the factory: each task's issue text is filed
as a GitHub issue, and `factory watch` takes it through spec, plan, build, verify and merge. All
gates were `ai`, with auto-merge into a throwaway branch at the task's base commit. The grader
then grades that branch after the merges.

| Task | What it needed | Result |
| --- | --- | --- |
| orders-011 (medium) | one test change in one repo | 1 task, 1 PR merged, **pass** (4 hidden tests) |
| notifications-006 (large) | a service endpoint and a client release, in two repos | spec rewritten once by the spec check, 2 tasks, 2 PRs merged, **pass** (22 hidden tests) |

The tester's acceptance check ran and passed on every task. The first notifications-006 attempt
failed, and the failure was useful. The spec agent wasn't told about the related client repo,
so it narrowed the spec to the service. It is told now. That's the kind of gap only a real run
finds.

## The learning loop: M5 (2026-11-23)

**How much a run moves on its own.** The same factory (9b4ef0d), run three times on all 30 tasks
in issue mode, scored 21, 21 and 19. Fourteen tasks passed every time, five never did, and eleven
went either way. So a single run is only meaningful outside **19 to 21 of 30**, and one task
changing is not a signal.

**The full pipeline started below the M1 and M2 baselines.** Those runs handed each task straight
to Build and scored 26 of 29. Going through an issue, a spec, a plan, a tester and gates scored
lower, and the failure tags said why: the tester wrote wrong acceptance tests on five or six tasks
a run, and the reviewer let through changes that broke an unstated requirement.

**What moved it.** Each change got a small check on the tasks it targets, then a full run
compared with the band, and was kept only if it helped:

| Change | Full run | Kept |
| --- | --- | --- |
| Tester reviews a disputed acceptance test once and writes fewer wrong ones; the reviewer is rerun when its verdict is lost (9dda1df) | **25 / 30**, holdout 5 / 6; no wrong-test failures; six tasks newly passing, none newly failing | yes |
| Agent answers are read even when a string holds a brace, e.g. a plan quoting `{{#if x` (444d1c1) | Smoke set: **5 / 8**, nothing flagged; the same 8 tasks scored 3 to 5 before. notifications-005, blocked in every earlier run, now merges and fails only its vulnerable-dependency check | yes |
| Reviewer told to list every requirement, compare behaviour before and after, and check module dependencies (branch `reviewer-method`) | not run: the small check caught none of the three false accepts it targets | no |

**What is left.** Three changes still merge while breaking a requirement no test in the project
checks: a new dependency from billing to orders that makes the two depend on each other
(orders-014), a field lost from error responses in a framework upgrade (orders-015), and a Node
upgrade that leaves the sandbox image on the old version (notifications-014; when it does change
the image, the change correctly waits for a person). A reviewer prompt has not fixed these;
a check that the project can run, such as a dependency-cycle rule, is the likelier fix. One task, orders-012, stops
because its spec added an edit to the project conventions nobody asked for; edits there always
wait for a person.

**What the pass rate can't see.** The grader asks only whether the hidden tests pass, so a
reviewer that sends back a duplicated test or a churned lockfile earns nothing in the score. Each
result now also records the merged change's hygiene: files changed only in whitespace, a lockfile
changed when the reference solution changes none, and a duplicated test. Every merged change from
the real reviewer in the three noise runs and the tester-fix run was clean; with the reviewer told
to pass everything, notifications-005 merged a test file with two whole blocks copied verbatim,
the same fault the real reviewer sent back on notifications-006.

**Catching regressions.** `scripts/scheduled.ts` in the eval repository runs the smoke set, or the
full suite, on a pinned checkout of a commit, and judges it against the history. A task is flagged when it passed at least two of its last three runs and fails
twice now; a full run is flagged when it scores below the lowest of the last three. The exit check
made two changes on purpose. A docs-only change was skipped, as it should be. A reviewer told to
pass everything was **not** flagged, because the real reviewer misses the same broken changes, so
there was nothing for the alarm to see. That is a finding about the reviewer, not the alarm.

The rule then learned hygiene: a run is also flagged when more of its merged changes are untidy
than in any of the last three. Re-judged, it flags the first weakened-reviewer run (one untidy
change against none). A fresh full run of the weakened reviewer on 2026-11-23 was **not** flagged:
it scored 26 of 30, the best yet, and all 29 merged changes were clean. The reviewer passed all 44
changes it saw, where the real one sent back 4 of 47 in the tester-fix run, but this time the
implementer made no mess for it to miss. So the alarm catches a weakened reviewer only when the
implementer happens to need one; what it measures is outcomes, and on these 30 tasks a missing
reviewer seldom changes them. The only signal that always moved was the reviewer's own send-back
count.

## Running it

The eval tooling lives in the private eval repository: the grader, a script that submits each
task's issue text and grades the branch, one that files tasks as issues for `factory watch`, and
dated result files, and the runner above. Run it by hand after changing the factory:
`node scripts/scheduled.ts smoke --ref main --force` for the smoke set on that commit, or
`node scripts/scheduled.ts weekly` for all 30. `scripts/schedule/install.sh` can run both on a
schedule instead; it is not installed.

If you build your own suite for your own projects, the shape above carries over: issue text the
factory sees, hidden tests it doesn't, a reference solution that proves each task is solvable,
and a grader that runs on the pushed branch.

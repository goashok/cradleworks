# Measure your own factory

Every part of the factory you can change (a model, a rule, a prompt addition, a skill, an agent
check) can make it better or worse on your code, and you can't tell which by watching a few runs.
This guide shows how to measure it the way Cradleworks measures itself:

1. **An eval suite**: tasks on your project with a known right answer the factory never sees.
2. **Config variants**: one change at a time, run against the factory as it is.
3. **The noise band**: how far the same factory's score moves on its own, so you only act on a
   change that moves it further.
4. **`factory stats`**: what happened on real work, between eval runs.

For the reviewer and agent checks, there's a cheaper measure too: [drill
cases](verify-and-approve.md#drill-your-checks).

## 1. Write a suite

A suite is a folder **outside your project's repository**, for example a private repository of
its own. The factory's agents must never be able to read the hidden tests: if they could, a pass
would mean nothing. Only a task's issue text is ever handed to the factory.

```text
my-suite/
  suite.yaml
  tasks/
    search-customers/
      task.yaml
      issue.md            # the only thing the factory sees
      hidden/             # tests copied over the factory's result, at the same paths
        src/test/java/com/example/hidden/CustomerSearchTest.java
      solution.patch      # a reference solution
      wrong/              # optional: plausible wrong solutions
        case-sensitive.patch
```

`suite.yaml`:

```yaml
repo: ../my-service          # your project: a path from this folder, or a clone URL
sets:
  smoke: [search-customers, fix-rounding]
grade:
  command: ./mvnw -B -q test # default: the project's stack.build, then stack.test
  reports: [target/surefire-reports]   # optional: JUnit XML folders, from the project root
  hidden: '\.hidden\.'       # optional: which test cases are hidden (default: "hidden" in the path)
  timeout_minutes: 30
```

`task.yaml`:

```yaml
base_commit: 3f2c1e9         # the commit the factory starts from; required
type: feature                # optional, for your own reading
size: small
expect_base: fail            # or pass, for a refactor whose tests already pass at the base
grade:                       # optional: overrides suite.yaml for this task
  command: npm test -- test/hidden
```

`issue.md` starts with `# The title`, then the request, written the way a person on your team
would write the issue. Don't mention the hidden tests.

**Grading.** The grader checks out the result on this machine, copies `hidden/` over it, and runs
the grading command in the project's `stack.image`, in a throwaway container with your user id and
a home folder kept between grades for build caches. JUnit XML written to the `reports` folders or
to `$GRADER_REPORTS` is read. With reports, a pass also needs hidden test cases to have run: a
change that skips or empties the tests doesn't pass by exiting 0. A failure only in your
project's own tests runs once more, since it may be a flaky test you already have; a failing
hidden test never does.

**JUnit reports by test runner.** Point `reports` at the folder your runner writes, or write to
`$GRADER_REPORTS`, which every grade sets:

| Runner | In the grading command |
| --- | --- |
| Maven Surefire | nothing: `reports: [target/surefire-reports]` |
| Gradle | nothing: `reports: [build/test-results]` |
| Vitest | `npx vitest run --reporter=default --reporter=junit --outputFile.junit=$GRADER_REPORTS/junit.xml` |
| Jest (with the `jest-junit` package) | `JEST_JUNIT_OUTPUT_DIR=$GRADER_REPORTS npx jest --reporters=default --reporters=jest-junit` |
| pytest | `pytest --junitxml=$GRADER_REPORTS/junit.xml` |

Put hidden tests where their path says so (for example `test/hidden/`), so the default `hidden`
pattern finds them in the report.

**Check every task before you use it:**

```sh
factory eval check my-suite             # or: factory eval check my-suite search-customers
```

It grades the base commit (the hidden tests must fail there, or pass with `expect_base: pass`),
the reference solution (they must pass) and each wrong solution (they must fail). A task that
passes at its base measures nothing; one that fails with its solution counts right answers as
wrong. A wrong solution that passes means the hidden tests are too loose: tighten them until it
fails. This costs nothing, since no agent runs.

**How many tasks.** Ten good tasks tell you more than thirty weak ones. Mix features, bug fixes,
refactors and dependency changes, and make each one exercise something that's easy to get wrong
in your codebase: a convention, a contract other code relies on, a part with no tests.

## 2. Run it

```sh
factory eval run my-suite @smoke --label base-1
factory eval run my-suite @smoke --label base-2
```

For each task, the factory works on a **scratch copy** of your repository, never the repository
itself: a bare clone whose `main` is the task's base commit. It runs `factory submit` there with
its own state folder, as a person would. Whatever your `factory.yaml` says, an eval run uses local
git with no CI or tracker, and the change gate is decided by the reviewer and merged, so a run
needs no one. When it stops, the merged result is graded. A task **passes** only when the factory
merged its change and the hidden tests pass on it.

Results go to `my-suite/results/<date>-<label>.jsonl` (or `--out`), one line per task: the
outcome, rework rounds, cost, the grade, and the factory's commit. A rerun with the same file
skips tasks already in it. Each task's scratch copy, factory state and log stay in
`results/<label>.d/<task>/`, so you can replay a run with `CRADLEWORKS_HOME=results/<label>.d/<task>/home factory log <id>`.
`--jobs <n>` runs several tasks at once.

A run spends real money: about what the same tasks would cost as real work. Run one task first,
then a set of two or three. Agents use the same credential as `factory submit`; when both an API
key and a subscription token are set up, the API key wins unless you set
`CRADLEWORKS_CLAUDE_AUTH=subscription` (or `api_key`).

## 3. Try a variant

A variant changes one thing:

```yaml
# opus-reviewer.yaml
name: opus-reviewer
description: A stronger model for the reviewer
config:                    # laid over .factory/factory.yaml; null removes a key
  runtime:
    roles:
      reviewer: { model: claude-opus-5-5 }
```

```yaml
# no-migrations-skill.yaml
name: no-migrations-skill
files:                     # files in the repository: new text, { from: <file> }, or null to remove
  .factory/skills/migrations: null
config:
  runtime: { roles: { implementer: { skills: [] } } }
```

A variant can change anything under `.factory/`: a model or agent per role, a rule, a prompt
addition, a skill on, off or at another version, an agent check. It can't change the gates, which
every eval run sets itself.

```sh
factory eval run my-suite @smoke --variant opus-reviewer.yaml
```

The results record the variant's name and a hash of its content.

## 4. Compare

```sh
factory eval compare --base results/2026-11-23-base-1.jsonl --base results/2026-11-23-base-2.jsonl \
  --variant results/2026-11-23-opus-reviewer.jsonl
```

```text
Noise band: the factory as configured scored 6 to 7 of 10.
Verdict: within the noise. The variant's score is inside the band (or its runs disagree), so this
says nothing either way. Keep the change only for another reason, or measure on more tasks.
Cost per run: $14.10 as configured, $19.80 with the variant.

Per task (passed / runs):
  fix-rounding  0/2 as configured, 1/1 with the variant  ← better
  ...
```

Agents are not deterministic, so the same factory scores differently from run to run. The **noise
band** is the range of its scores over two or more runs. A variant is **better** only when every
one of its runs scores above the band, **worse** only when every one scores below it. Anything in
between is noise, however different the numbers look. The comparison only counts tasks every run
has.

When every run passed every task, compare says so: the tasks are too easy to tell the two
apart, and you need harder ones. When nothing passed, the tasks are too hard or the grading is
broken; run `factory eval check`.

This is the rule Cradleworks uses on itself: on its own suite the same factory scores 19 to 21 of
30, and a change is kept for its score only when it lands outside that.

## 5. Watch real work: `factory stats`

Your suite is small, so what happens on real work matters as much:

```text
$ factory stats --days 30 --project my-service
my-service: work received 2026-10-24 to 2026-11-23
  work items       14 (11 merged, 2 escalated, 1 cancelled)
  tasks            19: 15 merged, 2 escalated, 0 failed, 1 cancelled, 1 open
  first time       9 of 15 merged tasks (60%) passed Verify and the gate the first time
  rework           0.6 rounds per merged task
  Verify           27 runs: 16 passed (59%), 9 sent back (33%), 2 escalated (7%)
  gate change_approval: 16 decided, 15 approved, 1 sent back, 16 by a person
  agent check security: 27 runs, 2 sent back, 0 escalated, 0 couldn't check
  cost             $41.30 in all, $2.75 per merged task
  time to merge    median 3.4 h from the request

  By factory config (the .factory/ tree Verify ran under):
    4be1a07c2d  2026-10-24 to 2026-11-09: 15 Verify runs, 8 passed (53%)
    9c03e1aa71  2026-11-10 to 2026-11-23: 12 Verify runs, 8 passed (67%)
```

Each Verify records the git tree of `.factory/` on the base branch it ran under, so when you change
the factory's setup the numbers split by config. That shows drift between eval runs. It isn't a
controlled comparison (the work differs), so confirm a change with the suite. `--json` gives the
same numbers as one object.

## What to measure when

| You changed | Run |
| --- | --- |
| A check's skill, model or prompt addition | `factory drill`, a few cents |
| The reviewer's or implementer's model, a rule, a skill, a prompt addition | a variant on the smoke set, then the full suite if it looks better |
| Nothing, but results seem worse | `factory stats`, then the suite as configured |
| A new Cradleworks version | the suite as configured, twice, against your last band |

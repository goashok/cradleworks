# Verify, rework and approve

After the agent opens a pull request, the factory checks the work before anyone is asked to look
at it. If the change isn't good enough, it goes back to the agent with the reasons. Only a change
that passes reaches you, at the **change gate**.

```text
          ┌──────────────────────── rework (with the reasons) ───────────────────────┐
          ▼                                                                          │
 task ─► Build ─► PR ─► Verify ─┬─ pass ────► change gate ─► approve ─► merge          │
                                ├─ rework ───────────────────────────────────────────┘
                                └─ escalate ─► you: retry, or cancel
```

## What Verify does

Verify runs on the pushed branch in a **fresh sandbox**, never the one the agent worked in. What
it checks is exactly what's on the branch, built from a clean checkout. It runs three steps:

1. **The project's checks.** Every `stack` command in `factory.yaml` runs in turn: `build`
   first, then `lint`, `test`, and any named extras such as `contract_test`. If the build fails,
   the rest are skipped. A test command that fails once and passes on a second run is marked
   **flaky**: it doesn't send the task back, and the evidence says so.
2. **CI.** With `ci: github-actions`, Verify waits for every workflow run on the pushed commit:
   up to 3 minutes for a run to start, and up to 20 minutes for runs to finish. It waits while
   the checks and the review run, so the waits overlap. A repo with no workflow for that commit
   is fine: the evidence records "no CI run".
3. **The reviewer.** A second agent reads the task, the project rules, the diff and the check
   results, and judges the change. It may not edit files. It answers **pass**, **rework** (with
   concrete reasons) or **escalate**, plus a risk rating. It runs only when the checks pass,
   because there's no point reviewing a change that doesn't build.
4. **Agent checks**, if the project has any (see [Agent checks](#agent-checks)): further
   reviewers with one focus each, run after the reviewer on the same sandbox.

The verdict follows from those steps in this order:

| Finding | Verdict |
| --- | --- |
| A check failed or timed out | rework, with the output |
| CI failed | rework, with the failing jobs' logs |
| CI still running after 20 minutes, or CI unreadable | escalate |
| The reviewer says rework or escalate | the same, with its reasons |
| The reviewer passes the change but rates it **high** risk | escalate |
| The reviewer or a blocking agent check escalates, or a blocking check couldn't check | escalate |
| The reviewer or a blocking agent check says rework | rework, with every one's reasons |
| The reviewer's answer can't be read | escalate (never pass) |
| Everything passes | pass |

## The evidence

Each Verify run records its **evidence**: the commit it checked, each check with its result and
time, the CI runs, the reviewer's verdict, risk and reasons, and the cost. You'll find it in three
places:

- **as a comment on the pull request**, one per Verify run:

  ```text
  Cradleworks verification: ✅ Passed
  Commit b9ccd6836f76 · attempt 1 · checks passed, CI passed, reviewer passed (low risk)
  | build | ✅ passed | 12 s |   | test | ✅ passed | 41 s |   | CI | ✅ passed |
  Reviewer (claude-sonnet-5-5): pass, low risk
  ```

- **in `factory status <id>`**: `verify  pass at b9ccd6836f76 …` plus the checks, CI and reviewer
  line
- **in `factory log <verify-run>`**: `check`, `review`, `ci` and `verdict` lines, with
  `--full` for outputs and every reason

## Verifying again by hand

If you push a fix to a task's branch yourself, `factory verify <task-id>` judges the branch as it
stands, without building. It applies the hard rules (secret scan, protected paths) to the whole
branch, then runs Verify. See [`factory verify`](../reference/cli.md#factory-verify-task-id).

## Rework

When Verify says rework, the factory builds again **on the same branch**. The agent gets the
original task plus a rework section: the failed checks' output, the CI logs, or the reviewer's
reasons. Its new commit goes to the **same pull request**, titled `… (rework 1)`, and Verify runs
again.

The loop stops at `budgets.max_rework_loops` (default 3). After that, the task **escalates** to
you instead of looping forever.

## The change gate

When Verify passes, `gates.change_approval` decides what happens:

| Setting | What happens |
| --- | --- |
| `human` (default) | The task waits as `ready`. `submit` ends with `Ready for review` and the commands to use. |
| `ai` | The reviewer's pass counts as approval, recorded as decided by `reviewer (<model>)`. |
| `skip` | Approved with no decision, recorded as skipped. |

Then `gates.auto_merge` decides whether the factory merges (default `false`).

As the human at the gate, you have these options:

```sh
factory approve <task-id>                  # approve; merge it yourself on the PR
factory approve <task-id> --merge          # approve and squash-merge now
factory reject  <task-id> --reason "Use the existing Clock, not Date.now()"
                                           # back to rework; your reason is the feedback
```

Or work on the pull request as usual, then run `factory sync` in the project:

- An **approving review** after the last Verify counts as approval.
- **Request changes** sends the task back to rework, with your review text as the feedback.
- **Merging** the PR yourself records the task as merged.
- **Closing** the PR cancels the task.

`sync` only records these. Run `factory resume <task-id>` to start the rework.

**A merge is refused if the PR's head has moved** since Verify passed it, for example after
someone pushed another commit. The factory only merges the exact commit it verified.

## When a task escalates

A task escalates when it needs a person:

- **The agent declined.** It finished without changing anything and explained why, for
  example "this code is already as simple as it can safely be". That's often a sensible
  answer, so the factory asks you instead of failing the task.
- **Rework ran out.** The limit was reached and the change still doesn't pass.
- **Verify couldn't decide.** CI timed out, the reviewer flagged high risk, or Verify itself
  couldn't run.

`factory status <id>` shows why. Then:

```sh
factory retry <task-id> --note "Make the change anyway: drop the unused helper"   # one more attempt
factory retry <task-id> --loops 2                  # two more attempts
factory cancel <work-item-id> --reason "Not needed"
```

The `--note` reaches the agent as feedback. `retry` continues the task straight away. Add
`--no-run` to only record it.

## Agent checks

Some things you want checked aren't "is this change right?" but "did it get one thing right?":
a security audit, an accessibility pass, migration safety. A command in `stack` checks what a
machine can. An **agent check** is a further reviewer with one focus, given a
[skill](add-a-project.md#skills) that says what to look for, whose verdict counts as one of
Verify's checks:

```yaml
verify:
  agent_checks:
    security:
      skill: security-review    # in .factory/skills/; vendor it with factory skills add
      blocks: true              # its rework sends the change back; false = only reported
      max_share: 0.25           # of budgets.per_task_usd, per Verify run (the default)
      model: claude-opus-5-5    # optional; agent: too. Default: the reviewer's
```

Each check runs after the reviewer, on the same checkout and with the same input (task, spec,
check results), read-only. It gets the project rules and its skill whole, not the reviewer's own
skills or prompt addition, and answers in the reviewer's format. Checks run one after another,
in file order.

| The check says | Blocking | Advisory |
| --- | --- | --- |
| pass | counts as passed | reported |
| rework | sends the change back; its reasons go to the implementer under its name | reported on the PR and in the evidence |
| escalate, or couldn't check | the task escalates to a person | reported |

"Couldn't check" means its run failed, its verdict couldn't be read twice, or it reached its
`max_share` ceiling. It never counts as a pass. Rework from a check counts toward
`max_rework_loops` like any other. A check's spend comes out of the task's `per_task_usd`, so a
task never costs more than its cap however many checks you add; `max_share` keeps one slow
check from using what rework needs.

**A blocking check must show it can block.** A weakened check doesn't make the pass rate drop;
it just stops catching things. So a check set to `blocks: true` runs as advisory until
`.factory/drill/<check>/` has at least one known-bad case, and `factory validate` says so. See
[Drill your checks](#drill-your-checks).

## Drill your checks

Drill cases are changes whose verdict you know, kept in the repository:

```text
.factory/drill/
  security/
    sql-injection.patch     # known-bad: the security check must send it back
    sql-injection.md        # the task the change claims to do; the first line is its title
  reviewer/                 # optional: known-bad changes for the reviewer itself
  controls/
    add-endpoint.patch      # known-good: every check must pass it
    add-endpoint.md
  known-misses.txt          # "security/some-case  why": reported, not counted
```

Make a patch with `git diff` against your base branch, from a branch where you made the change.

`factory drill` hands each agent check its known-bad cases and every control, through
`factory review` (in a fresh sandbox, applied to the base branch, nothing pushed). The reviewer
joins when it has cases of its own; `--check <name>` drills one (or `reviewer`). The checks use
the skills and rules on the base branch, so to drill a skill change before merging it, pass
`--base <its branch>` after pushing it. The cases themselves are read from your checkout.

A known-bad case counts as missed only if the check passed it every time: a pass gets one
confirmation run, because one pass from a noisy judge says little. The drill **flags** a check
that missed a case, or sent back more than half the controls. A run that gives no verdict makes
the drill **inconclusive**, never a pass. Exit status: 0 every case judged right, 1 flagged,
2 bad usage or no cases, 3 inconclusive.

Run it when a check's skill, its model, or the rules change, since that's when a check can
quietly weaken. It costs a few cents per case. `factory review <patch> --title <text> --check
<name>` runs one check on one change.

## Choosing the reviewer's model

The reviewer uses the project model unless you set one for its role:

```yaml
runtime:
  agent: claude-code
  model: claude-sonnet-5-5
  roles:
    reviewer:
      model: claude-opus-5-5     # a stronger second opinion
```

## What Verify costs

The reviewer is a second agent run per attempt, with the same `budgets.per_task_usd` cap and a
15-minute limit. On the example project it added about 5 seconds and $0.01. Checks add the time
of your build and tests, and CI adds however long your workflows take.

`factory submit --build-only` skips Verify and stops after the PR, like milestone M1.

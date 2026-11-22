# Write good tasks

A task file is the whole specification the agent gets. (For work from GitHub issues, the Specify
station writes the spec for you: see [From an issue to merged PRs](issues.md).) With `submit`,
nobody asks follow-up questions: what you write is what gets built.

## The format

```markdown
# Title of the change

What to change, in plain words. As long as it needs to be.

Done when …
```

- The file must **start with a `# Title` heading**. Blank lines before it are fine, anything else
  isn't.
- The title becomes the PR title and the commit subject.
- Everything after the title is the description. It goes to the agent and into the PR body.

## What the agent is given

The agent gets these, in this order of authority:

1. **A fixed role prompt**: implement this task and only this task, keep the change small, read
   and follow the rule files, run the build and tests and fix what fails, don't commit or push,
   and finish with a summary.
2. **Your rules**: the `.factory/rules/*.md` files, by path, to read first.
3. **Your commands**: every `stack` command by name (`build`, `test`, `lint`, …).
4. **Your task**: title and description.
5. **The repository**, checked out at the base branch, which it can read and change freely.

It is **not** given anything else: no issue thread, no chat history, no other branches, and no
network beyond the allow-list.

## What makes a task work

**Say what "done" means, as something checkable.**

> Done when `GET /v1/notifications?createdAfter=…` returns only notifications created after that
> time, and an invalid timestamp gives a 400 with the usual error body.

**Name the observable behaviour, not the implementation**, unless the implementation is the
point. "Paying an order from the web UI calls `POST /api/orders/{id}/pay`" is better than "add an
onClick handler".

**Point at what's easy to miss.** In our evals, the two failures that caught a strong agent were
requirements the task didn't state but the codebase implied:

- A feature that needed a template engine missed that the pinned engine version had a known
  vulnerability.
- A framework upgrade missed that the new version silently changed a field in every error
  response.

If you know about such a trap, put it in the task. If it applies to every task, put it in a rule.

**Keep it to one change.** One task gives one PR. If the description has "and also", consider two
tasks, or file it as an issue and let the Plan station split it ([guide](issues.md)).

**Say when "no change" is a valid answer.** Asked to "tidy up" code that was already as simple as
it could safely be, an agent sensibly changed nothing and explained why. The factory records that
as **declined** and escalates to you with the agent's reason. Agree with `factory cancel`, or
insist with `factory retry <task> --note "…"`. Saying up front what to do in that case saves the
round trip.

**Write down what "done" means.** The reviewer in Verify reads the task and judges the diff
against it. A clear `Done when …` line is what it checks first.

## Sizes that work today

From the first baseline on two reference projects (Spring Boot + React, and Node/TypeScript):

| Kind | Passed | Examples |
| --- | --- | --- |
| Bug fixes | 8 / 8 | off-by-one retry limits, a race on concurrent orders, timezone in invoice numbers |
| Features | 10 / 11 | new endpoints, scheduling, webhook signing, discount codes, refunds |
| Refactors | 5 / 6 | introducing a `Money` type, decoupling modules, `Optional` instead of null |
| Dependency upgrades | 3 / 4 | Node 24, Postgres 18 (Spring Boot 4 failed) |

Most runs took one to two minutes and cost cents. See [Measure the factory](evaluating.md) for how
these were graded.

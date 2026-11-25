# Make it your team's

Out of the box, the factory's agents know how to write code, but not how your team writes it.
This page is the map: each kind of team knowledge, where it goes, and the guide that covers it in
full. Everything here lives in your repository's `.factory/` folder and is reviewed like code.

```text
.factory/
  factory.yaml            commands, gates, budgets, network, which skills each role gets
  rules/*.md              what every agent is told to follow
  prompts/<role>.md       how one role should work differently here
  skills/<name>/          instructions for one kind of work, vendored and pinned
  skills.lock             where each skill came from, and its hash
  drill/<check>/          changes with a known verdict, to prove a check still catches them
  specs/                  approved specs, committed by the factory
```

## Which one to use

| You want the agents to… | Use | Read |
| --- | --- | --- |
| Follow a convention every time ("SQL lives in `store.ts`", "never edit a migration") | A **rule** | [Write rules](add-a-project.md#3-write-rules) |
| Have one role work differently ("the reviewer checks every migration can roll back") | A **prompt addition** | [Prompt additions for one role](add-a-project.md#prompt-additions-for-one-role) |
| Follow a procedure for one kind of work, maybe with scripts (a house style, a testing recipe, a marketplace skill) | A **skill**, given to the roles that need it | [Skills](add-a-project.md#skills) |
| Check one thing on every change, with its own verdict (security, accessibility, migration safety) | An **agent check** in Verify | [Agent checks](verify-and-approve.md#agent-checks) |
| Know that a check still catches what it should | **Drill cases** | [Drill your checks](verify-and-approve.md#drill-your-checks) |
| Run a command on every change (lint, contract tests, a type check) | A **`stack` command** | [Write factory.yaml](add-a-project.md#1-write-factoryyaml) |
| Keep a person on certain files | **`protected_paths`** | [Configuration](../reference/configuration.md) |
| Know whether any of these helped | An **eval suite** and **`factory stats`** | [Measure your own factory](measuring.md) |

A rough order: start with two or three rules about what a newcomer would get wrong. Add a skill
when a rule turns into a procedure. Add an agent check when reviews keep catching the same kind
of problem, and give it a drill case before you make it blocking. Measure before and after any
change you're unsure of.

## A small example of each

A rule, `.factory/rules/conventions.md`:

```markdown
- Time comes from the injected `Clock`; never call `Date.now()` directly.
- Dependencies are pinned to exact versions.
```

A prompt addition, `.factory/prompts/reviewer.md`:

```markdown
Check that every new migration can be rolled back, and say so in your reasons.
```

A skill, vendored and given to a role:

```sh
factory skills add https://github.com/<owner>/<skills-repo>.git --path <folder> --ref <tag>
```

```yaml
runtime:
  roles:
    implementer:
      skills: [migrations]       # the agent opens it when the task calls for it
```

An agent check that uses a skill, with a drill case to prove it blocks:

```yaml
verify:
  agent_checks:
    security:
      skill: security-review
      blocks: true               # advisory until .factory/drill/security/ has a known-bad case
```

```sh
factory drill --check security   # a few cents a case
```

## What holds for all of them

- **Read from the base branch.** Agents get the rules, prompt additions and skills as they are on
  the base branch, never from the branch under work. A change takes effect once it's merged, and
  can't loosen the rules it's judged by.
- **A person reviews every change to them.** `.factory/` is always a protected path, so a pull
  request that touches it needs a person to approve and merge it, whatever the gates say.
- **They share one budget for context.** Rules, prompt additions and always-on skills share
  256 KB; anything that doesn't fit is dropped, and the run log says what.
- **Each run records what it used.** The run log, and the run page in `factory console`, list
  every rule, addition and skill an agent was given, with a hash, and which skills it opened.
- **`factory validate` checks them.** It catches rule patterns that match nothing, a skill that
  no longer matches its lock, a skill whose required tools are missing from the image, and a
  blocking check with no drill case.

## Ask as you go

`factory docs customizing` prints this page. `factory docs --search <words>` finds the section
you need, and `factory config explain <key>` explains a key with your value next to its default.
With the [skill for coding assistants](getting-help.md#ask-your-coding-assistant), your assistant
can walk you through setting up any of these, one step at a time.

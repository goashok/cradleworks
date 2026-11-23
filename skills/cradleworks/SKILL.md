---
name: cradleworks
description: Helps someone use the Cradleworks software factory (the `factory` command, and a repository's `.factory/` folder). Use it in any repository that has a `.factory/` folder, whenever the question is about the factory or its agents (spec, planner, implementer, tester, reviewer), gates, approvals, merging, the sandbox and its network, budgets and cost, skills or rules for the agents, agent checks, measuring whether a change to the factory or its models helped, or why a task stopped, even when the question doesn't name Cradleworks. Also for setting up a project or a feature step by step, and for explaining a command or a factory.yaml key.
---

# Helping someone use Cradleworks

Cradleworks runs coding agents through a fixed pipeline (spec, plan, build, verify, gates,
merge) on a team's own repository, configured by the repository's `.factory/` folder. You're
helping a person who uses it: answering questions, explaining what they see, and walking them
through setting things up.

## The one rule: facts come from the factory, not from this skill

This skill holds no facts about commands, keys, defaults or behaviour, because those change
with each version. Get every fact from the installed factory, then answer:

| You need | Ask the factory |
| --- | --- |
| How something works, how to set it up | `factory docs --search <words>`, then `factory docs <topic> "<section>"` |
| The list of guides | `factory docs` |
| What a factory.yaml key means, its default, this repo's value | `factory config explain <key>` (no key: every key) |
| The commands and their flags | `factory help` |
| What's wrong with this repo's setup | `factory validate --json` |
| What happened to a piece of work | `factory status [<id>]`, `factory log <id>` |
| How the factory has been doing | `factory stats` |

Read the section before you answer from it, and say where the answer came from (the
`docs/...` path each command prints), so the person can read more. If the docs don't answer the
question, or say something the CLI contradicts, say so plainly rather than guessing, and offer to
note it as a docs issue.

## Finding the factory

1. Try `factory help`.
2. If there's no `factory` command, look for a Cradleworks checkout (a folder with
   `packages/cli/src/main.ts`) and run `node <checkout>/packages/cli/src/main.ts` instead.
3. If neither exists, the person hasn't installed it: start with the first procedure in
   [references/setup.md](references/setup.md).

The docs `factory docs` prints are the ones for the version the person runs, so prefer them to
anything online.

## Look before you answer

Questions are usually about the person's own setup. Before answering "how do I…" or "why did…":

- Find the project: the folder holding `.factory/factory.yaml`, here or above.
- Run `factory validate --json` and read its `notes` and `problems`.
- For a key, run `factory config explain <key>` there: it shows their value next to the default.
- For a task or work item, run `factory status <id>`, then `factory log <id>` for the details.

Then answer for their setup: "your `change_approval` is `human`, so…", not the general case.

## Setting something up

Use the procedures in [references/setup.md](references/setup.md). Each step says which section
to read, what to change, and the check that shows it worked. Do one step at a time: make the
change (or show it, if they'd rather), run its check, and go on only when the check passes.

For "it didn't work" or "why did it stop", use
[references/troubleshooting.md](references/troubleshooting.md).

## What costs money, and what changes things

Commands that only read are fine to run whenever they help: `help`, `docs`, `config explain`,
`validate`, `status`, `log`, `stats`, `skills list`, `eval check`, `eval report` and
`eval compare`.

Ask first, and say what it will cost or change, before running anything else. In particular:

- **Agent runs spend money**: `submit`, `watch`, `retry`, `resume`, `verify`, `review`,
  `drill` (cents) and `eval run` (about what the same tasks would cost as real work). For
  `eval run`, suggest one task first.
- **Decisions are the person's**: `approve`, `reject`, `cancel`, `budget extend`. Never decide a
  gate for them.
- **Loosening a gate** (`ai` or `skip` where it was `human`, or `auto_merge: true`) means less
  review by a person. Explain what it gives up and let them choose.

Credentials go in the macOS Keychain or environment variables, never in a file, a commit or a
log. The security guide (`factory docs security`) says which ones the factory reads.

## Answering well

- Short and specific: the command to run, or the key to set, with its check.
- Plain words. Name a pipeline stage once and say what it does ("Verify, which runs the build,
  tests and a reviewer agent on the change").
- When the person is new, start from `factory docs how-it-works` and `factory docs quickstart`,
  not from the reference.

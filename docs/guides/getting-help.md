# Get help as you go

Three ways to find an answer without leaving your terminal. All of them read the docs and config
that came with the version of Cradleworks you run, so they match what your factory does.

## At the terminal

```sh
factory docs                                   # every guide and reference page
factory docs --search agent check drill        # the sections that mention those words
factory docs verify-and-approve "Agent checks" # one section
factory config explain gates.change_approval   # type, default, your value, and what it does
factory validate --json                        # what's wrong with this repo's setup, as data
```

`factory help` lists every command.

## Ask your coding assistant

Cradleworks comes with a skill, in `skills/cradleworks/`, for Claude Code and other assistants
that read the same skill format. With it, your assistant can:

- answer questions about the factory for your setup ("why did this task stop?", "can the agent
  reach pypi.org?");
- walk you through setting up a project, issues and gates, rules, skills for the agents, an
  agent check, or measuring a change, one step at a time, with a check after each step;
- explain a key or a command.

It gets its answers from `factory docs`, `factory config explain` and `factory validate`, and
only runs commands that read without asking you first. Anything that spends money or decides a
gate (`submit`, `watch`, `drill`, `eval run`, `approve`) it asks about first, and says what it
will cost.

To install it for every project, link it into your assistant's skills folder. From your
Cradleworks checkout:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/cradleworks" ~/.claude/skills/cradleworks
```

Or, for one repository only, link it into that repository's `.claude/skills/` instead. Because
it's a link, updating your Cradleworks checkout updates the skill too.

The skill needs the `factory` command: the alias from the [quick start](../quickstart.md), or
`node <checkout>/packages/cli/src/main.ts`.

## When the docs are wrong

If an answer doesn't match what the factory did, the docs are wrong or out of date. Please open
an issue with what you ran, what happened and what you expected.

# Setting things up, step by step

Each procedure is a list of steps. For each step: read the section named (with
`factory docs <topic> "<section>"`), make the change it describes for this person's project,
then run the check. Go on only when the check passes. If it fails, read what it says, fix that,
and run it again; `factory validate` names the file and line.

The sections hold the details (keys, values, examples). This file only holds the order and the
checks, so if a step and its section disagree, follow the section.

## First run: from nothing to a merged change

For someone new to Cradleworks. Uses the example project, so nothing of theirs is touched.

1. **Prerequisites.** Read `factory docs quickstart "What you need"`. Check each tool is there
   (`node --version`, `docker info`, `git --version`) and say which are missing; don't install
   system software without asking.
2. **Install.** `factory docs quickstart "1. Install Cradleworks"`. Check: `factory help` prints
   the commands.
3. **Credential.** `factory docs quickstart "2. Give the agent a credential"`. Help them store it
   in the Keychain or an environment variable; never write it to a file. Check: the next steps
   report no missing credential.
4. **Example project.** `factory docs quickstart "3. Set up the example project"`, then
   `factory docs quickstart "4. Check the setup"`. Check: `factory validate` prints `ok`.
5. **First task.** `factory docs quickstart "5. Submit the task"`. This runs agents and costs a
   little; say so first. Check: the output ends at the change gate with a pull request.
6. **Look and approve.** `factory docs quickstart "6. Look at what it did"`, then
   `factory docs quickstart "7. Approve and merge"`. Let them read the evidence and decide.
7. **Next.** Point them at `factory docs how-it-works` for the ideas, and the next procedure to
   use their own repository.

## Their own repository

0. **The quick way.** `factory docs add-a-project "The quick way: factory init"`. `factory init`
   writes all of the steps below and checks them in Docker. With an agent it costs up to $2
   (`--budget`), so say so; with `--no-agent` it is free. Check: it ends with "its checks pass",
   then `factory validate`. Use the steps below to understand or change what it wrote.
1. **factory.yaml.** `factory docs add-a-project "1. Write factory.yaml"`. Fill `stack.build`
   and `stack.test` from how they build and test today. Check: `factory validate` (an image
   that isn't built yet is a note, not a problem).
2. **Sandbox image.** `factory docs add-a-project "2. Build a sandbox image"`. Check:
   `factory validate` no longer notes the image as missing.
3. **Rules.** `factory docs add-a-project "3. Write rules"`. Start from what reviewers on their
   team say most often. Check: `factory validate` counts the rule files.
4. **Their source control.** `factory docs add-a-project "4. Switch to GitHub"`. Check:
   `factory validate --json` shows the adapters they chose and no problems.
5. **First real task.** `factory docs writing-tasks "What makes a task work"`, then help them
   write a small task file. `factory docs add-a-project "5. Validate and run"`. Costs money: say
   so. Check: `factory status` shows it at the change gate, or why it stopped.

## Taking work from issues

1. `factory docs issues "Set it up"`. Check: `factory validate --json` has no tracker note.
2. `factory docs issues "Gates"`: go through each gate with them and let them choose. Check:
   `factory config explain gates` shows their values.
3. `factory docs issues "What happens on the issue"`, so they know what to expect, then
   `factory watch --once`. Costs money: say so.

## Prompt additions for one role

1. `factory docs add-a-project "Prompt additions for one role"`.
2. Check: `factory validate` (a file not named for a role is a problem).

## Skills for the factory's agents

These are skills the factory gives its own agents, not this skill.

1. `factory docs add-a-project "Skills"`. Vendor with `factory skills add`; give it to roles in
   factory.yaml.
2. If the skill needs tools in the image, record them with `factory skills require`.
3. Check: `factory validate` (it runs the requirements in the image) and `factory skills list`.

## An agent check in Verify

1. `factory docs verify-and-approve "Agent checks"`. Help them choose the skill and whether it
   blocks. Check: `factory config explain verify.agent_checks.<name>`, with their check's name.
2. `factory docs verify-and-approve "Drill your checks"`. A blocking check runs as advisory until
   it has a known-bad drill case: help them write one from a real mistake, and a control. Check:
   `factory validate`.
3. `factory drill --check <name>`. Costs cents. Check: it exits 0.

## Measuring a change to the factory

1. `factory docs measuring "1. Write a suite"`. The suite lives outside their repository. Check:
   `factory eval check <suite>` (no agents, no cost); every case must say `ok`.
2. `factory docs measuring "2. Run it"`. One task first. Costs money: say so.
3. Run the factory as configured at least twice, then the variant
   (`factory docs measuring "3. Try a variant"`).
4. `factory docs measuring "4. Compare"`, and read the verdict with them. Inside the noise band
   means no evidence either way.
5. Between suite runs: `factory docs measuring "5. Watch real work: factory stats"`.

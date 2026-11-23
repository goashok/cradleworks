# When something didn't work

Find out what happened before explaining it. Every step here only reads.

## The setup is refused

1. `factory validate --json`. `configErrors` give the file and line; `problems` say what to fix.
2. For a key in an error: `factory config explain <key>` gives the allowed values and the default.

## A task stopped, escalated or failed

1. `factory status <id>`: where it is, and why it stopped.
2. `factory log <id>`: every step, and the run that failed.
3. Read the part that matches:
   - `factory docs runs-and-logs "When a run fails"`
   - `factory docs verify-and-approve "When a task escalates"`
   - `factory docs verify-and-approve "Rework"`
   - `factory docs issues "When it stops"`, for work from an issue
4. Tell them what happened and their choices (retry, change the task, decide the gate). The
   decision is theirs.

## A budget was reached

`factory docs runs-and-logs "Status: where is everything?"`, then
`factory config explain budgets` for their limits. `factory budget` shows spend; raising it with
`factory budget extend` spends more, so it's their call.

## The agent can't reach something

`factory docs security "The boundary"`, then `factory config explain sandbox.network.allow`.
Adding a host widens what agents can reach: explain that and let them decide.

## The results seem worse than before

`factory stats` (split by factory config when it changed), then
`factory docs measuring "What to measure when"`.

## Nothing here fits

`factory docs --search <words from the error>`. If the docs don't cover it, say so, and offer to
write it up as a docs issue with what happened and what they expected.

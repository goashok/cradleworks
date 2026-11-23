# Cradleworks

Read by Claude Code sessions in this repo, and in the sibling repos through the workspace `../CLAUDE.md`, which imports this file. Paths below are relative to the workspace folder that holds all five repos (`cradleworks/` is this repo).

## Repos

| Folder | Remote | Notes |
| --- | --- | --- |
| `cradleworks/` | `goashok/cradleworks`, **public** | The factory. Work on `main`. |
| `cradleworks-evals/` | private | Eval tasks, hidden tests, grader, runners. **The factory must never be able to read it**; only issue text (and, for the drill, a patch) leaves it. Never name its contents in the public repo. |
| `ref-orders-service/`, `ref-notifications-service/`, `ref-notifications-client/` | public | Reference projects the evals run on. Commit messages stay neutral: never "planted", "flaky" or hints about hidden tests. |

Plan doc (milestone plans, specs): https://claude.ai/artifact/9a6KuaiowzZPMZJREtbBcC

## Environment

- Node 22.18+ runs TypeScript directly (`node file.ts`). pnpm: `npx pnpm@12.18.0`.
- Docker CLI is not on PATH: prefix `PATH="$HOME/.docker/bin:$PATH"`. Don't edit Docker settings, never suggest "Reset to factory defaults", don't install system software without asking.
- Credentials live only in the macOS Keychain (`cradleworks-anthropic-api-key`, `cradleworks-claude-oauth-token`) or env vars. **Never write a key or token into a file, commit, log or outside request.**
- Check subscription usage before any eval run:
  `CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s cradleworks-claude-oauth-token -w)" claude -p "Reply with just OK" --model claude-haiku-5-5`
- The user's own console runs on port 4747 against `~/.cradleworks` (live data). Preview console changes on another port against a copy: `sqlite3 ~/.cradleworks/state.db ".backup <scratch>/state.db"`, then `CRADLEWORKS_HOME=<scratch> node packages/cli/src/main.ts console --port 4791`. Stop previews when done; a stale preview shows old data.
- Shell: no `rm -rf` with variables inside `bash -c`; prefer the Edit tool over long heredoc scripts.

## Checking a factory change (in this order)

1. In `cradleworks/`: `npx tsc -p tsconfig.json`, `npx vitest run`, `node scripts/check-core-rule.ts` (no vendor, stack or project names in `packages/core` or `packages/interfaces`). Known flakes: a 30 s process-kill timing test under load (rerun once); `docker-sandbox.test.ts` fails when `alpine:3.20` can't be pulled (environment, not code).
2. If the change touches the console, preview it as above and look at it (headless Chrome screenshots at desktop and phone width).
3. If it can change factory behaviour (`packages/`, `defaults/`): commit, then in `cradleworks-evals/` run a small check on the targeted tasks first, then the smoke set:
   `node scripts/scheduled.ts smoke --ref <commit> --force --no-publish`
   (pins a checkout at `~/.cradleworks-evals/factory-<commit>`; always pass `--no-publish`, its own commit lacks our trailers, so commit results yourself). Full suite only when needed: `node scripts/scheduled.ts weekly --no-publish` (~$26).
4. If it touches the reviewer or Verify: `node scripts/scheduled.ts drill --ref <commit> --no-publish` (~$0.60). Exit 0 ok, 1 flagged, 3 inconclusive.
5. Read results against the noise band: the same factory scores **19 to 21 of 30**; only a score outside it means something. See `cradleworks/docs/guides/evaluating.md` and `cradleworks-evals/README.md`.

Rules for evals: run a small check before any full run; change nothing in the environment mid-measurement; stop and report rather than retry blindly. **Don't install the eval schedule** (`scripts/schedule/install.sh`); the user runs evals by hand. Changes to the eval tooling itself: `npm test` and `npm run typecheck` in `cradleworks-evals/`; task changes: `node grader/grade-references.ts <task>`.

## Commits and docs

- Commit or push only when asked or when finishing agreed work; end messages with the attribution lines the session provides.
- Keep docs in step with behaviour: `cradleworks/docs/` (guides, `reference/cli.md`, `reference/configuration.md`, `roadmap.md`) and the plan doc.
- Write for readers outside the team: plain words, no internal shorthand.

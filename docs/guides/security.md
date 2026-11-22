# Sandbox and credentials

The agent runs arbitrary commands: it edits files, runs builds and installs packages. Cradleworks
assumes that code inside the sandbox might do anything, and limits what "anything" can reach.
This page lists exactly what the agent can and cannot reach, what's enforced today, and what
isn't yet.

## The boundary

```text
 your machine (host)                          sandbox (one per task)
 ────────────────────                         ─────────────────────────────
 factory CLI                                  Docker container from stack.image
 GitHub token ── clone / commit / push / PR   /workspace  = the task's git worktree
 event log (~/.cradleworks/state.db)          agent (claude) + your toolchain
                                              model credential (env var, this run only)
                 internal Docker network, no route out
                              │
                              ▼
                     egress proxy (per sandbox) ── allow-list ──► registry.npmjs.org
                                                                  api.anthropic.com
                                                                  (nothing else)
```

## What's enforced today

**One container and one worktree per task.** Each run gets a fresh git worktree on its own branch,
mounted at `/workspace` in a new container. Both are destroyed when the run ends, whether it
succeeded or not.

**A locked-down container.** Every Linux capability is dropped, privilege escalation is disabled
(`no-new-privileges`), the number of processes is limited, and the agent runs as your user id,
not root. Your home directory isn't mounted.

**Git's own files are read-only.** The worktree's `.git` link and the repository's git folder
are mounted read-only. An agent can't plant a git hook or `core.fsmonitor` setting that would
then run on your machine when the factory commits.

**Network by allow-list.** The container sits on an internal Docker network with no route out. Its
only way out is a per-sandbox proxy that allows the hosts in `sandbox.network.allow`:

| Entry | Allows |
| --- | --- |
| `registry.npmjs.org` | that host, ports 80 and 443 |
| `repo.example.com:8443` | that host, that port |
| `*.example.com` | any subdomain of example.com, ports 80 and 443 |

Names that resolve to private or loopback addresses are refused, so an allowed name can't be
pointed at your local network. The model API host is added automatically for the run, and
nothing else is. Tools find the proxy through `HTTP_PROXY` and `HTTPS_PROXY`, and Java tools
through `JAVA_TOOL_OPTIONS`. Maven gets a settings file. `mode: none` gives no network at all,
apart from the model API.

**No GitHub credentials in the sandbox.** Cloning, committing, pushing and opening the PR happen on
the host, with your token, after the agent's process has ended. The agent can change files. It
can't push, merge or touch any other repository.

**Credentials out of the logs.** The model credential reaches the agent as an environment variable
for that run only (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`). It's scrubbed from every
logged event. Cradleworks reads it from the environment or the macOS Keychain, and never writes
it to disk.

**Limits on every run.** 30 minutes of wall-clock time, and `budgets.per_task_usd` of model spend,
enforced by the agent runtime. Token counts and cost are recorded on every run.

**A quiet agent.** Inside the sandbox, Claude Code runs with telemetry, error reporting, auto-update
and non-essential traffic turned off. It keeps no session, and with an API key it skips any user
settings, hooks and plugins.

## What this does not protect against yet

Be clear about these before you point the factory at something sensitive:

- **The model credential is inside the sandbox.** Code in the sandbox could read it and send it to
  an allowed host. Use an API key that has a spend limit on the provider account.
- **Containers are not VMs.** The sandbox shares your machine's kernel (on macOS, Docker Desktop's
  VM). Microvm sandboxes are planned for evaluation in M4.
- **No hard-deny list yet.** The planned guardrails, which no config will be able to override (no
  force-push to protected branches, no changes to CI or `.factory/` without a human gate, no
  touching secrets), arrive in M4. Today the agent can edit any file in the repo, including CI
  workflows and `.factory/`, and you see that in the PR.
- **No per-command allow and deny lists yet** (M4). Inside the sandbox the agent's tool
  permissions are bypassed on purpose: the sandbox is the boundary.
- **No per-user budgets yet** (M4). Only the per-task cap is enforced.
- **The GitHub token is yours.** v1 uses `GITHUB_TOKEN` or your `gh` login. Short-lived,
  repo-scoped tokens from a GitHub App are planned.
- **Proxy decisions aren't in the run log yet.** The proxy records every allow and deny, but the
  run log doesn't include them yet.

**Always review the PR.** Until the Verify station and the change gate arrive (M2), your review is
the gate.

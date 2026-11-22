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
 GitHub token ── clone / scan / push / PR     /workspace  = the task's git worktree
 event log (~/.cradleworks/state.db)          agent (claude) + your toolchain
 hard rules, budgets, secret scan             a placeholder, not the model credential
                 internal Docker network, no route out
                              │
                              ▼
                     egress proxy (per sandbox) ── allow-list ──► registry.npmjs.org
                       │ holds the model credential               (nothing else)
                       └── credential gateway ── HTTPS ─────────► api.anthropic.com
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
can't push, merge or touch any other repository. With a [GitHub App](github-app.md) the factory
uses its own hour-long, repo-scoped tokens instead of yours.

**No model credential in the sandbox either.** The agent talks to the model API through a
gateway on its sandbox's egress proxy. The agent holds a placeholder; the proxy sets the real
API key or subscription token on each request and forwards it over HTTPS. The credential is in a
file (mode 0600) that only the proxy container mounts. It's scrubbed from every logged event, and
Cradleworks reads it from the environment or the macOS Keychain and writes it nowhere else.
(With a sandbox that has no proxy, such as the process sandbox used in tests, the credential
goes in the agent's environment instead.)

**Hard rules no config can turn off.**

- The factory pushes only its own `factory/*` branches, force-pushes only a branch it created
  with no PR yet, deletes no branch, and merges only into the work's base branch.
- A change to CI config (`.github/`, `.gitlab-ci.yml`, `.gitlab/`, `.circleci/`, `Jenkinsfile`,
  `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.buildkite/`, `.travis.yml`, `.drone.yml`),
  to `.factory/` or to a `CODEOWNERS` file waits for a person at the change gate, even with
  `change_approval: ai` or `skip`, and is never merged automatically: someone has to run
  `factory approve --merge` or merge the PR. `protected_paths` in factory.yaml adds paths; it
  can't remove these. `factory status` lists the protected files a task changed, and the PR
  says so in a comment. (The approved spec the factory itself writes under `.factory/specs/`
  doesn't count, unless the agent edited it.)

**A secret scan before every push.** What the run added is scanned for private keys, passwords in
URLs, the token formats of the common hosted services, and files that hold secrets by
convention (`.env`, `*.pem`, `id_rsa`, `.netrc` and the like; `.env.example` is fine). A hit
escalates the task and nothing is pushed. The reason names the file, line and kind of secret,
never the value.

**Commands agents may not run.** `git push`, `git remote`, git credential helpers, `gh`, `ssh`,
`scp`, `sftp` and `rsync` are refused on every agent run, plus anything in
`sandbox.commands.deny`. Each refusal is in the run log and `factory log`. This is a second
line: the sandbox has no credentials and no route to a git host anyway.

**Every network decision in the run log.** When a sandbox is torn down, everything its proxy
allowed or refused (tunnels, plain HTTP, gateway requests) is written to the run log.
`factory log <run>` shows the counts and each refusal; `--full` shows every decision.

**Limits on every run, and budgets across them.** 30 minutes of wall-clock time per run. Model
spend is recorded for every agent run, and each run gets only what's left under every cap that
applies:

- `budgets.per_task_usd` covers **all attempts of a task together**: builds, reworks, the
  reviewer and the tester. Spec, plan and check runs for a work item each get the same cap.
- `budgets.per_user_daily_usd` and `per_user_monthly_usd` cover everything one requester asked
  for, per UTC day (from midnight) and month (from the 1st).

At a cap the task pauses (`budget_exceeded`), or the work item blocks if it hadn't reached a
task yet; nothing is lost. `factory budget` shows spend against the caps, and
`factory budget extend` raises a cap and carries on. Every extension is recorded with who made
it.

**A quiet agent.** Inside the sandbox, Claude Code runs with telemetry, error reporting, auto-update
and non-essential traffic turned off. It keeps no session, and with an API key it skips any user
settings, hooks and plugins.

## What this does not protect against yet

Be clear about these before you point the factory at something sensitive:

- **Containers are not VMs.** The sandbox shares a kernel with the machine (on macOS, Docker
  Desktop's VM, which also runs the egress proxy that holds the model credential). A kernel
  escape would reach that. See [MicroVM sandboxes](../design/microvm-sandboxes.md) for the
  options and what we'd do first.
- **The model credential can still be used from inside.** The agent can't read it, but it can
  send requests through the gateway while its run lasts. The budgets cap what that costs.
- **The secret scan knows formats, not intent.** It catches keys and tokens with a recognisable
  shape and secret-holding files. A password in a plain variable (`password = "hunter2"`)
  passes. Keep real secrets out of the repository and the sandbox.
- **The command deny list matches leading words.** It's enforced by the agent runtime, so a
  command run some other way (a script that calls `git push`) isn't refused there; it fails for
  lack of credentials and network instead.
- **Branch protection is still yours to set.** The hard rules keep the factory to its own
  branches, but require a review on `main` in GitHub too, so a merge needs a person whatever
  the factory's settings.

**Keep the human change gate.** Verify catches failing checks and a lot of what a reviewer would
flag, but it is another agent. `change_approval: human` and `auto_merge: false` are the
defaults, so nothing merges until a person approves it. The reviewer agent runs in its own fresh
sandbox, with the same network rules, and its file-editing tools are switched off.

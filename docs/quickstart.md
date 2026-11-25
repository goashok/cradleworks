# Quick start

This guide takes you from a fresh clone to a pull request the factory opened, in about ten minutes.
You'll use the tiny example project in [`examples/hello-node`](../examples/hello-node). A git
repository on your disk stands in for GitHub, so you don't need a GitHub account and nothing gets
pushed anywhere. [Connecting a real GitHub repo](guides/add-a-project.md#4-switch-to-github) is
one line of config afterwards.

## What you need

| Tool | Why | Check |
| --- | --- | --- |
| Node 22.18 or later | Cradleworks is TypeScript, run directly by Node | `node --version` |
| git | Checkouts, branches, commits | `git --version` |
| Docker (Docker Desktop on macOS) | Every task runs in its own container | `docker info` |
| A Claude credential | The agent (Claude Code) runs inside the container | see step 2 |

You don't need to install pnpm: `npx pnpm@12.18.0` fetches the pinned version.

## 1. Install Cradleworks

```sh
git clone https://github.com/goashok/cradleworks
cd cradleworks
npx pnpm@12.18.0 install
alias factory="node $PWD/packages/cli/src/main.ts"   # add to your shell profile to keep it
factory help
```

## 2. Give the agent a credential

The agent needs one of these. It reaches the agent only as an environment variable inside the
sandbox for that run, and it's scrubbed from the logs.

```sh
# Either: an Anthropic API key (billed to the API account)
export ANTHROPIC_API_KEY=sk-ant-...

# Or: a Claude subscription token
claude setup-token                       # prints a long-lived token
export CLAUDE_CODE_OAUTH_TOKEN=...
```

On macOS you can keep either one in the Keychain instead of your shell, and Cradleworks will find
it there:

```sh
security add-generic-password -s cradleworks-anthropic-api-key -a "$USER" -w      # API key
security add-generic-password -s cradleworks-claude-oauth-token -a "$USER" -w     # subscription token
```

If both are present, the API key wins. Set `CRADLEWORKS_CLAUDE_AUTH=subscription` to use the
subscription instead.

## 3. Set up the example project

Copy the example somewhere outside the Cradleworks checkout, make it a git repository, and give it
a "remote": a bare repository next to it.

```sh
cp -R examples/hello-node ~/hello-node
cd ~/hello-node
git init -b main && git add -A && git commit -m "hello-node"
git init --bare ~/hello-node-remote.git
git remote add origin ~/hello-node-remote.git
git push -u origin main
```

Then build the image the sandbox will run. It's a Node image with git and Claude Code added.

```sh
docker build -t cradleworks/hello-node-dev:1 .factory/image
```

Here's what you just set up. The whole project is three files plus a `.factory/` folder:

```text
hello-node/
  src/greet.js                 greet(name) → "Hello, <name>!"
  test/greet.test.js           one test (npm test)
  tasks/farewell.md            the task you'll hand the factory
  .factory/
    factory.yaml               how the factory works on this project
    rules/conventions.md       rules every agent run is told to follow
    image/Dockerfile           the sandbox image
```

## 4. Check the setup

```console
$ factory validate
.: project hello-node, 1 rule file(s), image cradleworks/hello-node-dev:1
  note: no tracker: submit works, factory watch does not
ok
```

`validate` reads `.factory/factory.yaml`, checks every key, confirms the rule files and the image
exist, and runs nothing. A mistake in the YAML is reported with its line number. The note is
expected. This example lives on your disk, not on GitHub, so it can't take issues. See
[From an issue to merged PRs](guides/issues.md) once your project is on GitHub.

## 5. Submit the task

The task is plain Markdown. A `# Title` comes first, and everything after it is the description:

```markdown
# Add a farewell function

Add `farewell(name)` to `src/greet.js`. It returns `Goodbye, <name>!`, the counterpart of `greet`.

Done when `farewell('Ada')` returns `Goodbye, Ada!` and has a test.
```

```console
$ factory submit tasks/farewell.md
Submitted "Add a farewell function" as wi_5eb83867-b216-4ed4-ae28-57e85860a243
Building task_6dca1aa4-a379-46e7-a332-6455cc07b57a...
Opened file:///Users/you/hello-node-remote.git#pull-1
  branch factory/task-6dca1aa4
  run    run_d4d34200-fdee-4953-b359-b8ee165d94f8
Verifying...
  checks: build ✓, test ✓   CI: not configured   reviewer: pass (low risk)
    - `farewell` is implemented as specified, with a doc comment and a test that follows the project conventions.
Passed: checks passed, CI not configured, reviewer passed (low risk)
  run    run_c5131ffe-a082-4d5b-9572-4db3512f5c05
Ready for review: file:///Users/you/hello-node-remote.git#pull-1
  approve with  factory approve task_6dca1aa4-a379-46e7-a332-6455cc07b57a [--merge]
  or send back  factory reject task_6dca1aa4-a379-46e7-a332-6455cc07b57a --reason "..."
```

Two runs happened. **Build**: an agent wrote the change in a sandbox and opened the PR. **Verify**:
in a fresh sandbox, the factory ran the build and test commands on the pushed branch, and a second
agent reviewed the diff. If either had found a problem, the task would have gone back to the
agent with the reasons, and the fix would have landed on the same PR. The whole thing took about
20 seconds and cost under $0.03. Tasks on real projects usually take two to five minutes.

## 6. Look at what it did

**The change.** It's on a branch in the remote:

```console
$ git fetch origin
$ git diff main origin/factory/task-6dca1aa4
+/** Returns a farewell for `name`. */
+export function farewell(name) {
+  return `Goodbye, ${name}!`;
+}
 ...
+test('says farewell by name', () => {
+  assert.equal(farewell('Ada'), 'Goodbye, Ada!');
+});
```

The agent followed the project rule that every exported function gets a doc comment and a test.
On GitHub you'd see this as a normal pull request. Here, the PR (title, body and the agent's
summary) is stored in `~/hello-node-remote.git/cradleworks-pull-requests.json`.

**Every step it took.** Pass the run id from the submit output:

```console
$ factory log run_d4d34200-fdee-4953-b359-b8ee165d94f8
15:14:43  checkout     ~/hello-node-remote.git → ~/.cradleworks/work/…
15:14:43  sandbox      local-docker-task-6dca1aa4 on factory/task-6dca1aa4 from main; network allowlist: api.anthropic.com
15:14:43  context      .factory/rules/conventions.md
15:14:43  agent        claude-code claude-sonnet-5-5, limits 1800s / $1.0000
15:14:45  → Read       /workspace/.factory/rules/conventions.md
15:14:46  → Read       /workspace/src/greet.js
15:14:47  → Read       /workspace/test/greet.test.js
15:14:49  → Bash       cd /workspace; cat >> src/greet.js <<'E' …
15:14:49  ←            # tests 2 …
15:14:51  file         modified src/greet.js
15:14:51  file         modified test/greet.test.js
15:14:51  agent        succeeded; 9695 in / 622 out tokens, $0.0141
15:14:51  commit       11058f18…
15:14:51  push         factory/task-6dca1aa4
15:14:51  pr           file:///Users/you/hello-node-remote.git#pull-1
15:14:51  sandbox      local-docker-task-6dca1aa4 destroyed
```

From this you can see that the sandbox could reach only the model API, which rules the agent was
given, what it read, what it ran, what it changed and what it cost. Add `--full` to see every tool
input and output in full.

**The work item.**

```console
$ factory status
WORK ITEM                                STATE        TASKS  PROJECT     TITLE
wi_5eb83867-b216-4ed4-ae28-57e85860a243  awaiting_change_approval  0/1    hello-node  Add a farewell function
```

It's waiting for you at the change gate. `factory status <work-item-id>` shows the task, its PR,
the evidence from Verify, its runs and the recorded gate decisions.

## 7. Approve and merge

```console
$ factory approve task_6dca1aa4-a379-46e7-a332-6455cc07b57a --merge
Approved and merged 401089b49d43
$ git pull -q && git log --oneline -1
401089b Add a farewell function (#1)
```

Or send it back with what to change, and watch the rework:
`factory reject <task-id> --reason "Also export it from index.js"`. See
[Verify, rework and approve](guides/verify-and-approve.md).

## 8. Move hello-node to GitHub

So far the "remote" was a folder on your disk. On GitHub you get real pull requests, and you
can hand the factory work as an issue. This takes about ten minutes more.

**Sign in to GitHub.** The factory uses `GITHUB_TOKEN` if it's set, otherwise your GitHub CLI
login. With the [GitHub CLI](https://cli.github.com/) (`brew install gh` on a Mac):

```sh
gh auth login
```

Without it, create a fine-grained token for the repository (Contents, Pull requests and Issues:
read and write; with `ci: github-actions`, Actions: read-only too), keep it in your keychain and
export it as `GITHUB_TOKEN`. GitHub doesn't offer fine-grained tokens the Checks permission, so on
a private repository the factory can't see other apps' checks on a pull request; it still reads
GitHub Actions results through the Actions permission. When `git push` asks
for a password, give it the token. See [Switch to GitHub](guides/add-a-project.md#4-switch-to-github).

**Put the project on GitHub**, and make that repository its `origin`:

```sh
cd ~/hello-node
gh repo create hello-node --private --source . --remote github
git remote remove origin && git remote rename github origin
git push -u origin main
```

(Without `gh`: create an empty repository on github.com, then
`git remote set-url origin https://github.com/<you>/hello-node.git` and `git push -u origin main`.)

**Point the factory at GitHub.** In `.factory/factory.yaml`, change three adapters:

```yaml
adapters:
  scm: github             # was local-git: branches and pull requests on GitHub
  ci: none                # github-actions once the repo has a workflow
  tracker: github-issues  # was none: factory watch reads issues
```

With `ci: github-actions`, Verify also waits for the repository's workflow runs on each change,
and a failed run sends the change back. Hello-node has no workflow, so leave CI off for now.

```console
$ git commit -qam "Use GitHub" && git push -q
$ factory validate
.: project hello-node, 1 rule file(s), image cradleworks/hello-node-dev:1
ok
```

**Hand it an issue.** Create the label the factory looks for, then open an issue with it:

```sh
gh label create factory --description "Work for the factory"
gh issue create --label factory --title "Add a shout function" \
  --body "Add shout(name) in src/greet.js: the greeting in capitals, with a test."
```

Then start the factory in the project and leave it running:

```console
$ factory watch
Watching you/hello-node for open issues labelled "factory", every 60s
```

On the issue you'll see it work. A `factory:<state>` label always shows where it stands.

1. It comments `Picked up as wi_…`, then posts a **spec** with acceptance criteria. It may first
   ask a few questions; answer them in a comment.
2. Reply **`/approve`** in a comment (or `/reject <what to change>`). Only people with write access
   to the repository can decide.
3. It posts the **plan**, which an AI checker approves by default, then builds each task as its
   own **pull request** and links it on the issue.
4. **Approve and merge** each pull request: click *Merge pull request* on GitHub, use **Approve and
   merge** in `factory console`, or run `factory approve <task-id> --merge`. (GitHub doesn't let you
   approve your own pull request as a review, and the factory opened it as you, so merging is how
   you say yes there.)
5. When everything has merged, it comments `Done`, labels the issue `factory:merged` and closes it.

A task you write yourself still works too: `factory submit <file>.md`, as in step 5, now opens a
pull request on GitHub. More in [From an issue to merged PRs](guides/issues.md).

## Clean up

```sh
rm -rf ~/hello-node ~/hello-node-remote.git
docker image rm cradleworks/hello-node-dev:1
gh repo delete hello-node        # if you did step 8; needs `gh auth refresh -s delete_repo`
```

Factory state lives in `~/.cradleworks`. Delete it to forget every run, or set `CRADLEWORKS_HOME`
to keep experiments separate.

## Next

- [How it works](how-it-works.md): what happened in those twenty seconds, and why it's built this way
- [Add your own project](guides/add-a-project.md): your repo, your image, your rules, real GitHub PRs
- [Make it your team's](guides/customizing.md): rules, prompt additions, skills, agent checks and drill cases, and when to use each
- [Write good tasks](guides/writing-tasks.md): get better results from the agent
- [From an issue to merged PRs](guides/issues.md): let `factory watch` take GitHub issues from spec to merge
- [Get help as you go](guides/getting-help.md): `factory docs`, `factory config explain`, and a skill so your coding assistant can answer questions and walk you through setup

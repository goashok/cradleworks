# Configuration reference

A project is configured by `.factory/factory.yaml` at the root of its repository. Keys the file
leaves out come from [`defaults/factory.yaml`](../../defaults/factory.yaml). Maps merge key by
key, while lists and single values are replaced whole.

Every key is validated when the file loads. Unknown keys, wrong types and bad values are reported
together, each with its line number. `factory validate` runs the same checks without running
anything.

**Status:** ✅ means the key takes effect today. ⏳ means it's validated and stored now, and takes
effect in the milestone shown.

## `project` (required)

| Key | Type | Status | Meaning |
| --- | --- | --- | --- |
| `project` | string | ✅ | The project's name in status output and logs. |

## `adapters` (required)

| Key | Values | Status | Meaning |
| --- | --- | --- | --- |
| `scm` | `github`, `local-git` | ✅ | Where the repo lives and PRs are opened. The repo is read from the `origin` remote. |
| `sandbox` | `local-docker` (`process` for tests only) | ✅ | Where the agent runs. `process` isn't isolated, and the CLI warns if you use it. |
| `runtime` | `cli-agent` | ✅ | How the agent is driven: a CLI agent, headless, inside the sandbox. |
| `ci` | `github-actions` | ⏳ M2 | CI to wait on in the Verify station. |
| `tracker` | `github-issues` | ⏳ M3 | Where requests come from. |

## `runtime` (required)

| Key | Type | Status | Meaning |
| --- | --- | --- | --- |
| `agent` | string | ✅ | The agent to run. Today: `claude-code`. |
| `model` | string | ✅ | The model id passed to the agent, e.g. `claude-sonnet-5-5`. |
| `roles.<role>.agent` / `.model` | string | ✅ `implementer` · ⏳ others | Override the agent or model for one role: `implementer` (Build), and from M2–M3 `specifier`, `planner`, `tester` and `reviewer`. |

## `stack` (required)

| Key | Type | Status | Meaning |
| --- | --- | --- | --- |
| `image` | string | ✅ | The Docker image every sandbox is created from. It needs the toolchain, git and the agent's command. |
| `build` | string | ✅ | Builds the project. |
| `test` | string | ✅ | Runs the tests. |
| `lint` | string | ✅ optional | Checks style. |
| any other key | string | ✅ optional | A further named command, e.g. `frontend_test`, `contract_test`. |

Today, every command is listed by name in the agent's instructions, and the agent is told to run
the build and tests before finishing. From M2, the Verify station also runs them itself.

## `context` (required)

| Key | Type | Default | Status | Meaning |
| --- | --- | --- | --- | --- |
| `rules` | glob or list of globs | `[.factory/rules/*.md]` | ✅ | Rule files every agent is told to read and follow. They're matched in the checkout and share a 256 KB budget, and any file over budget is dropped and listed in the log. Each pattern must match at least one file. |
| `include` | path or list | `[.]` | ⏳ M3 | The parts of the repo the repo map will cover. Today it's checked to exist; the agent can read the whole checkout either way. |

## `gates` (required, defaults provided)

Each gate is `human`, `ai` or `skip`.

| Key | Default | Status | Meaning |
| --- | --- | --- | --- |
| `spec_approval` | `human` | ⏳ M3 | Who approves the spec before code is written. |
| `plan_check` | `ai` | ⏳ M3 | Who checks the task breakdown. |
| `change_approval` | `human` | ⏳ M2 | Who approves the PR with its evidence. |
| `auto_merge` | `false` | ⏳ M2 | Merge automatically once the change gate approves. |

Hand-written tasks from `factory submit` record the spec and plan gates as skipped, because you
wrote the spec. Until M2, a human reviews and merges every PR.

## `budgets` (required, defaults provided)

| Key | Type | Default | Status | Meaning |
| --- | --- | --- | --- | --- |
| `per_task_usd` | number > 0 | `5` | ✅ | The spend limit for one agent run. The agent stops when it's reached. |
| `max_rework_loops` | integer ≥ 0 | `3` | ⏳ M2 | Verify → Build loops before a task escalates to a human. Recorded on each work item. |
| `per_user_daily_usd` | number > 0 | none | ⏳ M4 | Daily spend cap per requester. |
| `per_user_monthly_usd` | number > 0 | none | ⏳ M4 | Monthly spend cap per requester. |

Each Build run also has a fixed 30-minute wall-clock limit.

## `sandbox.network` (required, defaults provided)

| Key | Values | Default | Status | Meaning |
| --- | --- | --- | --- | --- |
| `mode` | `allowlist`, `none` | `allowlist` | ✅ | `none`: no outside network except the model API. `allowlist`: only the listed hosts, plus the model API. |
| `allow` | list of entries | `[]` | ✅ | `host` (ports 80 and 443), `host:port`, or `*.domain`. Names that resolve to private or loopback addresses are always refused. |

The agent runtime's own hosts, such as `api.anthropic.com`, are added for each run automatically.
Don't list them yourself.

## Other keys

| Key | Values | Default | Status | Meaning |
| --- | --- | --- | --- | --- |
| `specs` | `repo`, `factory` | `repo` | ⏳ M3 | Where approved specs are kept: in the repo under `.factory/specs/`, or in the factory's store. |
| `concurrency` | integer ≥ 1 | `2` | ⏳ M3 | How many tasks may build at once. Today `submit` builds one task at a time. |

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CRADLEWORKS_HOME` | Where state lives. Default `~/.cradleworks`. |
| `GITHUB_TOKEN` | The GitHub token. If unset, the `gh` CLI login is used. |
| `ANTHROPIC_API_KEY` | The API key for Claude Code. Keychain fallback: service `cradleworks-anthropic-api-key`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The subscription token from `claude setup-token`. Keychain fallback: service `cradleworks-claude-oauth-token`. |
| `CRADLEWORKS_CLAUDE_AUTH` | Set to `subscription` to prefer the subscription token when both are present. |

## A complete example

```yaml
project: ref-orders-service

adapters:
  scm: github
  ci: github-actions
  tracker: github-issues
  sandbox: local-docker
  runtime: cli-agent

runtime:
  agent: claude-code
  model: claude-sonnet-5-5

stack:
  image: cradleworks/ref-orders-service-dev:1
  build: ./mvnw -B -q -DskipTests package
  test: ./mvnw -B test
  lint: ./mvnw -B -q spotless:check
  frontend_test: npm --prefix web ci && npm --prefix web test
  frontend_typecheck: npm --prefix web run typecheck

context:
  include: [src/, web/src/, docs/adr/, README.md, pom.xml, compose.yaml]
  rules: [.factory/rules/*.md]

gates:
  spec_approval: human
  plan_check: ai
  change_approval: human
  auto_merge: false

budgets:
  per_task_usd: 5
  max_rework_loops: 3

sandbox:
  network:
    mode: allowlist
    allow:
      - repo.maven.apache.org   # Maven wrapper, plugins, dependencies
      - registry.npmjs.org      # web/ packages
```

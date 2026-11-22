# Add your own project

To put the factory to work on a repository, you add a `.factory/` folder to it. This guide builds
that folder step by step, then switches from a local remote to GitHub.

You'll write three things:

```text
your-repo/
  .factory/
    factory.yaml          what the factory needs to know about the project
    rules/*.md            what every agent run is told to follow
    image/Dockerfile      the sandbox image (any path works; this is the convention)
```

## 1. Write `factory.yaml`

Start from this and change the `stack` section to your project's commands. Anything you leave
out comes from [`defaults/factory.yaml`](../../defaults/factory.yaml).

```yaml
project: my-service              # a name for logs and status

adapters:
  scm: github                    # or local-git to try it without GitHub
  ci: github-actions             # Verify waits for workflow runs on each pushed commit
  tracker: github-issues         # for factory watch; none to use submit only
  sandbox: local-docker
  runtime: cli-agent

runtime:
  agent: claude-code
  model: claude-sonnet-5-5

stack:
  image: my-org/my-service-dev:1 # the sandbox image, built in step 2
  build: npm ci && npm run build # required
  test: npm test                 # required
  lint: npm run lint             # optional
  e2e_test: npm run test:e2e     # any other named command is passed on too

context:
  include: [src/, test/, README.md]
  rules: [.factory/rules/*.md]

budgets:
  per_task_usd: 5                # the agent stops when a run reaches this

sandbox:
  network:
    mode: allowlist
    allow:
      - registry.npmjs.org       # whatever your build downloads from
```

The agent sees every `stack` command by name, and it's told to run the build and tests before it
finishes. Name your commands so their purpose is obvious (`contract_test`, `frontend_typecheck`):
those names are all the agent knows about them.

Every key is described in the [configuration reference](../reference/configuration.md). Several
keys, such as `gates`, are accepted and checked now but only take effect in later milestones. The
reference marks which.

## 2. Build a sandbox image

The agent runs **inside** the sandbox, so the image needs:

- **your toolchain**: whatever `stack.build` and `stack.test` need (JDK, Node, Python, …)
- **git**
- **the agent**: a `claude` command on `PATH` (`npm install -g @anthropic-ai/claude-code`)

A Node example:

```dockerfile
FROM node:22.23.4-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.319 \
 && npm cache clean --force
WORKDIR /workspace
```

```sh
docker build -t my-org/my-service-dev:1 .factory/image
```

Things that help in practice:

- **Bake slow downloads into the image, or allow them.** The sandbox can reach only the hosts in
  `sandbox.network.allow`. Either pre-fetch dependencies in the image, or list the registry. Maven
  is given a proxy settings file automatically, and Java tools get `JAVA_TOOL_OPTIONS`.
- **Include the small tools agents reach for.** In our runs, agents often tried `python3` for
  quick file edits. When it's missing they fall back to other tools, but that costs a little time
  on each run.
- **Pin versions** and bump the image tag when you change the image (`:1` → `:2`), so runs are
  reproducible.
- The container runs as **your user id**, with every capability dropped and no privilege
  escalation. Don't rely on root inside it.

A project with two toolchains can combine official images. For a Spring Boot + React service:

```dockerfile
FROM node:22.23.4-bookworm-slim AS node

FROM eclipse-temurin:21.0.13_9-jdk-noble
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.319 \
 && npm cache clean --force
WORKDIR /workspace
```

With the Maven wrapper (`./mvnw`), allow `repo.maven.apache.org` so it can fetch Maven, plugins
and dependencies.

## 3. Write rules

Rules are short Markdown files the agent is told to read and follow before it starts. They're the
best place to put what an experienced teammate would tell a newcomer:

```markdown
# Conventions

- SQL lives in `src/store.ts`. Schema changes are new entries at the end of `MIGRATIONS`;
  never edit an existing entry.
- Time comes from the injected `Clock`; never call `Date.now()` directly.
- Dependencies are pinned to exact versions.
```

```markdown
# API v1

- `api/v1.openapi.json` is a contract with every caller. Within v1, changes are additive only.
  Anything else goes in a new `/v2`.
```

Good rules are:

- **specific and checkable** ("never edit an existing migration"), not aspirational ("write clean
  code")
- **about this codebase**: the things a smart newcomer would get wrong
- **short**: all matched rule files share a 256 KB context budget. Files that don't fit are
  dropped, and the log lists what was dropped.

Rules live in git, so changing what agents do is a reviewed pull request, not a prompt edit
somewhere.

## 4. Switch to GitHub

With `scm: github`, the factory pushes branches and opens real pull requests on the repository
behind your `origin` remote (`https://github.com/owner/repo`, or the `git@github.com:` form).

It signs in with `GITHUB_TOKEN` if that's set, otherwise with your GitHub CLI login
(`gh auth login`). The token needs to be able to push branches and open pull requests on the repo.

The token stays on your machine: cloning, committing, pushing and opening the PR all happen on the
host, after the agent's container has finished. **The agent never has GitHub credentials**, and
`github.com` isn't on the sandbox allow-list unless you add it.

## 5. Validate and run

```console
$ factory validate
.: project my-service, 2 rule file(s), image my-org/my-service-dev:1
ok

$ factory submit task.md
```

`validate` reports YAML mistakes with line numbers, unknown adapters, rule patterns that match
nothing, `context.include` paths that don't exist, and an image that isn't built yet. It runs
nothing and needs no network.

Then [write a good task](writing-tasks.md), and [follow the run](runs-and-logs.md).

## Checklist

- [ ] `.factory/factory.yaml` with your `stack.build` and `stack.test`
- [ ] an image with your toolchain, git and `claude`, built and tagged as `stack.image`
- [ ] the hosts your build downloads from in `sandbox.network.allow`
- [ ] one to three rule files about what's unusual in this codebase
- [ ] `factory validate` says `ok`
- [ ] a GitHub token (`GITHUB_TOKEN` or `gh auth login`) and a Claude credential

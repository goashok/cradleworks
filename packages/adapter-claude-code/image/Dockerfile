# Minimal agent image for the Claude Code contract tests. Project images (stack.image)
# need the same: a `claude` command on PATH, and git.
FROM node:22.11.0-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.319
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

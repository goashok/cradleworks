# Sandbox image for hello-node: Node, git, and Claude Code (the agent runs inside the sandbox).
#   docker build -t cradleworks/hello-node-dev:1 .factory/image
FROM node:22.23.4-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.319 \
 && npm cache clean --force
WORKDIR /workspace

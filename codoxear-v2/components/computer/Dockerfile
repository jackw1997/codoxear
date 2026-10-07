# Build context is the exported standalone Computer package.
ARG NODE24_IMAGE=node:24-bookworm-slim
FROM ${NODE24_IMAGE} AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=768
COPY package.json package-lock.json ./
COPY runtime/oar/package.json runtime/oar/package-lock.json ./runtime/oar/
# @lydell/node-pty installs its pinned Linux x64/arm64 prebuilt package.
# Keep optional dependencies enabled; no compiler or Python fallback is used.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && node --input-type=module -e 'await import("@lydell/node-pty")'

FROM ${NODE24_IMAGE}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates ripgrep fd-find ffmpeg \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
# CLI versions match the accepted native-runtime image. Their transitive
# dependency trees are supplied by the vendor packages, separately from OAR.
RUN npm install --global --no-audit --no-fund \
    @earendil-works/pi-coding-agent@1.0.0 \
    @openai/codex@0.160.0 \
    @anthropic-ai/claude-code@2.1.287 \
    && npm cache clean --force
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/runtime/oar ./runtime/oar
ENV HOME=/home/node \
    CODOXEAR_COMPUTER_HOME=/home/node/.local/share/codoxear-v2/computer \
    PI_BIN=/usr/local/bin/pi \
    CODEX_BIN=/usr/local/bin/codex \
    CLAUDE_BIN=/usr/local/bin/claude
USER node
CMD ["node", "dist/server/computer/main.js", "start"]

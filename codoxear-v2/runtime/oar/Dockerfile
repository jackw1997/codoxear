# Build context: codoxear-v2. Override with a digest for release input tracking.
# No npm-install fallback for missing locks.
ARG NODE24_IMAGE=node:24-bookworm
FROM ${NODE24_IMAGE} AS build
WORKDIR /opt/codoxear
ENV NODE_OPTIONS=--max-old-space-size=768
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY tsup.config.ts tsconfig.json ./
RUN ./node_modules/.bin/tsup
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE24_IMAGE} AS oar
WORKDIR /opt/codoxear/runtime/oar
ENV NODE_OPTIONS=--max-old-space-size=768
COPY runtime/oar/package.json runtime/oar/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY runtime/oar/load.mjs ./

FROM ${NODE24_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep fd-find ffmpeg \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund \
    @earendil-works/pi-coding-agent@1.0.0 \
    @openai/codex@0.160.0 @anthropic-ai/claude-code@2.1.287
ENV PI_BIN=/usr/local/bin/pi CODEX_BIN=/usr/local/bin/codex CLAUDE_BIN=/usr/local/bin/claude
WORKDIR /opt/codoxear
COPY --from=build /opt/codoxear/dist/server ./dist/server
COPY --from=build /opt/codoxear/node_modules ./node_modules
COPY --from=build /opt/codoxear/package.json ./package.json
COPY --from=oar /opt/codoxear/runtime/oar ./runtime/oar
# CLI top-level versions match Dockerfile.test; their transitive trees are not locked.
ENV HOME=/home/node CODOXEAR_COMPUTER_HOME=/home/node/.local/share/codoxear-v2/computer
USER node
ENTRYPOINT ["node", "--max-old-space-size=384", "dist/server/computer/main.js"]
CMD ["doctor"]

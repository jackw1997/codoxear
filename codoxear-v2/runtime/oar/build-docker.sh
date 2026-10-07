#!/usr/bin/env bash
# Build only a committed v2 snapshot inside one memory-bounded owned container.
set -euo pipefail
if (( $# < 1 || $# > 2 )); then
  echo 'Usage: build-docker.sh <commit-ish> [image]' >&2
  exit 64
fi
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(git -C "$directory" rev-parse --show-toplevel)
commit=$(git -C "$repository" rev-parse --verify --end-of-options "$1^{commit}")
image=${2:-codoxear-v2-oar:local}
if [[ "$image" == -* || "$image" == *[[:space:]]* || -z "$image" ]]; then
  echo 'Invalid output image name' >&2
  exit 64
fi
for file in frontend/package-lock.json package-lock.json runtime/oar/package-lock.json src/computer/managed/worker.ts src/hub/main.ts frontend/serve.mjs; do
  if ! git -C "$repository" cat-file -e "$commit:codoxear-v2/$file" 2>/dev/null; then
    echo "Selected commit is missing codoxear-v2/$file; use a committed v2 snapshot with its real OAR lock." >&2
    exit 65
  fi
done
NODE24_IMAGE=${NODE24_IMAGE:-node:24-bookworm}
if [[ ! "$NODE24_IMAGE" =~ ^node:24[^@]*-bookworm[^@]*(@sha256:[a-f0-9]{64})?$ ]]; then
  echo 'NODE24_IMAGE must name a Node 24 bookworm image, optionally pinned by sha256 digest' >&2
  exit 64
fi
lock_path="/tmp/codoxear-v2-verification-$(id -u).lock"
if [[ -L "$lock_path" || ( -e "$lock_path" && ( ! -O "$lock_path" || ! -f "$lock_path" ) ) ]]; then
  echo 'Verification lock must be an owned regular file' >&2
  exit 73
fi
umask 077
exec 9>>"$lock_path"
flock --nonblock --conflict-exit-code 75 9 || {
  echo 'Another v2 verification/build is running; wait for it to finish.' >&2
  exit 75
}
temporary=$(mktemp -d /tmp/codoxear-v2-oar-build.XXXXXXXX)
container_id=
cleanup() {
  if [[ -n "$container_id" ]]; then
    if ! docker rm --force "$container_id" >/dev/null; then
      echo "Owned builder cleanup failed: $container_id. Remove it before another build." >&2
      return 1
    fi
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$repository" archive --format=tar --output="$temporary/source.tar" "$commit:codoxear-v2"
container_id=$(docker create --init --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
  --label "org.codoxear.build.commit=$commit" \
  --env NODE_OPTIONS=--max-old-space-size=768 \
  --env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
  --env "CODOXEAR_BUILD_COMMIT=$commit" \
  --workdir /opt/codoxear "$NODE24_IMAGE" bash -euc '
    mkdir -p /opt/codoxear
    tar -xf /tmp/codoxear-source.tar -C /opt/codoxear
    rm /tmp/codoxear-source.tar
    apt-get update
    apt-get install -y --no-install-recommends git ripgrep fd-find ffmpeg
    ln -s /usr/bin/fdfind /usr/local/bin/fd
    rm -rf /var/lib/apt/lists/*
    npm ci --no-audit --no-fund
    npm ci --prefix frontend --no-audit --no-fund
    ./node_modules/.bin/playwright install --with-deps chromium
    chmod -R a+rX /opt/ms-playwright
    npm ci --prefix runtime/oar --omit=dev --no-audit --no-fund
    npm install --global --no-audit --no-fund @earendil-works/pi-coding-agent@1.0.0 @openai/codex@0.160.0 @anthropic-ai/claude-code@2.1.287
    npm run build
    printf "%s\n" "$CODOXEAR_BUILD_COMMIT" > build-commit.txt
    sha256sum package-lock.json frontend/package-lock.json runtime/oar/package-lock.json > build-locks.sha256
    rm -rf /root/.npm
  ')
base_image_id=$(docker inspect --format '{{.Image}}' "$container_id")
docker cp "$temporary/source.tar" "$container_id:/tmp/codoxear-source.tar"
attach_status=0
docker start --attach "$container_id" || attach_status=$?
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container_id")
oom=$(docker inspect --format '{{.State.OOMKilled}}' "$container_id")
if [[ "$attach_status" != 0 || "$exit_code" != 0 || "$oom" != false ]]; then
  echo "Bounded build failed (attach=$attach_status, exit=$exit_code, OOM=$oom); no image was committed." >&2
  exit 1
fi
docker commit \
  --change 'WORKDIR /opt/codoxear' \
  --change 'USER node' \
  --change 'ENV HOME=/home/node CODOXEAR_COMPUTER_HOME=/home/node/.local/share/codoxear-v2/computer PI_BIN=/usr/local/bin/pi CODEX_BIN=/usr/local/bin/codex CLAUDE_BIN=/usr/local/bin/claude PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' \
  --change 'ENTRYPOINT []' \
  --change 'CMD ["node", "dist/server/computer/main.js", "doctor"]' \
  --change "LABEL org.codoxear.release.commit=$commit" \
  --change "LABEL org.codoxear.release.base-image=$base_image_id" \
  "$container_id" "$image"
echo "Built $image from $commit using base image $base_image_id; no services were launched."

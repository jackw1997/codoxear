#!/usr/bin/env bash
# Dependency installation only. No Computer, agent, broker or listener is started.
set -euo pipefail
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mode=${1:-install}
case "$mode" in install|resolve-lock) ;; *) echo 'Usage: install-docker.sh [install|resolve-lock]' >&2; exit 64;; esac
NODE24_IMAGE=${NODE24_IMAGE:-node:24-bookworm}
if [[ ! "$NODE24_IMAGE" =~ ^node:24[^@]*-bookworm[^@]*(@sha256:[a-f0-9]{64})?$ ]]; then
  echo 'NODE24_IMAGE must name a Node 24 bookworm image, optionally pinned by sha256 digest' >&2
  exit 64
fi
if [[ "$mode" == install && ! -f "$directory/package-lock.json" ]]; then
  echo 'Missing real OAR package-lock.json. Resolve and review it before installation.' >&2
  exit 65
fi
# Share the repository verification lock and retain it until Docker exits.
lock_path="/tmp/codoxear-v2-verification-$(id -u).lock"
if [[ -L "$lock_path" || ( -e "$lock_path" && ( ! -O "$lock_path" || ! -f "$lock_path" ) ) ]]; then
  echo 'Verification lock must be an owned regular file' >&2
  exit 73
fi
umask 077
exec 9>>"$lock_path"
flock --nonblock --conflict-exit-code 75 9 || {
  echo 'Another v2 verification/install is running; wait for it to finish.' >&2
  exit 75
}
args=(ci --omit=dev --no-audit --no-fund)
if [[ "$mode" == resolve-lock ]]; then
  args=(install --package-lock-only --ignore-scripts --no-audit --no-fund)
fi
docker run --rm --init --memory=2g --memory-swap=2g --cpus=2 --pids-limit=256 \
  --user "$(id -u):$(id -g)" --cap-drop=ALL --security-opt=no-new-privileges \
  --env HOME=/tmp --env npm_config_cache=/tmp/npm-cache \
  --env NODE_OPTIONS=--max-old-space-size=768 \
  --mount "type=bind,src=$directory,dst=/runtime" --workdir /runtime \
  "$NODE24_IMAGE" npm "${args[@]}"

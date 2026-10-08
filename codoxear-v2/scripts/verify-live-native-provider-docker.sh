#!/bin/bash
# Docker-only native acceptance with the local-rootless test image/tool mounts.
# Only this owned container is removed. External networking is disabled.
# Uses a private read-only provider fixture and egress Unix socket. No secrets or endpoints are emitted.
set -euo pipefail
cd "$(dirname "$0")/.."
# Share one verification slot with the Compose runner and other fixture scripts.
verification_lock="/tmp/codoxear-v2-verification-${UID}.lock"
if [[ -L "$verification_lock" || ( -e "$verification_lock" && ( ! -O "$verification_lock" || ! -f "$verification_lock" ) ) ]]; then
  echo "Verification lock is not an owned regular file" >&2; exit 1
fi
(umask 077; touch "$verification_lock")
exec 9>>"$verification_lock"
flock -n 9 || { echo "Another v2 verification is running; wait before launching another fixture." >&2; exit 75; }
mkdir -p /tmp/codoxear-kimi-native-acceptance/tools
fixture_name="codoxear-live-native-provider-$$"
fixture_archive=$(mktemp /tmp/codoxear-live-native-provider-XXXXXX.tar)
cleanup() {
 docker -H unix:///tmp/codoxear-v2-docker/docker.sock rm -f "$fixture_name" >/dev/null 2>&1 || true
 rm -f "$fixture_archive"
}
trap cleanup EXIT
tar --owner=0 --group=0 --numeric-owner --transform='s,^,work/,' -cf "$fixture_archive" src scripts web tests package.json package-lock.json tsconfig.json vite.config.ts tsup.config.ts

docker -H unix:///tmp/codoxear-v2-docker/docker.sock create --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 --name "$fixture_name" \
 --runtime local-rootless --cgroupns host \
 --cgroup-parent /user.slice/user-1000.slice/user@1000.service/codoxear-v2-test \
 --tmpfs /dev/pts:mode=0755 --tmpfs /work/node_modules/.vite-temp:mode=0755 \
 --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
 -v /opt/codoxear-tools/node:/opt/codoxear-tools/node:ro -v /usr/bin:/usr/bin:ro \
 -v /lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu:ro -v "$PWD/node_modules:/work/node_modules:ro" \
 -v /tmp/codoxear-kimi-native-acceptance/provider.json:/live-provider/provider.json:ro \
 -v /tmp/codoxear-kimi-native-acceptance/tools:/live-tools:rw \
 -v /tmp/codoxear-v2-public/bridge:/egress:ro \
 -e HTTP_PROXY=http://127.0.0.1:19590 -e HTTPS_PROXY=http://127.0.0.1:19590 -e NO_PROXY=localhost,127.0.0.1 \
 -e PATH=/opt/codoxear-tools/node/bin:/usr/bin:/bin \
 -w /work codoxear-v2-test:local /bin/sh -c \
 'mkdir -p artifacts && /usr/bin/mount -t devpts devpts /dev/pts -o newinstance,ptmxmode=0666,mode=0620,gid=0 && exec /opt/codoxear-tools/node/bin/node --import tsx scripts/live-native-provider.ts'
docker -H unix:///tmp/codoxear-v2-docker/docker.sock cp - "$fixture_name":/ < "$fixture_archive"
docker -H unix:///tmp/codoxear-v2-docker/docker.sock start "$fixture_name"
docker -H unix:///tmp/codoxear-v2-docker/docker.sock logs -f "$fixture_name"
mkdir -p artifacts
fixture_exit=$(docker -H unix:///tmp/codoxear-v2-docker/docker.sock wait "$fixture_name")
docker -H unix:///tmp/codoxear-v2-docker/docker.sock logs "$fixture_name" > artifacts/live-native-provider-results.tap
docker -H unix:///tmp/codoxear-v2-docker/docker.sock cp "$fixture_name:/work/artifacts" - | tar -xf - --strip-components=1 -C artifacts
exit "$fixture_exit"

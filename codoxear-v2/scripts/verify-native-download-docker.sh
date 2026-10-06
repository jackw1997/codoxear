#!/bin/bash
# Docker-only native acceptance. Requires installed node_modules and
# the local-rootless test image/tool mounts documented by the active workspace.
# Creates and removes only its own container; networking is disabled.
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
fixture_name="codoxear-native-download-$$"
fixture_archive=$(mktemp /tmp/codoxear-native-download-XXXXXX.tar)
export CODOXEAR_NATIVE_LIFECYCLE_ARCHIVE="$fixture_archive"
cleanup() {
 docker -H unix:///tmp/codoxear-v2-docker/docker.sock rm -f "$fixture_name" >/dev/null 2>&1 || true
 rm -f "$fixture_archive"
}
trap cleanup EXIT
tar --owner=0 --group=0 --numeric-owner --transform='s,^,work/,' -cf "$fixture_archive" src scripts web tests native docs protocol config package.json package-lock.json tsconfig.json vite.config.ts tsup.config.ts

docker -H unix:///tmp/codoxear-v2-docker/docker.sock create --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 --name "$fixture_name" --runtime local-rootless --cgroupns host --cgroup-parent /user.slice/user-1000.slice/user@1000.service/codoxear-v2-test --tmpfs /dev/pts:mode=0755 --tmpfs /work/node_modules/.vite-temp:mode=0755 --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v /opt/codoxear-tools/node:/opt/codoxear-tools/node:ro -v /usr/bin:/usr/bin:ro -v /lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu:ro -v /tmp/codoxear-design-tools:/tmp/codoxear-design-tools:ro -v /tmp/codoxear-design-libs:/tmp/codoxear-design-libs:ro -v /home/codoxear/.cache/ms-playwright/chromium-1140:/home/codoxear/.cache/ms-playwright/chromium-1140:ro -v /home/codoxear/.local/share/claude/versions/2.1.287:/tools/claude:ro -v /tmp/codoxear-kimi-native-acceptance/tools:/tools/native:ro -v "$PWD/node_modules:/work/node_modules:ro" -e PLAYWRIGHT_MODULE=/tmp/codoxear-design-tools/node_modules/playwright/index.mjs -e CHROMIUM_PATH=/home/codoxear/.cache/ms-playwright/chromium-1140/chrome-linux/chrome -e LD_LIBRARY_PATH=/tmp/codoxear-design-libs/root/usr/lib/x86_64-linux-gnu -e FONTCONFIG_FILE=/tmp/codoxear-design-libs/fonts.conf -e PATH=/tools/native:/opt/codoxear-tools/node/bin:/usr/bin:/bin -w /work codoxear-v2-test:local /bin/sh -c 'mkdir -p artifacts && /usr/bin/mount -t devpts devpts /dev/pts -o newinstance,ptmxmode=0666,mode=0620,gid=0 && npm run build && /opt/codoxear-tools/node/bin/node --import tsx --test --test-concurrency=1 tests/download-handoff.test.ts && exec /opt/codoxear-tools/node/bin/node --import tsx scripts/browser-native-download.ts'
docker -H unix:///tmp/codoxear-v2-docker/docker.sock cp - "$fixture_name":/ < "$fixture_archive"
docker -H unix:///tmp/codoxear-v2-docker/docker.sock start "$fixture_name"
docker -H unix:///tmp/codoxear-v2-docker/docker.sock logs -f "$fixture_name"
mkdir -p artifacts
fixture_exit=$(docker -H unix:///tmp/codoxear-v2-docker/docker.sock wait "$fixture_name")
docker -H unix:///tmp/codoxear-v2-docker/docker.sock cp "$fixture_name:/work/artifacts" - | tar -xf - --strip-components=1 -C artifacts
exit "$fixture_exit"

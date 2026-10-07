#!/usr/bin/env bash
# Rebuild a committed source snapshot using an already verified dependency image.
# Dependency manifests, locks and the full build recipe must remain identical.
set -euo pipefail
if (( $# != 3 )); then
  echo 'Usage: refresh-docker.sh <commit> <existing-full-image> <output-image>' >&2
  exit 64
fi
repository=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
commit=$(git -C "$repository" rev-parse --verify --end-of-options "$1^{commit}")
for image in "$2" "$3"; do
  [[ -n "$image" && "$image" != -* && "$image" != *[[:space:]]* ]] || exit 64
done
base=$(docker image inspect --format '{{.Id}}' "$2")
source_label=$(docker image inspect --format '{{index .Config.Labels "org.codoxear.release.commit"}}' "$base")
[[ "$source_label" =~ ^[a-f0-9]{40}$ ]] || { echo 'A full Codoxear release image is required' >&2; exit 65; }
lock_path="/tmp/codoxear-v2-verification-$(id -u).lock"
[[ ! -L "$lock_path" && ( ! -e "$lock_path" || ( -O "$lock_path" && -f "$lock_path" ) ) ]] || exit 73
umask 077
exec 9>>"$lock_path"
flock --nonblock --conflict-exit-code 75 9
temporary=$(mktemp -d /tmp/codoxear-v2-refresh.XXXXXXXX)
container_id=
cleanup() {
  if [[ -n "$container_id" ]]; then docker rm --force "$container_id" >/dev/null || return 1; fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$repository" archive --format=tar --output="$temporary/source.tar" "$commit:codoxear-v2"
container_id=$(docker create --init --user root --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 --network none \
  --env NODE_OPTIONS=--max-old-space-size=768 --env "CODOXEAR_BUILD_COMMIT=$commit" \
  --workdir /opt/codoxear --entrypoint bash "$base" -euc '
    mkdir /tmp/reviewed-source
    tar -xf /tmp/source.tar -C /tmp/reviewed-source
    for file in package.json package-lock.json runtime/oar/package.json runtime/oar/package-lock.json runtime/oar/build-docker.sh; do
      cmp "/tmp/reviewed-source/$file" "/opt/codoxear/$file" || { echo "Dependency/build recipe changed; use full build" >&2; exit 65; }
    done
    node --input-type=module -e '\''
      import { readdir, rm } from "node:fs/promises";
      const keep = new Set(["/opt/codoxear/node_modules", "/opt/codoxear/runtime/oar/node_modules"]);
      async function prune(path) {
        if (keep.has(path)) return;
        if ([...keep].some(k => k.startsWith(path + "/"))) {
          for (const name of await readdir(path)) await prune(path + "/" + name);
        } else await rm(path, {recursive:true,force:true});
      }
      await prune("/opt/codoxear");
    '\''
    tar -xf /tmp/source.tar -C /opt/codoxear
    rm -rf /tmp/source.tar /tmp/reviewed-source
    npm run build
    printf "%s\n" "$CODOXEAR_BUILD_COMMIT" > build-commit.txt
    sha256sum package-lock.json runtime/oar/package-lock.json > build-locks.sha256
  ')
docker cp "$temporary/source.tar" "$container_id:/tmp/source.tar"
status=0
docker start --attach "$container_id" || status=$?
outcome=$(docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$container_id")
[[ "$status" == 0 && "$outcome" == '0 false' ]] || { echo "Refresh failed: $outcome" >&2; exit 1; }
docker commit --change 'USER node' --change 'ENTRYPOINT ["docker-entrypoint.sh"]' \
  --change 'CMD ["node", "dist/server/computer/main.js", "doctor"]' \
  --change "LABEL org.codoxear.release.commit=$commit" \
  --change "LABEL org.codoxear.release.dependency-image=$base" "$container_id" "$3"
echo "Built $3 from $commit with unchanged dependencies from $base"

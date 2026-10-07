# Computer managed runtime

Experimental implementation; not yet release-verified. Requires Node.js 24 and
`@botiverse/oar` exactly 0.13.3. The structural contract was inspected at upstream
commit `07a9c946aabf17e65bf6126f48dd42a4f21cb964`.

Install this directory's dependencies on the Computer only. The initial package
download is blocked in the implementation environment; a resolved lockfile and
native Docker acceptance are release gates. Do not describe this manifest as a
verified reproducible installation. Hub and Client retain their smaller independent
dependency trees.

Enable with `--runtime oar --oar-permission-policy locally-trusted` only after
reviewing that policy: the pinned OAR disables interactive approvals. Unsupported
policies fail before session launch. Worker processes have a 384 MiB JS heap limit,
which is not a total RSS or native subprocess limit. The controller defaults to
two resident workers and 60-second idle retirement; production memory still needs
process-tree measurements and an OS resource envelope before deployment.

### Docker preparation (not yet executed)

`install-docker.sh` provides a Docker-only, serialized dependency workflow with a
2 GiB total container memory ceiling, no swap allowance, two CPUs and 256 tasks.
It shares `/tmp/codoxear-v2-verification-<uid>.lock` with verification. It defaults
to `node:24-bookworm`; `NODE24_IMAGE` may override this with a Node 24 bookworm
tag or digest. Record the resolved image digest in release evidence. The full
bookworm variant includes build tools needed by native
dependencies. Do not substitute a daemon, proxy or alternate Docker socket when
Docker access is unavailable.

On an authorized Docker host with registry access:

```sh
runtime/oar/install-docker.sh resolve-lock
# Save the real registry-resolved runtime/oar/package-lock.json with the release.
runtime/oar/install-docker.sh install
```

Lock resolution disables package scripts and does not launch OAR. Installation
uses `npm ci`, allowing required dependency installation scripts only inside the
bounded container. Both operations write only the mounted `runtime/oar` directory
and the temporary container. They never mount host credentials or start Computer
services. A missing lock fails ordinary installation. This checkout currently has
no resolved OAR lock, so the first command remains an external release blocker.

`Dockerfile` uses the v2 root as its build context, compiles the server entries
including the managed worker, keeps OAR under `runtime/oar` for worker discovery,
and installs both dependency trees using their locks. It intentionally fails when
the OAR lock is absent. The final image contains no frontend build and launches
`doctor` by default as user `node` (uid 1000). Root production dependencies are
currently retained because Computer imports share that manifest; a smaller
Computer-only dependency graph is a separate packaging task.

After the real OAR lock is committed in the v2 snapshot, use the bounded full-v2
builder for a fresh deployment:

```sh
runtime/oar/build-docker.sh <explicit-v2-commit> codoxear-v2-oar:local
```

The revision argument is mandatory. The script verifies the committed v2 subtree
and OAR lock before doing anything with Docker; the legacy branch HEAD is not an
implicit default. It exports only that committed subtree using `git archive`,
never the working tree, host HOME, private profiles or credentials. The shared
verification lock covers the entire build. One exact-owned Docker container runs
apt, both locked npm installs, Chromium with its system dependencies, pinned agent
CLI installation and `npm run build`
under a **2 GiB total memory limit, zero swap allowance, two CPUs and 512 tasks**.
The stopped successful container is committed to the named image; a failed or
OOM-killed build is never committed. Cleanup removes only that owned container
and its temporary archive. No services, agents or listeners are launched.

This full image retains compiled independent Hub, Client and Computer entries,
frontend assets, source scripts, docs and `tsx` dependencies at `/opt/codoxear`,
so fresh deployment can select each role explicitly with a Node command. Its
Chromium assets are available to uid 1000 under `/opt/ms-playwright`, with
`PLAYWRIGHT_BROWSERS_PATH` configured for Docker-only browser verification. Its
default command is read-only Computer `doctor` as user `node`. Runtime deployments
still need their own memory envelopes; build limits are not image runtime limits.
The image records the source commit and exact local base image ID in labels and
stores `build-commit.txt` and lock SHA256 hashes under `/opt/codoxear`. Keep fresh
private configuration external. Carry over only the authorized public addresses
and LiteLLM settings; old private state belongs in its archive, never this image.

The declarative Computer-only Dockerfile is an optional alternative for an
already resource-limited Docker builder:

```sh
docker build --build-arg NODE24_IMAGE="${NODE24_IMAGE:-node:24-bookworm}" \
  -f runtime/oar/Dockerfile -t codoxear-computer-oar:reviewed .
```

The build command itself does **not** impose a builder memory limit. Configure
the builder to a 2 GiB ceiling and run under the shared verification lock before
building on the 8 GiB development target; do not run competing builds/tests.
The Node heap cap in build stages does not bound native build memory. These
sources have not been Docker-built in the current environment. The image digest
and npm locks constrain inputs, but apt package repositories still vary; this is
not a claim of bit-for-bit reproducible images.

The image installs the same exact top-level agent CLI versions as
`Dockerfile.test`: Pi 1.0.0, Codex 0.160.0 and Claude Code 2.1.287. Their global
transitive dependency trees are not locked, so this part of the image remains
non-reproducible until resolved CLI locks/native assets are captured. Check their
executable discovery and native/provider behavior in Docker before release.

`compose.example.yml` supplies a 1536 MiB total Computer envelope with swap
disabled, two CPUs and 256 tasks. `CODOXEAR_OAR_IMAGE` defaults to the local
`codoxear-computer-oar:reviewed` image built above; it may select a release digest.
Set
`CODOXEAR_PRIVATE_HOME` to an existing private directory owned by uid 1000, and
`CODOXEAR_WORKSPACE` to the explicitly authorized workspace. Set paths absolutely.
Keep private config and histories outside the image; never mount the host HOME or
Docker socket. The private home must be persistent and must not replace existing
production profiles or credentials. The container sees the workspace as
`/workspace`, which must also be its enrollment workspace path.

Use one-off `docker compose -f runtime/oar/compose.example.yml run --rm computer
attach ... --workspace /workspace --runtime oar --oar-permission-policy
locally-trusted` only after explicit local trust review. Enrollment still binds to
one independent Hub. Then use the same one-off command with `doctor` to review
setup and the configured policy. `compose up` starts the configured Computer;
neither the Dockerfile nor installer enrolls or starts it automatically. Compose
has no automatic restart so an OOM does not create a repeated recovery loop.

Before calling this deployable, obtain real Node 24 Docker build/install evidence,
capture the OAR and CLI locks, validate all three native runtime/provider/resume
paths and terminal preservation, and measure total Computer/worker/CLI cgroup
memory under load. The bounded envelope may terminate the container rather than
successfully serve every workload; its suitability is unverified.

Provider launch configuration stays in private Computer profile directories.
Pi receives an isolated model directory; Codex uses a private provider config;
Claude uses its provider environment. Native provider and resume behavior still
require integration verification. Interrupted/uncertain delivery is not silently
replayed. Terminal broker sessions remain discoverable through the native adapter.

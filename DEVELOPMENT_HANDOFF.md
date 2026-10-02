# Development handoff — 2026-10-03

This branch is a development snapshot of the HarmonyOS client and related backend work, not a reviewed release. Read `AGENTS.md`, `frontend/harmonyos/README.md`, and `frontend/harmonyos/docs/harmonyos-verification.md` before working. The user sets the next priority; do not automatically deploy this snapshot.

## Included work

- Native HarmonyOS client in `frontend/harmonyos`, with a same-bundle phone updater, source assets, vendored frontend dependencies, and third-party notices.
- Backend support for Huawei push and tests; Claude Code resume-log discovery changes.
- Base commit `3f46731b29013051a76ef6b51724544b9701d9ca` fixes retained Codex user-message projection, completion errors, and known OpenAI model ID casing. Its 195 targeted Docker tests passed; reported failure records were also replayed through a Docker backend and the native emulator UI. That evidence does not establish successful live model inference.

## Pending acceptance

The user requires complete web/native feature and visual parity. Consult the verification matrix for gaps; do not infer full acceptance from the existence of code. Real background Huawei push, TTS, updater operation after unplug/reboot, and remaining parity checks are not all accepted. AppGallery invitation testing was pending review at the last check.

## Build and operational boundaries

Signing secrets, account credentials, SDKs, build outputs, caches and local runtime logs are excluded. Copy `frontend/harmonyos/build-profile.example.json5` to its ignored local configuration only when setting up an authorized build environment. Preserve the installed phone app's identity, signature and data. The current debug entry/updater modules both use versionCode 10000; changing only one requires compatibility review.

The existing Mac has DevEco, signing material and the test emulator; the LXC does not. The updater native binaries and notices are included, but its modified native dependency source/build research remains on the Mac and is not yet a portable reproducible build. Resolve that before claiming independent rebuild capability.

All broker/server/session behavioral testing must remain Docker-isolated as required by `AGENTS.md`. The LXC development user currently cannot access the Docker socket. Source edits do not waive this requirement. Never test on the running production session.

Deploy only an explicitly reviewed commit through `scripts/deploy.sh`. Preserve live brokers, CLI processes, tmux sessions and logs. An independent development clone cannot reuse a deployment worktree belonging to a different Git repository; transfer the accepted commit to the operational source repository before using that existing deployment path.

Machine-specific paths and operational context are recorded separately in `HANDOFF.md` on the LXC. Raft conversation state, reminders and pending OAuth flows are not transferred by Git.

# Native TypeScript migration PR

Suggested title: **Rewrite the Linux v2 runtime in TypeScript and separate Computer, Hub and Client**

## Reviewable PR description

This introduces a self-contained `codoxear-v2/` application with a native TypeScript backend, detached Node PTY brokers, and separate Computer, Hub and Client processes. A Computer connects outward to its selected Hub; the Hub owns accounts and permissions, while the Computer owns CLI sessions, files and Git. Client presentation and shared libraries do not require the other components' private state or a local runtime HTTP server.

The v2 build and runtime do not require Python or the original `codoxear/` package. Existing browser controllers may remain JavaScript. Pi, Codex and Claude Code are external CLI installations, with local authentication and workspace trust reviewed on the Computer. The supported migration target is Linux and Node.js 22.13 or later. This PR preserves the legacy application and deployment alongside the new runtime.

Recorded Docker acceptance includes a fresh v2-only build, 177 passing TypeScript tests with no skips, actual CLI private-provider endpoint/key/model checks, native Codex and Claude browser creation/send/transcript/reload, and trusted Codex resume. Actual Pi browser acceptance covers terminal import, tools during Hub outage, producer-confirmed model/effort changes, interruption, files/Git/CAS/search, queue edits and dispatch, receipt recovery, attachments and private drafts. Delegated workspace access/revocation, membership loss, owner-only deletion and read-only transcript retention also have browser evidence. See `acceptance.json` and `milestone.json` for the exact accepted and excluded workflows. The detailed reconciliation of historical prescriptions and current requirements is in [requirements-reconciliation.md](requirements-reconciliation.md).

This is acceptance of the Linux native migration and listed browser workflows. Full legacy feature parity, production readiness, all native clients, and the entire design roadmap remain open.

## Migration review checklist

- [x] Native runtime, backend and test tools use TypeScript; retained frontend JavaScript is permitted.
- [x] Self-contained source builds without original-package assets or Python helpers.
- [x] Computer, Hub and Client boundaries are checked structurally and exercised independently.
- [x] Detached PTY sessions survive Computer connection restart; session incarnation IDs fence old permissions and recovery state.
- [x] Backend private-provider routing and readiness checks have isolated CLI/browser evidence. Local setup decisions remain explicit.
- [x] Core relay, queue, access and workspace behavior has Docker acceptance.
- [x] Fresh Docker verification of the final source: production build, 177 tests and 46 generic browser checks; zero skipped tests or browser errors.
- [x] Include explicit remaining-work notes below in the PR; avoid claiming all repository Python was removed or full feature parity achieved.

The PR review fixed two native regressions: session metadata edits now persist name/priority/snooze/dependencies without sending a prompt, and unattended injections wait for a completed assistant turn and its idle cooldown. A clean npm install and production build passed with npm configured to an unavailable Python path; npm audit reported zero vulnerabilities. The added Docker CI workflow runs the v2-only build, tests and generic browser suites; its verifier completed locally with exit code 0. The updated Dockerfile itself and the hosted GitHub workflow have not been executed here.

## Remaining parity and acceptance work

These are gaps for a full parity/release claim, rather than a claim that the scoped Linux migration is unimplemented:

- Complete hard broker/queue/Hub commit-boundary restart/fault matrix and broader unattended acceptance. Nine real installed-CLI lifecycle browser checks now cover Pi/Claude saved resume, Codex/Claude terminal import and interruption, service/tunnel reconnect, and untrusted Codex first-use setup. Trusted Codex resume currently lacks live model/effort controls.
- Unified terminal-local and authorized remote queue ordering. The remote durable queue is accepted; it does not implement a single editable queue shared with terminal-local work.
- Broader unattended restart/fault acceptance. Native idle cooldown, staged-attachment protection and exhausted-injection disablement now have detached PTY tests. Name, priority, snooze and dependency fields are session organization metadata; their edit/storage and projection behavior is preserved and tested.
- Live voice speech quality and Safari/device acceptance. Eight actual Chrome browser checks now cover flat Settings, Save/Cancel/Escape, secret masking/preservation/clear, real TTS/ffmpeg HLS playback, opt-out cancellation and browser access-loss cleanup. Controlled tone WAV establishes playback; server listener expiry remains 45 seconds.
- Remaining real-provider tool/reconnect acceptance. Controlled private gateways verify routing and protocol behavior; the user's prior live Kimi conversation on the legacy demo does not establish all native-provider scenarios.
- Broad application accessibility, production load/fault testing and complete public route/platform conformance.

Additional design or platform work remains separate: macOS secure workspace adapter and acceptance; multiple delegated workspace roots and separately authorized delegated Git/upload/transcoding; live Feishu/WeChat/email/SMS configurations; HarmonyOS login/vault/multi-hub presenter and physical-device acceptance; Web Push; later iOS/Android and optional OAR implementations.

Prepared PR branch: `v2/typescript-architecture-pr`, based directly on `origin/main` with only v2 sources and its CI workflow.

The new committed native preview uses separate state at `https://codoxear.gzeek.com:8461/`; earlier previews remain available. The legacy demo at port 8445 and existing sessions remain separate. A preview deployment is not production acceptance. Production remains open pending the remaining acceptance, production configuration and operational gates. See [requirements-reconciliation.md](requirements-reconciliation.md) for the detailed audit and resolved-row classification.

Latest step-by-step outcomes and exact remaining limits are in [work-progress.json](work-progress.json). This iteration also fixes the queued-send idle race, ambiguous native send acknowledgements, current Codex transcript/readiness parsing, Claude multiline canceled-prompt cleanup, voice cancellation/settings races and independent-Hub EventSource CORS. A 257 MiB transport proof and bounded native load/recovery measurements are recorded separately; neither establishes large browser download or production load acceptance.

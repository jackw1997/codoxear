# Native TypeScript migration PR

Suggested title: **Rewrite the Linux v2 runtime in TypeScript and separate Computer, Hub and Client**

## Reviewable PR description

This introduces a self-contained `codoxear-v2/` application with a native TypeScript backend, detached Node PTY brokers, and independently runnable Computer → Hub ← Client boundaries. A Computer connects outward to one selected Hub; each independent Hub owns its accounts, database, signing key and permissions. The client can connect to different Hubs without a mandatory shared identity service.

The v2 build and runtime do not depend on Python or the original `codoxear/` package. Existing browser controllers may remain JavaScript. Linux and Node.js 22 are the accepted native runtime scope. macOS secure workspace support is not yet verified. RAFT-inspired creation exposes Pi, Codex and Claude, with provider URL, API key, model/custom model and relevant launch settings.

Current evidence is recorded by scope in [acceptance.json](acceptance.json) and step-by-step in [work-progress.json](work-progress.json). It includes independent-Hub transfer, five installed-Pi transfer checks, delegated multiple-root/path/Git/upload/transcode browser checks, one-use 257 MiB + 37 byte browser downloads with matching hash, the unified terminal/browser durable queue, and nine installed-CLI Computer SIGKILL launch-boundary checks across Pi, Codex and Claude. The live Kimi/LiteLLM Pi checks cover tools, interruption, outage, reconnect and transfer; an actual Claude Messages tool call succeeded. Codex Responses streaming succeeded, while native Codex shell-tool execution remains unproven.

The Harmony client has a self-contained ArkTS SDK scaffold and mocked OS contracts for login, vault and refresh-token loss, account switching and multiple Hub subscriptions, exercised against two real independent Hub APIs. This is behavioral contract evidence, not an SDK build or device claim. Web Push protocol and Chrome worker show/click behavior pass against a controlled endpoint; vendor delivery and physical OS behavior remain open. Accessibility evidence covers grouped workflows, all nine family/mode appearance combinations, touch targets and font invariants, with measured contrast minima documented in the work ledger.

## Scope and remaining acceptance

The scoped Linux migration and evidenced workflows are reviewable; this is not a full roadmap or production-readiness claim. Remaining work includes live Feishu/WeChat/email/SMS configuration, Harmony SDK compilation/signing/Push Kit and physical-device checks, real vendor and Safari/assistive-technology delivery acceptance, production SLO soak and broader fault coverage, and macOS secure workspace support. iOS, Android and optional OAR scope remains unresolved. The Codex live native shell-tool proof also remains open; basic authenticated Responses streaming is not that proof.

Unattended hard-kill recovery persists budget and uncertainty before dispatch and prevents replay. Recovery keeps unattended work disabled until explicit transcript review. The nine launch SIGKILL checks cover exact Computer launch/receipt boundaries for each installed CLI; they do not establish every broker, queue or Hub mutation boundary.

Prepared PR branch: `v2/typescript-architecture-pr`. GitHub publication is blocked because the connector's `create_blob` request returned `403 Resource not accessible by integration`; no PR has been published. Preview `https://codoxear.gzeek.com:8471/` is prepared and not deployed; the existing preview at port 8461 remains usable. A preview is not production acceptance.

Final isolated verification passed the production build, **235 TypeScript tests** with no failures/skips, and **46 generic browser checks** with no uncaught page errors. Specialized native CLI, live-provider, accessibility and media suites are separately scoped in [work-progress.json](work-progress.json). The updated Dockerfile image build and hosted GitHub workflow have not run here; the equivalent local Docker verifier passed.

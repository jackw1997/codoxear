# Component boundaries

Each deployed component has its own entry point and can run without starting the others.

| Component | Owns | Communicates through |
| --- | --- | --- |
| Browser / optional static host | Appearance, local hub selection, browser credentials, unsent local presentation state | Public hub HTTP/OAuth APIs and WebSocket transport |
| Independent hub | Accounts, signing keys, membership, permissions, invitations, durable catalog and notification inbox | Public browser APIs and authenticated Computer tunnel |
| Computer | One hub attachment, launch receipts, authorized remote queue, account-scoped drafts, local file/Git/media operations | Outbound authenticated tunnel; local native broker sockets |
| Native broker | One CLI PTY, runtime readiness, native session/log binding, local controls | Private Unix socket; backend CLI and its native logs |
| Optional identity service | Deliberately shared account authority for installations selecting that topology | Explicit identity protocol; independent hubs do not require it |

Shared `contracts`, `protocol`, `domain`, `persistence`, `auth` and `presentation` modules are libraries, not mandatory peer processes. Contracts no longer import the identity component, the browser host no longer imports hub implementation, and hub tunnels live in `protocol`. The hub reuses the authentication library in its own process and database.

The Computer's state directory is separate from the CLI authentication home. Sharing an OS account's CLI login must not merge two Computers' broker catalogs or settings. An explicit `nativeStateHome` is available to isolated fixtures and deliberate local configurations.

`scripts/check-boundaries.ts` inspects the import graph during the build. It rejects module imports outside v2, cross-component implementation imports, and Python files. This structural guard is complemented by Docker behavioral tests: standalone static serving, two separately configured hub processes, independent account databases, sibling shutdown, reconnect, authorization revocation, and native broker persistence.

The repository root `AGENTS.md` testing policy applies: behavioral tests run in Docker, and source-text assertions are not used as behavioral evidence. Native CLIs, Git and configured media tools are external executable interfaces. The original Python package and its static asset directory are not application or test dependencies.

Existing legacy deployment processes must be preserved while validating and deploying the migration; changing source ownership does not authorize terminating the user's running agents.

# Codoxear v2

Codoxear v2 keeps the web frontend and backend independently installable and buildable. The browser source is in `frontend/web/`; HarmonyOS source is in `frontend/harmonyos/`. The frontend uses its own `frontend/package.json` and lockfile. The backend uses the root package. The browser calls backend APIs through its own DTOs and does not import backend `src/` implementation modules. No Python or original `codoxear/` package is required.

The supported deployment target for this migration is Linux with Node.js 22.13 or later and a packaged PTY native binary. Secure workspace access uses Linux file descriptors; macOS acceptance and its secure file adapter remain pending. Install Pi, Codex or Claude Code separately on each Computer and complete the CLI's local authentication and workspace trust setup.

```sh
npm ci
npm run build:backend
npm run computer -- attach --hub https://your-hub.example --code YOURCODE --workspace /absolute/workspace
npm run computer -- start
```

To install, build, or serve the web frontend on its own, run `npm ci`, `npm run build`, or `npm start` from `frontend/`. The root `npm run build` coordinates backend and frontend builds and assembles the workspace.

The Computer connects outward to one hub. It runs the native local runtime directly, without a local HTTP server or runtime password. Detached Node brokers own CLI PTYs and persist session metadata. Restarting the Computer connection must preserve those sessions. Deleting a session is an explicit operation.

To start a terminal session or complete native CLI setup through the same runtime, use `npm run computer -- run --backend pi` (or `codex` / `cc`). Ctrl+] opens the shared queue controls: list, add, edit, move, delete, review, back and detach. `detach` preserves the agent; `npm run computer -- terminal SESSION_ID` reconnects its local presenter. Terminal sessions can be discovered and imported from their attached Computer in the browser. Pi readiness requires its initialized bridge, rather than its early startup footer; install its `rg` and `fd` tools locally or let Pi complete its own managed-tool bootstrap.

For an independent-Hub move, stop the Computer connection service and run `npm run computer -- transfer --hub https://destination.example --code OWNER_CODE`. The destination owner issues the code. Durable checkpoints revoke the source binding before admitting the destination; repeating the same transfer recovers lost replies. Native CLI sessions stay alive and are imported explicitly at the destination. A pending transfer blocks connection startup until it is finished.

Run the static browser host with `npm run client`. Run a hub with `CODOXEAR_HUB_CONFIG=/absolute/hub.json npm run hub`; see `config/hub.example.json`. An independent hub owns its accounts, database, signing key and permissions. First start requires the bootstrap credentials documented by its startup error. The optional identity service is for installations deliberately using a separate authority.

File and Git operations belong to the Computer; authorization belongs to the hub. The browser connects to selected hubs using public HTTP/WebSocket protocols. Shared contracts, authentication libraries and presentation helpers do not require another component process or database.

Behavioral verification runs in Docker:

```sh
npm run verify:docker
```

`npm run check:boundaries` checks backend module import boundaries. This is a structural build check, not proof of frontend/backend behavioral isolation or feature parity. Behavioral acceptance and remaining design work are recorded in `docs/milestone.json`. The migration scope and remaining parity gaps are recorded in [docs/pr-readiness.md](docs/pr-readiness.md), with the latest step-by-step [work-progress.json](docs/work-progress.json) and detailed historical-versus-current requirement decisions in [docs/requirements-reconciliation.md](docs/requirements-reconciliation.md). Run `node --import tsx scripts/render-progress.ts` to refresh the phone-readable [progress report](docs/progress.html), published at `/progress.html` on the static client host.

Git is required for Git features. Media and voice features may require their configured external tools or provider; missing tools must produce an explicit error. Provider keys, CLI logs and local runtime state stay outside the release source.

The independent browser client requires **trusted HTTPS**, because browsers reject its connection worker under an invalid certificate even after a user accepts the page warning. A self-signed fixture certificate and browser certificate exception establish isolated test behavior only.

The updated native preview uses the existing trusted gateway: [client](https://codoxear.gzeek.com:8445/), [guide](https://codoxear.gzeek.com:8444/guide), and [readable progress](https://codoxear.gzeek.com:8445/progress.html). The gateway certificate and configuration remain unchanged. The loopback router in `scripts/demo-trusted-forward.ts` forwards new traffic to the native preview and configured legacy Computer connections to their original Hubs. Existing CLI processes remain running; the new native preview has a separate session catalog and browser users may need to sign in again. Opaque legacy OAuth refresh bodies use the default route. The optional `deploy/install-preview-https.sh` creates a separate trusted gateway when one is needed; it is unnecessary for this endpoint reuse.

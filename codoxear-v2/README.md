# Codoxear v2

Codoxear v2 keeps the web frontend and backend independently installable and buildable. The browser source is in `frontend/web/`; HarmonyOS source is in `frontend/harmonyos/`. The frontend uses its own `frontend/package.json` and lockfile. The backend uses the root package. The browser calls backend APIs through its own DTOs and does not import backend `src/` implementation modules. No Python or original `codoxear/` package is required.

The supported deployment target for this migration is Linux with Node.js 24 or later and a packaged PTY native binary. Secure workspace access uses Linux file descriptors; macOS acceptance and its secure file adapter remain pending. Install Pi, Codex or Claude Code separately on each Computer and complete the CLI's local authentication and workspace trust setup.

```sh
npm ci
npm run build:backend
npm run computer -- attach --hub https://your-hub.example --code YOURCODE \
  --workspace /absolute/workspace --runtime oar \
  --oar-permission-policy locally-trusted --oar-max-resident 1
npm run computer -- start
```

To install, build, or serve the web frontend on its own, run `npm ci`, `npm run build`, or `npm start` from `frontend/`. The root `npm run build` coordinates backend and frontend builds and assembles the workspace.

The Computer connects outward to one hub. It runs the native local runtime directly, without a local HTTP server or runtime password. Detached Node brokers own CLI PTYs and persist session metadata. Restarting the Computer connection must preserve those sessions. Deleting a session is an explicit operation.

To start a terminal session or complete native CLI setup through the same runtime, use `npm run computer -- run --backend pi` (or `codex` / `cc`). Ctrl+] opens the shared queue controls: list, add, edit, move, delete, review, back and detach. `detach` preserves the agent; `npm run computer -- terminal SESSION_ID` reconnects its local presenter. Terminal sessions can be discovered and imported from their attached Computer in the browser. Pi readiness requires its initialized bridge, rather than its early startup footer; install its `rg` and `fd` tools locally or let Pi complete its own managed-tool bootstrap.

For an independent-Hub move, stop the Computer connection service and run `npm run computer -- transfer --hub https://destination.example --code OWNER_CODE`. The destination owner issues the code. Durable checkpoints revoke the source binding before admitting the destination; repeating the same transfer recovers lost replies. Native CLI sessions stay alive and are imported explicitly at the destination. A pending transfer blocks connection startup until it is finished.

Run the static browser host with `npm run client`. Run a Hub with `CODOXEAR_HUB_CONFIG=/absolute/hub.json npm run hub`; see [`config/hub.example.json`](config/hub.example.json). Each independent Hub owns its accounts, database, signing key and permissions. Configure Google or Feishu using real application credentials and register the exact provider callback before sign-in; see [provider setup](docs/provider-login.md). No password, email-code or phone-code login is offered.

A new Hub uses a private, expiring, single-use initialization URL. Open the generated URL and choose Google or Feishu independently; the first successful allowed-provider callback assigns the verified identity as Owner and consumes the link. There is no separate setup-code form, and an ordinary public visitor cannot claim ownership. Keep initialization URLs private. Later ordinary sign-in recognizes the same verified identity as Owner.

In the client, open Hubs & computers → Add hub and enter its URL. Enabled providers appear as parallel sign-in choices. Every saved identity stays active for that Hub; resources are deduplicated, and each operation uses an individual identity with the required permission. Hub owners/admins create expiring, single-use Member invitation links and manage Computer allowlists. The recipient opens the link, signs in with an allowed provider, then explicitly joins; the recipient need not already have an account or exchange internal identity IDs. Inviting a person grants Hub membership only. The Owner promotes members to Admin separately. Every person, including owners/admins, needs explicit Computer access before using agents. File access requires a separate approved workspace grant.

Add computer creates the Hub record and a pairing code in the browser. Install, attach and start the Computer service on its Linux machine using the CLI; the browser cannot install that service. [Fresh setup instructions](deploy/fresh-v2/README.md) describe the generated `private/initialization.json`, component images, external provider configuration and private deployment state. The optional identity service is for installations deliberately using a separate authority.

File and Git operations belong to the Computer; authorization belongs to the hub. The browser connects to selected hubs using public HTTP/WebSocket protocols. Shared contracts, authentication libraries and presentation helpers do not require another component process or database.

Behavioral verification runs in Docker:

```sh
npm run verify:docker
```

`npm run check:boundaries` checks backend module import boundaries. This is a structural build check, not proof of frontend/backend behavioral isolation or feature parity. Behavioral acceptance and remaining design work are recorded in `docs/milestone.json`. The migration scope and remaining parity gaps are recorded in [docs/pr-readiness.md](docs/pr-readiness.md), with the latest step-by-step [work-progress.json](docs/work-progress.json) and detailed historical-versus-current requirement decisions in [docs/requirements-reconciliation.md](docs/requirements-reconciliation.md). Run `node --import tsx scripts/render-progress.ts` to refresh the phone-readable [progress report](docs/progress.html), published at `/progress.html` on the static client host.

Git is required for Git features. Media and voice features may require their configured external tools or provider; missing tools must produce an explicit error. Provider keys, CLI logs and local runtime state stay outside the release source.

The independent browser client requires **trusted HTTPS**, because browsers reject its connection worker under an invalid certificate even after a user accepts the page warning. A self-signed fixture certificate and browser certificate exception establish isolated test behavior only.

The public frontend is available on [8444](https://codoxear.gzeek.com:8444/) and the preserved [8445 client origin](https://codoxear.gzeek.com:8445/), with [readable progress](https://codoxear.gzeek.com:8445/progress.html). The browser customer journey exercises the exact public 8444 assets with isolated controlled-provider Hubs; that verifies the UI journey, not real Google/Feishu applications. Fresh deployments preserve the public origins and existing LiteLLM settings without importing old accounts or catalogs. Real provider application credentials remain external configuration. See the progress report for the deployed version and observed acceptance.

Current daily-user acceptance uses `scripts/browser-customer-journey.ts` inside the serialized, memory-bounded Docker verification environment. It creates humans, Computers, invitations, allowlists and agents through the browser interface. Infrastructure/provider fixtures and local Computer service startup are reported separately. Historical password/account-portal demos are retired; they are not a setup path or current acceptance evidence.

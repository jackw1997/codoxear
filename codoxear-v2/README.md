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

A new Hub requires a private random `setupToken` of at least 32 characters. Generate it with `openssl rand -hex 32` and store it only in the private Hub configuration. First sign in with a configured provider, then enter that setup code to claim ownership. The code requires a fresh verified provider sign-in and can claim ownership only once. Public registration alone grants no membership or Computer access. After setup, invite other registered provider identities and grant the required Computer access separately.

For the prepared two-Hub deployment, [fresh setup instructions](deploy/fresh-v2/README.md) explain the generated `private/setup.json` and preprovisioned Computers. The optional identity service is for installations deliberately using a separate authority.

File and Git operations belong to the Computer; authorization belongs to the hub. The browser connects to selected hubs using public HTTP/WebSocket protocols. Shared contracts, authentication libraries and presentation helpers do not require another component process or database.

Behavioral verification runs in Docker:

```sh
npm run verify:docker
```

`npm run check:boundaries` checks backend module import boundaries. This is a structural build check, not proof of frontend/backend behavioral isolation or feature parity. Behavioral acceptance and remaining design work are recorded in `docs/milestone.json`. The migration scope and remaining parity gaps are recorded in [docs/pr-readiness.md](docs/pr-readiness.md), with the latest step-by-step [work-progress.json](docs/work-progress.json) and detailed historical-versus-current requirement decisions in [docs/requirements-reconciliation.md](docs/requirements-reconciliation.md). Run `node --import tsx scripts/render-progress.ts` to refresh the phone-readable [progress report](docs/progress.html), published at `/progress.html` on the static client host.

Git is required for Git features. Media and voice features may require their configured external tools or provider; missing tools must produce an explicit error. Provider keys, CLI logs and local runtime state stay outside the release source.

The independent browser client requires **trusted HTTPS**, because browsers reject its connection worker under an invalid certificate even after a user accepts the page warning. A self-signed fixture certificate and browser certificate exception establish isolated test behavior only.

The public deployment addresses are [client](https://codoxear.gzeek.com:8445/), [guide](https://codoxear.gzeek.com:8444/guide), and [readable progress](https://codoxear.gzeek.com:8445/progress.html). Fresh deployments preserve those origins and the existing configured LiteLLM endpoint, key and model. They do not import old accounts or session catalogs. Provider application credentials are external configuration; a real Google or Feishu sign-in remains unavailable until an administrator supplies them. See the progress report for the deployed version and observed acceptance.

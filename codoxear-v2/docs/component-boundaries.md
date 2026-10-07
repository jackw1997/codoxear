# Component boundaries

Each deployed component has its own entry point and can run without starting the others. The web frontend source lives in `frontend/web/`; the HarmonyOS source lives in `frontend/harmonyos/`. The web frontend has its own `package.json` and lockfile in `frontend/`, so dependency installation and frontend build/serve can run independently of the backend.

| Component | Owns | Communicates through |
| --- | --- | --- |
| Browser / optional static host (`frontend/web/`) | Appearance, local hub selection, browser credentials, unsent local presentation state | Public hub HTTP/OAuth APIs and WebSocket transport |
| HarmonyOS client (`frontend/harmonyos/`) | Native HarmonyOS presentation and platform integration | Shared public protocol and its own platform APIs |
| Independent hub | Accounts, signing keys, membership, permissions, invitations, durable catalog and notification inbox | Public browser APIs and authenticated Computer tunnel |
| Computer | One hub attachment, launch receipts, authorized remote queue, account-scoped drafts, local file/Git/media operations | Outbound authenticated tunnel; local native broker sockets |
| Native broker | One CLI PTY, runtime readiness, native session/log binding, local controls | Private Unix socket; backend CLI and its native logs |
| Optional identity service | Deliberately shared account authority for installations selecting that topology | Explicit identity protocol; independent hubs do not require it |

Frontend and each backend component have their own package manifests, lockfiles and build entry points. `frontend/` owns the web package; `components/{computer,hub,identity,server}/` owns each backend release template. From an extracted component package, `npm ci`, `npm run build` and `npm start` install, build and start that component. The root package coordinates development builds; it is not required by an extracted release. The browser talks to backend services through public APIs and frontend-owned DTOs; it must not import backend `src/` implementation modules.

Shared `contracts`, `protocol`, `domain`, `persistence`, `auth` and `presentation` modules are libraries, not mandatory peer processes. Contracts no longer import the identity component, the browser host no longer imports hub implementation, and hub tunnels live in `protocol`. The hub reuses the authentication library in its own process and database.

The Computer's state directory is separate from the CLI authentication home. Sharing an OS account's CLI login must not merge two Computers' broker catalogs or settings. An explicit `nativeStateHome` is available to isolated fixtures and deliberate local configurations.

`scripts/check-boundaries.ts` traverses each component entry point's entire source dependency closure and checks its declared shared libraries. It rejects a dependency on peer backend source even when the edge passes through a shared library. It also rejects shared-library imports back into component implementation, frontend imports outside its package, backend imports into frontend source, and Python files. These are architecture checks. Runtime acceptance still requires Docker tests of installed releases and the real browser interface.

The repository root `AGENTS.md` testing policy applies: behavioral tests run in Docker, and source-text assertions are not used as behavioral evidence. Native CLIs, Git and configured media tools are external executable interfaces. The original Python package and its static asset directory are not application or test dependencies.

Preserve unrelated services, legacy deployment processes and host sessions. The scoped R41 authorization permits stopping owned Codoxear demo/test containers while retaining their data; source ownership changes do not broaden that authorization.

## Standalone release packages and explicit UI integration

`scripts/package-component.ts` exports a reviewed Git tree's exact transitive TypeScript source closure for Computer, Hub, Identity or Server. Each archive contains its own manifest, minimal pinned dependencies, lockfile, build script, Dockerfile and release provenance. Computer also contains its declared OAR installer inputs. Archives exclude peer components, frontend sources/assets, repository development tools and private configuration. `scripts/package-computer.mjs` uses this exporter rather than exporting the complete v2 tree. The browser transport SDK belongs to `frontend/shared/`; there is no backend `src/client` directory.

Hub, Identity and Server start their APIs without UI assets. Optional browser compatibility routes consume a separately compiled frontend artifact declared by the absolute `frontendAssetsRoot` configuration or `CODOXEAR_FRONTEND_ASSETS_ROOT` environment variable. The bundle has `web/`, `workspace/`, `identity/` and `client/` directories and should be mounted read only. Backends do not discover `dist/` relative to their working directory or read frontend source. Without an artifact, UI entry routes report `404 ui_unavailable`. Identity's cache guide is now a frontend-owned artifact at `identity/cache-design.html`, produced by the independent frontend build. This preserves existing cookies, popup login, PKCE and authenticated gateways while making the runtime attachment explicit.

Authentication, domain and persistence libraries may contain behavior: an independent Hub executes those declared libraries against its own database and signing key. Sharing their implementation does not require a peer Identity process or shared database. OAR `0.13.3` has its own pinned dependency lock and Computer-owned worker processes; native and OAR adapters are Computer internals.

The older `artifacts/package-isolation.json` with two containers establishes only frontend versus aggregate-backend build separation. It predates these individual packages and cannot prove their runtime independence. The expanded verifier and smoke helpers are implemented for five clean installs/builds and standalone startup/API checks, followed by `scripts/package-browser-oauth.ts` against the installed frontend and Hub packages. That browser proof exercises actual popup password login, PKCE exchange, an authenticated computer creation and persisted login/catalog after reload. It imports no root application source. The new package/runtime/browser acceptance is pending the coordinating Docker run; update the evidence record only after that run completes. Static checks already passed during implementation. All verification remains serialized through the shared lock with a 2 GiB container limit and no swap.

The full Docker regression at `cf891ea5` passed 302 tests with zero failures/skips, and the complete `verify-container.ts` browser runner exited successfully. That is current evidence for API/asset-boundary behavior and existing repository integration fixtures, distinct from the pending clean extracted-package proof.

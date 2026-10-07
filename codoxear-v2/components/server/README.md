# Codoxear server compatibility

This is an independently installable source package. It contains only this component's entry points and the source closure of its declared shared libraries. No frontend, peer backend or local configuration is included.

Requires Node.js 24 or newer. From this extracted directory:

```sh
npm ci
npm run build
npm start
```

This package provides the retained catalog server compatibility API. It has no Client or Computer runtime package. Configure external database and bootstrap credentials before first start.

Build its own container with `docker build -t codoxear-server .`. Mount private configuration, persistent data and any explicitly requested assets at runtime. Container configuration is external to the source archive.

The image runs as UID 1000 and defaults `CODOXEAR_V2_DATABASE` to `/home/node/.local/share/codoxear-v2/server/catalog.sqlite`. Mount persistent state at `/home/node/.local/share/codoxear-v2/server`, owned by UID 1000. To use another state location, set `CODOXEAR_V2_DATABASE` to an absolute writable path and mount its parent directory. Bootstrap credentials remain external environment configuration.

For optional browser compatibility routes, set `CODOXEAR_FRONTEND_ASSETS_ROOT` to an absolute path containing a separately built frontend asset bundle (`web/`, `workspace/`, `identity/`, `client/`). Mount it read only in the backend container. Without that explicit integration, the backend starts independently and provides its API; browser assets remain the frontend package's responsibility.

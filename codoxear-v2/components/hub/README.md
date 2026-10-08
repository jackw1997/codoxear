# Codoxear hub

This is an independently installable source package. It contains only this component's entry points and the source closure of its declared shared libraries. No frontend, peer backend or local configuration is included.

Requires Node.js 24 or newer. From this extracted directory:

```sh
npm ci
npm run build
npm start
```

Set `CODOXEAR_HUB_CONFIG` to a private Hub configuration file. This Hub owns its account authority, database and signing key. Client assets are hosted independently; optional compatibility asset hosting requires an explicitly configured external asset directory.

Build its own container with `docker build -t codoxear-hub .`. Mount private configuration, persistent data and any explicitly requested assets at runtime. Container configuration is external to the source archive.

For optional browser compatibility routes, set `CODOXEAR_FRONTEND_ASSETS_ROOT` to an absolute path containing a separately built frontend asset bundle (`web/`, `workspace/`, `identity/`, `client/`). Mount it read only in the backend container. Without that explicit integration, the backend starts independently and provides its API; browser assets remain the frontend package's responsibility.

# Codoxear identity

This is an independently installable source package. It contains only this component's entry points and the source closure of its declared shared libraries. No frontend, peer backend or local configuration is included.

Requires Node.js 24 or newer. From this extracted directory:

```sh
npm ci
npm run build
npm start
```

This optional compatibility service requires `CODOXEAR_IDENTITY_CONFIG` pointing to a private configuration file. Independent Hubs provide their own account authority and do not need this service.

Build its own container with `docker build -t codoxear-identity .`. Mount private configuration, persistent data and any explicitly requested assets at runtime. Container configuration is external to the source archive.

For optional browser compatibility routes, set `CODOXEAR_FRONTEND_ASSETS_ROOT` to an absolute path containing a separately built frontend asset bundle (`web/`, `workspace/`, `identity/`, `client/`). Mount it read only in the backend container. Without that explicit integration, the backend starts independently and provides its API; browser assets remain the frontend package's responsibility.

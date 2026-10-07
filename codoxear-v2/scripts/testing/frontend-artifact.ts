import { fileURLToPath } from "node:url";

// Integration fixtures attach a separately built frontend release explicitly.
// Children inherit this absolute declaration; backend production defaults remain
// API-only and never search the repository or working directory for assets.
process.env.CODOXEAR_FRONTEND_ASSETS_ROOT ??= fileURLToPath(
  new URL("../../frontend/dist/", import.meta.url),
);

export const fixtureFrontendAssetsRoot = process.env.CODOXEAR_FRONTEND_ASSETS_ROOT;

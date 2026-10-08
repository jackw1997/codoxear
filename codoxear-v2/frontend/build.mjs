import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
await rm("dist", { recursive: true, force: true });
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
const source = resolve("web/legacy"),
  destination = resolve("dist/workspace");
await mkdir(destination, { recursive: true });
// Keep established rendering controllers; all new profile/storage/relay code is TypeScript.
await cp(source, destination, {
  recursive: true,
  filter: (path) => !path.endsWith(".map") && !path.includes("/dist/") &&
    !(dirname(path) === source && /^(?:app|app_.*)\.js$/.test(basename(path))),
});
// Lazy PDF workers are public assets; controller modules belong only in bundles.
for (const name of ["pdf.mjs", "pdf.worker.mjs"])
  await cp(resolve(source, "vendor", name), resolve(destination, name));
await build({
  entryPoints: [resolve("web/workspace/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: resolve(destination, "dist/app.bundle.js"),
  plugins: [
    {
      name: "connection-scoped-storage",
      setup(b) {
        b.onResolve(
          {
            filter:
              /app_(application|transcript|session_lifecycle|session_refresh)\.js$/,
          },
          (args) => ({
            path: resolve(source, args.path.split("/").pop()),
          }),
        );
        b.onResolve({ filter: /^\.\/app_storage\.js$/ }, () => ({
          path: resolve("web/workspace/storage.ts"),
        }));
      },
    },
  ],
});
// Shared component styles are bundled with their owning UI library, so its
// JavaScript and CSS source changes both invalidate immutable page assets.
const versionHash = createHash("sha256").update(
  await readFile(resolve(destination, "dist/app.bundle.js")),
);
for (const path of (
  await readdir(source, { recursive: true, withFileTypes: true })
)
  .filter((entry) => entry.isFile())
  .sort((a, b) =>
    (a.parentPath + a.name).localeCompare(b.parentPath + b.name),
  )) {
  if (path.parentPath.includes("/dist")) continue;
  versionHash.update(await readFile(resolve(path.parentPath, path.name)));
}
const assetVersion = versionHash.digest("hex").slice(0, 16);
let html = await readFile(resolve(destination, "index.html"), "utf8");
html = html
  .replaceAll("__CODOXEAR_ASSET_VERSION__", assetVersion)
  .replaceAll("__CODOXEAR_ATTACH_MAX_BYTES__", String(256 * 1024 * 1024));
await writeFile(resolve(destination, "index.html"), html);

await build({
  entryPoints: [resolve("web/identity/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: resolve("dist/identity/account.js"),
});
await cp(resolve("web/help/cache-design.html"), resolve("dist/identity/cache-design.html"));
// Share the established theme engine and styles verbatim across account and hub UI.
for (const root of ["dist/client/appearance", "dist/identity/appearance"]) {
  await mkdir(root, { recursive: true });
  for (const file of ["app.css", "app_theme.js", "themes", "favicon.svg"])
    await cp(resolve(source, file), resolve(root, file), { recursive: true });
  await cp(resolve("web/shared/shell.css"), resolve(root, "shell.css"));
  await cp(resolve("web/client/views.css"), resolve(root, "connections.css"));
}
const identityVersion = createHash("sha256")
  .update(await readFile("dist/identity/account.js"))
  .update(await readFile("web/shared/shell.css"))
  .update(assetVersion)
  .digest("hex")
  .slice(0, 16);
await writeFile(
  "dist/identity/index.html",
  (await readFile("web/identity/index.html", "utf8"))
    .replaceAll('/account.js"', `/account.js?v=${identityVersion}"`)
    .replace(/(\/appearance\/[^"?]+)"/g, `$1?v=${identityVersion}"`),
);

// The independent client is just the original UI plus a local multi-hub transport.
await cp(destination, resolve("dist/client"), { recursive: true });
await build({
  entryPoints: [resolve("web/client/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: resolve("dist/client/dist/app.bundle.js"),
  plugins: [
    {
      name: "client-storage",
      setup(b) {
        b.onResolve({ filter: /app_new_session\.js$/ }, () => ({
          path: resolve("web/client/agent-dialog.ts"),
        }));
        b.onResolve({ filter: /^\.\/app_file_download\.js$/ }, () => ({
          path: resolve("web/client/download.ts"),
        }));
        b.onResolve(
          {
            filter:
              /app_(application|transcript|session_lifecycle|session_refresh)\.js$/,
          },
          (args) => ({ path: resolve(source, args.path.split("/").pop()) }),
        );
        b.onResolve({ filter: /^\.\/app_storage\.js$/ }, () => ({
          path: resolve("web/workspace/storage.ts"),
        }));
      },
    },
  ],
});
await build({
  entryPoints: [resolve("web/client/worker.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: resolve("dist/client/client-worker.js"),
});
await cp(
  resolve("web/client/views.css"),
  resolve("dist/client/connections.css"),
);
await cp(
  resolve("web/shared/shell.css"),
  resolve("dist/client/agent-creation.css"),
);
const clientVersion = createHash("sha256")
  .update(await readFile("dist/client/dist/app.bundle.js"))
  .update(await readFile("dist/client/client-worker.js"))
  .update(await readFile("web/client/views.css"))
  .update(await readFile("web/shared/shell.css"))
  .update(assetVersion)
  .digest("hex")
  .slice(0, 16);
await writeFile(
  "dist/client/index.html",
  html
    .replace(
      "</head>",
      `<link rel="stylesheet" href="/connections.css?v=${clientVersion}"></head>`,
    )
    .replaceAll(assetVersion, clientVersion)
    .replaceAll(" https://cdn.jsdelivr.net", "")
    .replace("font-src 'self'", "font-src 'self' data:")
    .replace(
      "connect-src 'self'",
      "connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-src 'self' https: http://127.0.0.1:* http://localhost:*",
    ),
);
await writeFile("dist/client/client-release.json", JSON.stringify({ version: clientVersion }) + "\n");

await build({
  entryPoints: [resolve("web/client/hub-login.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: resolve("dist/client/hub-login.js"),
});
const hubLoginVersion = createHash("sha256")
  .update(await readFile("dist/client/hub-login.js"))
  .update(await readFile("web/client/views.css"))
  .update(assetVersion)
  .digest("hex")
  .slice(0, 16);
await writeFile(
  "dist/client/hub-login.html",
  (await readFile("web/client/hub-login.html", "utf8"))
    .replaceAll('/hub-login.js"', `/hub-login.js?v=${hubLoginVersion}"`)
    .replace(/(\/appearance\/[^"?]+)"/g, `$1?v=${hubLoginVersion}"`),
);

await build({
  entryPoints: [resolve("web/client/callback.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: resolve("dist/client/client-callback.js"),
  plugins: [
    {
      name: "callback-theme",
      setup(b) {
        b.onResolve({ filter: /app_theme\.js$/ }, () => ({
          path: resolve(source, "app_theme.js"),
        }));
      },
    },
  ],
});

// Compatibility API listeners attach the same current client, never a second UI.
await cp(resolve("dist/client"), resolve("dist/web"), { recursive: true });

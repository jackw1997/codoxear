import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("./dist/client/", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};
const context = JSON.stringify({
  issuer: "local-client",
  accountId: "device",
  hubId: "local",
  computerId: "all",
});
const callback =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect hub · Codoxear</title><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/connections.css"></head><body><main class="connectionLoginWrap"><section class="connectionLogin" id="callback"><h1>Connect hub</h1><p class="connectionHint" role="status">Completing hub sign-in…</p></section></main><script type="module" src="/client-callback.js"></script></body></html>';
export function createStaticServer() {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    response.setHeader("Cache-Control", "no-cache");
    const send = (status, type, body) => {
      response.writeHead(status, { "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD")
      return send(405, "application/json", '{"error":"Method not allowed"}');
    try {
      const raw = (request.url ?? "/").split("?")[0];
      let path;
      try {
        path = decodeURIComponent(raw);
      } catch {
        return send(400, "application/json", '{"error":"Invalid asset path"}');
      }
      if (
        !path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("%") ||
        path.includes("\0") ||
        path.split("/").some((p) => p === "." || p === "..")
      )
        return send(400, "application/json", '{"error":"Invalid asset path"}');
      if (path === "/health")
        return send(
          200,
          "application/json",
          '{"ok":true,"service":"static-client","accounts":false}',
        );
      if (path === "/auth-callback") {
        response.setHeader("Cache-Control", "no-store");
        return send(200, "text/html; charset=utf-8", callback);
      }
      if (/^\/(api|oauth|gateway)(\/|$)/.test(path))
        return send(
          404,
          "application/json",
          '{"error":"The hub connection has not started. Reload this page to reconnect."}',
        );
      path = path.replace(/^\/static\//, "/");
      if (path === "/guide" || path === "/design") path = "/guide.html";
      if (path === "/") path = "/index.html";
      const file = resolve(root, "." + path);
      if (!file.startsWith(root + sep))
        return send(403, "application/json", '{"error":"Invalid asset path"}');
      const actual = await realpath(file);
      if (!actual.startsWith(root + sep))
        return send(403, "application/json", '{"error":"Invalid asset path"}');
      let body = await readFile(actual);
      if (path === "/index.html")
        body = body
          .toString("utf8")
          .replace(
            "<head>",
            '<head><script type="application/json" id="codoxear-connection-context">' +
              context +
              "</script>",
          );
      if (path === "/index.html" || path === "/client-release.json")
        response.setHeader("Cache-Control", "no-store");
      if (path === "/client-callback.js")
        response.setHeader("Cache-Control", "no-store");
      else if (path === "/client-worker.js")
        response.setHeader("Service-Worker-Allowed", "/");
      else if (path.includes(".js") && (request.url ?? "").includes("?v="))
        response.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      send(200, types[extname(file)] ?? "application/octet-stream", body);
    } catch (error) {
      send(
        error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500,
        "application/json",
        '{"error":"Workspace asset not found"}',
      );
    }
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createStaticServer();
  server.listen(
    Number(process.env.CODOXEAR_CLIENT_PORT ?? 19520),
    process.env.CODOXEAR_CLIENT_HOST ?? "127.0.0.1",
  );
  process.on("SIGTERM", () => server.close());
  process.on("SIGINT", () => server.close());
}

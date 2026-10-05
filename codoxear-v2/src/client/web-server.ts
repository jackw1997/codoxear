import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { workspaceAsset } from "../presentation/workspace-assets.js";
// Optional static-file host. It has no accounts, hub registry, credentials,
// database, permission decisions, or proxy routes. Any HTTPS static host works.
const app = Fastify();
app.addHook("onSend", async (_r, reply, payload) => {
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("Content-Security-Policy", "frame-ancestors 'none'");
  return payload;
});
app.get("/design", async (_r, reply) =>
  reply
    .type("text/html")
    .header("Cache-Control", "no-cache")
    .send(await readFile("docs/independent-hubs.html")),
);
app.get("/health", async () => ({
  ok: true,
  service: "static-client",
  accounts: false,
}));
app.get("/auth-callback", async (_r, reply) =>
  reply
    .type("text/html")
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect hub · Codoxear</title><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/connections.css"></head><body><main class="connectionLoginWrap"><section class="connectionLogin" id="callback"><h1>Connect hub</h1><p class="connectionHint" role="status">Completing hub sign-in…</p></section></main><script type="module" src="/client-callback.js"></script></body></html>',
    ),
);
app.get("/client-callback.js", async (_r, reply) =>
  reply
    .type("text/javascript")
    .header("Cache-Control", "no-store")
    .send(await readFile("dist/client/client-callback.js")),
);
app.get("/client-worker.js", async (_r, reply) =>
  reply
    .type("text/javascript")
    .header("Cache-Control", "no-cache")
    .header("Service-Worker-Allowed", "/")
    .send(await readFile("dist/client/client-worker.js")),
);
app.get("/*", async (r, reply) => {
  const path = (r.params as { "*": string })["*"];
  if (
    path.startsWith("api/") ||
    path.startsWith("oauth/") ||
    path.startsWith("gateway/")
  )
    return reply.code(404).send({
      error:
        "The hub connection has not started. Reload this page to reconnect.",
    });
  const asset = await workspaceAsset("dist/client", path, {
    issuer: "local-client",
    accountId: "device",
    hubId: "local",
    computerId: "all",
  });
  return reply
    .type(asset.type)
    .header(
      "Cache-Control",
      path.includes(".js") && r.url.includes("?v=")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    )
    .send(asset.body);
});
await app.listen({
  host: process.env.CODOXEAR_CLIENT_HOST ?? "127.0.0.1",
  port: Number(process.env.CODOXEAR_CLIENT_PORT ?? 19520),
});
process.on("SIGTERM", () => void app.close());
process.on("SIGINT", () => void app.close());

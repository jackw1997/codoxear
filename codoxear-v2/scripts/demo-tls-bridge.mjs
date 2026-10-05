// Preserve TLS end-to-end between isolated demo processes and the host gateway.
import { createServer, connect } from "node:net";
import { unlink, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
const [mode, directory] = process.argv.slice(2);
if (!["host", "container"].includes(mode) || !directory) throw new Error("Usage: demo-tls-bridge.mjs host|container <private socket directory>");
const servers = [];
const base = Number(process.env.CODOXEAR_DEMO_PUBLIC_PORT_BASE ?? 8444);
if (!Number.isSafeInteger(base) || base < 1024 || base > 65531) throw new Error("Invalid public port base");
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const port of [base, base + 1, base + 2, base + 3]) {
  const socket = join(directory, "tls-" + port + ".sock");
  if (mode === "host") await unlink(socket).catch(e => { if (e.code !== "ENOENT") throw e; });
  const server = createServer(input => {
    const output = mode === "host" ? connect(port, "127.0.0.1") : connect(socket);
    input.on("error", () => output.destroy()); output.on("error", () => input.destroy());
    input.pipe(output).pipe(input); input.on("close", () => output.destroy()); output.on("close", () => input.destroy());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); if (mode === "host") server.listen(socket, resolve); else server.listen(port, "127.0.0.1", resolve); });
  if (mode === "host") await chmod(socket, 0o600);
  servers.push(server);
}
console.log("TLS demo bridge ready:", mode);
const stop = () => { for (const server of servers) server.close(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

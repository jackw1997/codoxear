// Deploy the account/web layer independently of the demo's Computers and CLIs.
import { existsSync } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
if (!existsSync("/.dockerenv")) throw new Error("Docker only");
const socket = "/demo-bridge/web.sock";
const children = [
  spawn(
    process.execPath,
    ["scripts/demo-tls-bridge.mjs", "container", "/demo-bridge"],
    { stdio: "inherit" },
  ),
  spawn(process.execPath, ["dist/server/identity/main.js"], {
    env: {
      ...process.env,
      CODOXEAR_IDENTITY_CONFIG: "/demo-data/identity.json",
    },
    stdio: "inherit",
  }),
];
await unlink(socket).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
const server = createServer((input) => {
  const output = connect(19520, "127.0.0.1");
  input.on("error", () => output.destroy());
  output.on("error", () => input.destroy());
  input.pipe(output).pipe(input);
  input.on("close", () => output.destroy());
  output.on("close", () => input.destroy());
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socket, resolve);
});
await chmod(socket, 0o600);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
};
for (const child of children)
  child.once("exit", (code) => {
    if (!stopping) {
      process.exitCode = code || 1;
      stop();
    }
  });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

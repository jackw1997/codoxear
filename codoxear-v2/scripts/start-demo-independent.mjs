// New hub/static-web processes only. Existing Computers and CLIs stay in their container.
import { existsSync } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
if (!existsSync("/.dockerenv")) throw new Error("Docker only");
const children = [
  spawn(
    process.execPath,
    ["scripts/demo-tls-bridge.mjs", "container", "/demo-bridge"],
    { stdio: "inherit" },
  ),
  spawn(process.execPath, ["frontend/serve.mjs"], {
    stdio: "inherit",
  }),
];
for (let i = 0; i < 2; i++)
  children.push(
    spawn(process.execPath, ["dist/server/hub/main.js"], {
      env: {
        ...process.env,
        CODOXEAR_HUB_CONFIG: `/demo-data/independent/hub-${i}.json`,
      },
      stdio: "inherit",
    }),
  );
const servers = [];
for (const [name, port] of [
  ["independent-web", 19520],
  ["independent-hub-0", 19530],
  ["independent-hub-1", 19531],
]) {
  const socket = "/demo-bridge/" + name + ".sock";
  await unlink(socket).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  const server = createServer((input) => {
    const output = connect(port, "127.0.0.1");
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
  servers.push(server);
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
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

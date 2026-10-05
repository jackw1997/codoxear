// Loopback-only transport from the host to the isolated Docker demo's Unix sockets.
import { createServer, connect } from "node:net";
import { join } from "node:path";
const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: node scripts/demo-forward.mjs <private socket directory>",
  );
const identitySocket = process.argv[3] ?? "19520.sock";
const hubSockets = [
  process.argv[4] ?? "19530.sock",
  process.argv[5] ?? "19531.sock",
];
if (
  ![identitySocket, ...hubSockets].every((name) =>
    /^[A-Za-z0-9_.-]+\.sock$/.test(name),
  )
)
  throw new Error("Invalid identity socket");
const servers = [];
for (const port of [19500, 19520, 19530, 19531]) {
  const server = createServer((input) => {
    const output = connect(
      join(
        directory,
        port === 19520
          ? identitySocket
          : port >= 19530
            ? hubSockets[port - 19530]
            : port + ".sock",
      ),
    );
    input.on("error", () => output.destroy());
    output.on("error", () => input.destroy());
    input.pipe(output).pipe(input);
    input.on("close", () => output.destroy());
    output.on("close", () => input.destroy());
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    for (const s of servers) s.close();
  });
  server.listen(port, "127.0.0.1");
  servers.push(server);
}
console.log("Demo forwarded on loopback ports 19500, 19520, 19530, 19531");
const stop = () => {
  for (const s of servers) s.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

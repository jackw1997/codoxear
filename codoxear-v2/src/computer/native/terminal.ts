import { connect } from "node:net";
import { socketPath } from "./paths.js";
import type { NativeRuntime } from "./runtime.js";
/** Foreground presenter only: disconnecting never owns or terminates the session. */
export async function presentTerminal(
  runtime: NativeRuntime,
  localId: string,
): Promise<void> {
  if (!/^broker-[a-f0-9]{32}$/.test(localId))
    throw Error("Unknown native session");
  const socket = connect(socketPath(runtime.stateHome, localId));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const wasRaw = process.stdin.isRaw;
  let incoming = "";
  const input = (data: Buffer) => {
    if (data.includes(0x1d)) {
      socket.end();
      return;
    }
    socket.write(
      JSON.stringify({ type: "input", data: data.toString("utf8") }) + "\n",
    );
  };
  const resize = () =>
    socket.write(
      JSON.stringify({
        type: "resize",
        cols: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 40,
      }) + "\n",
    );
  socket.write(JSON.stringify({ operation: "attach" }) + "\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", input);
  process.stdout.on("resize", resize);
  resize();
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    incoming += chunk;
    let boundary;
    while ((boundary = incoming.indexOf("\n")) >= 0) {
      const line = incoming.slice(0, boundary);
      incoming = incoming.slice(boundary + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === "output") process.stdout.write(message.data);
      } catch {}
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("end", resolve);
      socket.once("close", resolve);
      socket.once("error", reject);
    });
  } finally {
    process.stdin.off("data", input);
    process.stdout.off("resize", resize);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    socket.destroy();
  }
}

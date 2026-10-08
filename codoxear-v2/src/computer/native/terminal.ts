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
  let commandMode = false,
    commandLine = "",
    commands = Promise.resolve();
  const menu = () =>
    process.stdout.write(
      "\r\nCodoxear queue: list | add TEXT | edit N TEXT | delete N | move N POSITION | review N | back | detach\r\n(queue)> ",
    );
  const runCommand = async (line: string) => {
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line.trim());
    const action = match?.[1] ?? "list",
      argument = match?.[2] ?? "";
    if (action === "back") {
      socket.write(
        JSON.stringify({ type: "queue_mode", active: false }) + "\n",
      );
      commandMode = false;
      process.stdout.write("\r\nReturning to native terminal.\r\n");
      return;
    }
    if (action === "detach") {
      socket.end();
      return;
    }
    try {
      const snapshot = await runtime.queueControl(localId, "queue");
      const items = snapshot.items as Array<{
        id: string;
        text: string;
        origin: string;
        version: number;
        commit_unknown: boolean;
        sending: boolean;
        pause_reason?: string;
      }>;
      if (action === "add")
        await runtime.queueControl(localId, "enqueue", { text: argument });
      else if (["edit", "delete", "move", "review"].includes(action)) {
        const [position, ...rest] = argument.split(" ");
        const item = items[Number(position) - 1];
        if (!item) throw Error("Choose an item number from list");
        await runtime.queueControl(
          localId,
          `queue/${action === "edit" ? "update" : action === "review" ? "delete" : action}`,
          {
            id: item.id,
            version: item.version,
            ...(action === "edit" ? { text: rest.join(" ") } : {}),
            ...(action === "move" ? { to_index: Number(rest[0]) - 1 } : {}),
            ...(action === "review" ? { allow_commit_unknown: true } : {}),
          },
        );
      } else if (!["list", "help"].includes(action))
        throw Error("Unknown queue command; type help");
      const next = (await runtime.queueControl(localId, "queue"))
        .items as typeof items;
      process.stdout.write(
        "\r\n" +
          (next.length
            ? next
                .map(
                  (item, index) =>
                    `${index + 1}. [${item.origin}; ${item.commit_unknown ? "UNKNOWN: review transcript before review/remove" : item.sending ? "sending" : (item.pause_reason ?? "pending")}] ${item.text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`,
                )
                .join("\r\n")
            : "Queue empty") +
          "\r\n",
      );
    } catch (error) {
      process.stdout.write(
        `\r\n${error instanceof Error ? error.message : "Queue operation failed"}\r\n`,
      );
    }
    if (commandMode) menu();
  };
  const input = (data: Buffer) => {
    if (commandMode) {
      for (const character of data.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          const line = commandLine;
          commandLine = "";
          commands = commands.then(() => runCommand(line));
        } else if (character === "\x7f" || character === "\b") {
          if (commandLine.length) {
            commandLine = commandLine.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (character >= " " && commandLine.length < 200000) {
          commandLine += character;
          process.stdout.write(character);
        }
      }
      return;
    }
    if (data.includes(0x1d)) {
      socket.write(JSON.stringify({ type: "queue_mode", active: true }) + "\n");
      commandMode = true;
      commandLine = "";
      menu();
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
  process.stdout.write(
    "\r\nCodoxear: Ctrl-] opens queue controls (help, back, detach). Detach keeps this session running.\r\n",
  );
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

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ManagedSession } from "./driver.js";
import { oarInputId } from "./input-id.js";

let session: ManagedSession | undefined;
let input = "",
  opening = false;
const write = (value: unknown) => {
  const line = JSON.stringify(value) + "\n";
  if (
    Buffer.byteLength(line) > 1024 * 1024 ||
    process.stdout.writableLength > 2 * 1024 * 1024
  )
    process.exit(74);
  process.stdout.write(line);
};
// Keep third-party console output off the framed control channel.
console.log = (...args: unknown[]) => console.error(...args);
async function receive(message: any) {
  try {
    let value: unknown;
    if (message.op === "open") {
      if (opening || session) throw Error("Already open");
      opening = true;
      let module: any;
      try {
        // Separately pinned Computer runtime dependencies; no dependency in Hub or Client.
        let path = dirname(fileURLToPath(import.meta.url)),
          root: string | undefined;
        for (let i = 0; i < 8; i++) {
          const candidate = join(path, "runtime/oar/load.mjs");
          if (existsSync(candidate)) {
            root = dirname(candidate);
            break;
          }
          path = dirname(path);
        }
        if (!root) throw Error("package");
        const pkg = JSON.parse(
          readFileSync(
            join(root, "node_modules/@botiverse/oar/package.json"),
            "utf8",
          ),
        );
        if (pkg.version !== "0.13.3") throw Error("version");
        module = await import(pathToFileURL(join(root, "load.mjs")).href);
      } catch {
        write({
          id: message.id,
          setup: true,
          error:
            "Install the pinned @botiverse/oar 0.13.3 Computer runtime package before enabling managed sessions",
        });
        return;
      }
      const runtime = module.runtimes.require(
        message.args.backend === "cc" ? "claude" : message.args.backend,
      );
      const installation = await runtime.installation?.();
      if (!installation || installation.kind !== "available") {
        write({
          id: message.id,
          setup: true,
          error: "The selected agent runtime is not installed on this Computer",
        });
        return;
      }
      session = await runtime.session(installation, message.args);
      session!.rawEvents((record) => write({ event: record }), {
        sessionId: session!.id,
        afterSeq: -1,
      });
      value = { id: session!.id };
    } else if (message.op === "dispose") {
      await session?.dispose();
      write({ id: message.id, value: null });
      process.exit(0);
    } else {
      if (!session) throw Error("Not open");
      const result =
        message.op === "prompt"
          ? await session.prompt(message.args.text, {
              inputId: oarInputId(message.args.inputId),
            })
          : message.op === "abort"
            ? await session.abort()
            : null;
      if (!result) throw Error("Unknown command");
      value = { kind: result.kind, code: result.code }; // Native error text can contain credentials.
    }
    write({ id: message.id, value });
  } catch {
    write({
      id: message.id,
      ...(message.op === "open" ? { setup: true } : {}),
      error:
        message.op === "open"
          ? "Managed runtime initialization failed; verify the local model, effort, provider and resume configuration"
          : "Managed runtime operation failed; inspect the local runtime configuration and durable receipt",
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(74);
  for (let end = input.indexOf("\n"); end >= 0; end = input.indexOf("\n")) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    try {
      void receive(JSON.parse(line));
    } catch {
      process.exit(74);
    }
  }
});
process.stdin.on("end", () => {
  void session?.dispose().finally(() => process.exit(0));
  if (!session) process.exit(0);
});

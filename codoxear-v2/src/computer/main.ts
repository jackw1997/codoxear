import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { NativeRuntime } from "./native/runtime.js";
import { presentTerminal } from "./native/terminal.js";
import { enrollmentInput } from "./enrollment.js";
import { createComputerApi } from "./api.js";
const home = resolve(
  process.env.CODOXEAR_COMPUTER_HOME ??
    join(homedir(), ".local/share/codoxear-v2/computer"),
);
const api = createComputerApi(home),
  [command = "help", argument] = process.argv.slice(2);
try {
  if (command === "attach") {
    const input =
      !argument || argument.startsWith("--")
        ? await enrollmentInput(process.argv.slice(3))
        : JSON.parse(await readFile(resolve(argument), "utf8"));
    if (input.enrollment) await api.enroll(input);
    else await api.attach(input);
    console.log("Attached. Run computer start to connect.");
  } else if (command === "run") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: {
      backend: { type: "string", default: "pi" },
      workspace: { type: "string" },
      name: { type: "string", default: "Terminal session" },
      launch: { type: "string" },
    } });
    if (!["pi", "codex", "cc"].includes(values.backend!))
      throw new Error("Choose pi, codex or cc as the backend");
    const attachment = await import("./config.js").then(module => module.readAttachment(home));
    const workspace = resolve(values.workspace ?? attachment?.workspacePath ?? process.cwd());
    const runtime = new NativeRuntime(attachment?.nativeHome ?? homedir(), workspace, attachment?.nativeStateHome ?? home);
    const launch = values.launch ? JSON.parse(await readFile(resolve(values.launch), "utf8")) : {};
    const session = await runtime.createTerminal(values.backend as "pi" | "codex" | "cc", values.name!, launch);
    console.log("Session " + session.localId + ". Press Ctrl+] to detach; the agent keeps running.");
    try { await presentTerminal(runtime, session.localId); } finally { runtime.close(); }
  } else if (command === "start") {
    const service = api.service((status) =>
      console.log(JSON.stringify(status)),
    );
    await service.start();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void service.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else if (command === "status")
    console.log(JSON.stringify(await api.status(), null, 2));
  else if (command === "doctor")
    console.log(JSON.stringify(await api.doctor(), null, 2));
  else if (command === "detach") {
    await api.detach();
    console.log(
      "Local attachment removed. Revoke the previous computer credential at its hub before reassignment.",
    );
  } else
    console.log(
      "Codoxear Computer\nCommands: attach [--hub <HTTPS origin> --code <8-character code> --workspace <path>], start, status, doctor, detach\nTerminal: run [--backend pi|codex|cc --workspace <path> --name <name> --launch <private JSON file>]\nAdvanced: attach <private config.json>\nStart runs in the foreground for an OS supervisor. Closing it does not kill agent sessions managed by the detached native broker.",
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Computer command failed",
  );
  process.exitCode = 1;
}

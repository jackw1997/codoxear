import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { normalizePairingCode } from "../contracts/pairing.js";

/** Pairing binds the local native runtime to one hub; no local HTTP server is required. */
export async function enrollmentInput(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      hub: { type: "string" },
      code: { type: "string" },
      workspace: { type: "string" },
      runtime: { type: "string", default: "native" },
      "oar-permission-policy": { type: "string" },
    },
  });
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: !!process.stdin.isTTY,
  });
  try {
    const hub = values.hub ?? (await prompt.question("Hub address: "));
    const code = values.code ?? (await prompt.question("Attach code: "));
    const workspacePath = resolve(
      values.workspace ??
        ((await prompt.question("Agent workspace [current directory]: ")) ||
          process.cwd()),
    );
    const origin = new URL(hub).origin;
    if (hub.replace(/\/$/, "") !== origin)
      throw new Error("Use the hub origin without a path");
    if (!["native", "oar"].includes(values.runtime!))
      throw Error("Choose native or oar as the Computer runtime");
    if (
      values.runtime === "oar" &&
      values["oar-permission-policy"] !== "locally-trusted"
    )
      throw Error(
        "OAR bypasses interactive native permissions. After explicit local trust review, pass --oar-permission-policy locally-trusted; otherwise use native.",
      );
    return {
      enrollment: { identityUrl: origin, code: normalizePairingCode(code) },
      runtime: values.runtime as "native" | "oar",
      ...(values.runtime === "oar"
        ? { oarPermissionPolicy: "locally-trusted" as const }
        : {}),
      workspacePath,
    };
  } finally {
    muted = false;
    prompt.close();
  }
}

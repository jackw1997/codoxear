// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
if (!existsSync("/.dockerenv"))
  throw new Error("Verification must run in Docker");
const run = (args, capture = false, evidence) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "";
    if (capture)
      child.stdout.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    child.once("error", reject);
    child.once("exit", async (code) => {
      try {
        if (evidence) await writeFile(evidence, output);
        if (code === 0) resolve(output);
        else reject(new Error(`Command exited ${code}`));
      } catch (error) {
        reject(error);
      }
    });
  });
const { readdir, mkdir, writeFile } = await import("node:fs/promises");
await mkdir("artifacts", { recursive: true });
await run(
  [
    "--import",
    "tsx",
    "--test",
    ...(await readdir("tests"))
      .filter((x) => x.endsWith(".test.ts"))
      .map((x) => "tests/" + x),
  ],
  true,
  "artifacts/tests.tap",
);
const hub = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/browser-server.ts"],
  { stdio: "inherit" },
);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch("http://127.0.0.1:17430/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error("Hub did not start");
  await run(["--import", "tsx", "scripts/browser-verification.ts"]);
} finally {
  if (hub.exitCode === null && hub.signalCode === null) {
    const stopped = new Promise((r) => hub.once("exit", r));
    hub.kill("SIGTERM");
    await stopped;
  }
}
await run(["--import", "tsx", "scripts/browser-identity.ts"]);
const distributed = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/distributed-fixture.ts"],
  { stdio: "inherit" },
);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch("http://127.0.0.1:19431/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error("Independent hubs did not start");
  await run(["--import", "tsx", "scripts/browser-distributed.ts"]);
} finally {
  if (distributed.exitCode === null && distributed.signalCode === null) {
    const stopped = new Promise((r) => distributed.once("exit", r));
    distributed.kill("SIGTERM");
    await stopped;
  }
}
await run(["scripts/render-evidence.mjs"]);
await run(["--import", "tsx", "scripts/browser-agent-creation.ts"]);

await run(["--import", "tsx", "scripts/browser-invitations.ts"]);

// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
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
const suite = process.env.CODOXEAR_VERIFICATION_SUITE ?? "full";
if (suite !== "full" && suite !== "managed")
  throw new Error("Unknown verification suite: " + suite);
const files = (await readdir("tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .filter(
    (name) =>
      suite === "full" || /^(managed-|delegation|fresh-deployment)/.test(name),
  )
  .sort()
  .map((name) => "tests/" + name);
if (!files.length) throw new Error("No verification tests selected");
await run(
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  true,
  suite === "managed" ? "artifacts/managed-tests.tap" : "artifacts/tests.tap",
);
// This slice includes its browser test; avoid unrelated preview stacks while
// diagnosing the managed runtime. Full product acceptance remains separate.
if (suite === "managed") process.exit(0);
// Customer acceptance creates identities and grants through the current web UI.
await run(["--import", "tsx", "scripts/browser-customer-journey.ts"]);
// Private initialization and provider-only sessions exercise the independent Hub login flow.
await run(["--import", "tsx", "scripts/browser-registration.ts"]);
await run(["--import", "tsx", "scripts/browser-agent-creation.ts"]);

await run(["--import", "tsx", "scripts/browser-invitations.ts"]);
await run(["--import", "tsx", "scripts/browser-client-updates.ts"]);
await run(["scripts/render-evidence.mjs"]);

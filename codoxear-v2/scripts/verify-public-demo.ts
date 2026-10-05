// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
if (!existsSync("/.dockerenv")) throw new Error("Docker only");
const children = [];
const start = (command, args) => { const child = spawn(command, args, { stdio: "inherit", env: process.env }); children.push(child); return child; };
try {
  start("/usr/local/bin/caddy", ["run", "--config", "/public/tls-test/Caddyfile", "--adapter", "caddyfile"]);
  start(process.execPath, ["--import", "tsx", "scripts/demo.ts"]);
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try { ready = (await fetch("https://" + process.env.CODOXEAR_DEMO_PUBLIC_HOST + ":8444", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("TLS demo did not start");
  const browser = start(process.execPath, ["--import", "tsx", process.env.CODOXEAR_BROWSER_SCRIPT ?? "scripts/browser-demo.ts"]);
  const code = await new Promise(resolve => browser.once("exit", resolve));
  if (code !== 0) throw new Error("Public demo browser verification failed");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}

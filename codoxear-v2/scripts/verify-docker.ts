// Linux verification coordinator: one owned fixture at a time, including cleanup.
// Application behavior is exercised only inside Docker.
import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const uid = process.getuid?.();
if (uid === undefined) throw Error("The verification coordinator requires Linux");
const held = process.argv[2] === "--locked";
const project = process.argv[held ? 3 : 2] ?? `codoxear-v2-check-${uid}`;
if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw Error("Invalid verification project name");
const lockPath = `/tmp/codoxear-v2-verification-${uid}.lock`;
let active: ReturnType<typeof spawn> | undefined;
const forward = (signal: NodeJS.Signals) => {
  if (active?.exitCode === null && active.signalCode === null) active.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
async function run(command: string, args: string[], timeoutMs?: number): Promise<number> {
  const child = spawn(command, args, { cwd: root, stdio: "inherit" });
  active = child;
  let force: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutMs ? setTimeout(() => {
    child.kill("SIGTERM");
    force = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, timeoutMs) : undefined;
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (force) clearTimeout(force);
    if (active === child) active = undefined;
  });
}
if (!held) {
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (info.uid !== uid || !info.isFile()) throw Error("Verification lock must be an owned regular file");
  } finally { closeSync(fd); }
  const code = await run("flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "75", lockPath, process.execPath, "--experimental-strip-types", script, "--locked", project]);
  if (code === 75) console.error("Another v2 verification is running. Wait for it to finish before starting another heavy fixture.");
  process.exitCode = code;
} else {
  const args = ["compose", "--project-name", project, "-f", join(root, "compose.test.yml")];
  let code = 1;
  try {
    code = await run("docker", [...args, "up", "--build", "--abort-on-container-exit", "--exit-code-from", "verification"]);
  } finally {
    const cleanup = await run("docker", [...args, "down", "--volumes", "--timeout", "10"], 30000).catch(() => 1);
    if (cleanup !== 0) {
      console.error(`Verification cleanup failed for owned project ${project}; inspect it before launching another fixture.`);
      if (code === 0) code = cleanup;
    }
  }
  process.exitCode = code;
}

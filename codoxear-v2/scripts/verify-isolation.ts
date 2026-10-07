// Each package is installed and built in a clean, memory-bounded Docker container.
import { spawn, execFileSync } from "node:child_process";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const locked = args[0] === "--locked";
if (locked) args.shift();
if (args.length !== 1) throw Error("Usage: verify-isolation.ts <committed snapshot>");
const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", args[0] + "^{commit}"], { cwd: root, encoding: "utf8" }).trim();
const lock = `/tmp/codoxear-v2-verification-${process.getuid!()}.lock`;
async function run(command: string, parameters: string[]) {
  const child = spawn(command, parameters, { cwd: root, stdio: "inherit" });
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("exit", code => code === 0 ? done() : fail(Error(`${command} exited ${code}`)));
  });
}
if (!locked) {
  const fd = openSync(lock, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const info = fstatSync(fd); closeSync(fd);
  if (info.uid !== process.getuid!() || !info.isFile()) throw Error("Invalid verification lock");
  await run("flock", ["--no-fork", "--nonblock", lock, process.execPath, "--experimental-strip-types", fileURLToPath(import.meta.url), "--locked", commit]);
} else {
  const temporary = await mkdtemp("/tmp/codoxear-isolation-");
  const checks: string[] = [];
  try {
    for (const component of ["frontend", "backend"] as const) {
      const archive = resolve(temporary, component + ".tar");
      const tree = commit + ":codoxear-v2" + (component === "frontend" ? "/frontend" : "");
      execFileSync("git", ["archive", "--format=tar", "--output=" + archive, tree,
        ...(component === "backend" ? ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.backend.json", "tsup.config.ts", "src", "scripts/generate-protocol.ts"] : [])], { cwd: repository });
      const command = component === "frontend"
        ? "npm run build && npm test"
        : "npm run build:backend && test -f dist/server/hub/main.js && test -f dist/server/computer/main.js";
      const id = execFileSync("docker", ["create", "--init", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "512",
        "--env", "NODE_OPTIONS=--max-old-space-size=768", "--workdir", "/package", "node:24-bookworm", "bash", "-euc",
        `tar -xf /tmp/package.tar -C /package; rm /tmp/package.tar; npm ci --no-audit --no-fund; ${command}`], { encoding: "utf8" }).trim();
      try {
        await run("docker", ["cp", archive, id + ":/tmp/package.tar"]);
        await run("docker", ["start", "--attach", id]);
        const outcome = execFileSync("docker", ["inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", id], { encoding: "utf8" }).trim();
        if (outcome !== "0 false") throw Error(`${component} isolation failed: ${outcome}`);
        checks.push(component + " independently installs and builds without peer source or dependencies");
      } finally { await run("docker", ["rm", "--force", id]); }
    }
    await mkdir(resolve(root, "artifacts"), { recursive: true });
    await writeFile(resolve(root, "artifacts/package-isolation.json"), JSON.stringify({ passed: true, commit, checks, memoryLimitMiB: 2048, swap: false }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

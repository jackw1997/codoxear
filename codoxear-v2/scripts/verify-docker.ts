// Linux verification coordinator: one owned fixture at a time, including cleanup.
// Application behavior is exercised only inside Docker.
import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const uid = process.getuid?.();
if (uid === undefined) throw Error("The verification coordinator requires Linux");
const options = process.argv.slice(2);
const held = options[0] === "--locked";
if (held) options.shift();
const managed = options[0] === "--managed";
if (managed) options.shift();
let image: string | undefined;
if (options[0] === "--image") {
  options.shift();
  image = options.shift();
  if (!image || image.startsWith("-") || /\s/.test(image)) throw Error("Invalid verification image");
}
const project = options.shift() ?? `codoxear-v2-check-${uid}`;
if (options.length) throw Error("Usage: verify-docker.ts [--managed] [--image image] [project]");
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
  const code = await run("flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "75", lockPath, process.execPath, "--experimental-strip-types", script, "--locked", ...(managed ? ["--managed"] : []), ...(image ? ["--image", image] : []), project]);
  if (code === 75) console.error("Another v2 verification is running. Wait for it to finish before starting another heavy fixture.");
  process.exitCode = code;
} else {
  // Do not build or attempt project cleanup until the selected daemon responds.
  const available = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 10000);
  if (available !== 0) {
    console.error("The selected Docker daemon is unavailable. Restore it before starting verification.");
    process.exit(available);
  }
  process.env.CODOXEAR_VERIFICATION_SUITE = managed ? "managed" : "full";
  if (image) {
    // Use the image built by runtime/oar/build-docker.sh without another,
    // unbounded Compose build. No provider credentials or private state mounts.
    const temporary = await mkdtemp("/tmp/codoxear-v2-verification-");
    const cidfile = join(temporary, "container-id");
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    let code = 1;
    try {
      code = await run("docker", ["run", "--init", "--cidfile", cidfile,
        "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "512",
        "--network", "none", "--shm-size", "256m", "--user", `${uid}:${process.getgid!()}`,
        "--env", `CODOXEAR_VERIFICATION_SUITE=${managed ? "managed" : "full"}`,
        "--mount", `type=bind,src=${artifacts},dst=/opt/codoxear/artifacts`,
        "--workdir", "/opt/codoxear", "--entrypoint", "node", image,
        "--import", "tsx", "scripts/verify-container.ts"]);
    } finally {
      const id = (await readFile(cidfile, "utf8").catch(() => "")).trim();
      if (/^[a-f0-9]{64}$/.test(id)) {
        const cleaned = await run("docker", ["rm", "--force", id], 30000).catch(() => 1);
        if (cleaned !== 0) {
          console.error(`Owned verification container cleanup failed: ${id}`);
          if (code === 0) code = cleaned;
        }
      }
      await rm(temporary, { recursive: true, force: true });
    }
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
}

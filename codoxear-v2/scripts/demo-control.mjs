// Lifecycle for the installed local demo; configuration is generated at handoff.
import { readFile, writeFile, open } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
const path = resolve(".data/demo-environment.json");
const config = JSON.parse(await readFile(path, "utf8"));
const guide = config.guideOrigin ?? "http://127.0.0.1:19500/";
const action = process.argv[2] ?? "status";
if (!["start", "stop", "status"].includes(action))
  throw new Error("Usage: node scripts/demo-control.mjs [start|stop|status]");
function docker(args) {
  const result = spawnSync("docker", ["-H", config.dockerHost, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || "Docker action failed");
  return result.stdout.trim();
}
async function ownsProcess(pid, script) {
  if (!pid || !script) return false;
  try {
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    return args.includes(script) && args.includes(config.bridge);
  } catch {
    return false;
  }
}
const ownsForwarder = () =>
  ownsProcess(config.forwardPid, config.forwardScript);
if (action === "stop") {
  if (config.webContainer) console.log(docker(["stop", config.webContainer]));
  console.log(docker(["stop", config.container]));
  for (const old of config.drainingForwarders ?? [])
    if (await ownsProcess(old.pid, old.script))
      process.kill(old.pid, "SIGTERM");
  if (await ownsForwarder()) process.kill(config.forwardPid, "SIGTERM");
  if (await ownsProcess(config.tlsBridgePid, config.tlsBridgeScript))
    process.kill(config.tlsBridgePid, "SIGTERM");
  console.log(
    "Stopped only the isolated demo and its recorded forwarder. Demo data remains on disk.",
  );
} else if (action === "start") {
  if (
    config.tlsBridgeScript &&
    !(await ownsProcess(config.tlsBridgePid, config.tlsBridgeScript))
  ) {
    const log = await open(resolve(".data/demo-tls-bridge.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [config.tlsBridgeScript, "host", config.bridge],
      { detached: true, stdio: ["ignore", log.fd, log.fd] },
    );
    config.tlsBridgePid = child.pid;
    child.unref();
    await log.close();
    await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  console.log(docker(["start", config.container]));
  if (config.webContainer) console.log(docker(["start", config.webContainer]));
  if (!(await ownsForwarder())) {
    const log = await open(resolve(".data/demo-forward.log"), "a", 0o600);
    const processHandle = spawn(
      process.execPath,
      [
        config.forwardScript,
        config.bridge,
        config.identitySocket ?? "19520.sock",
        ...(config.hubSockets ?? []),
      ],
      { detached: true, stdio: ["ignore", log.fd, log.fd] },
    );
    config.forwardPid = processHandle.pid;
    processHandle.unref();
    await log.close();
    await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  console.log(
    `Demo starting: ${guide}. Stopping the container ends its CLI processes; create new agents after a complete container restart.`,
  );
} else {
  console.log(
    docker([
      "inspect",
      "--format",
      "{{.Name}}: {{.State.Status}}",
      config.container,
    ]),
  );
  if (config.webContainer)
    console.log(
      docker([
        "inspect",
        "--format",
        "{{.Name}}: {{.State.Status}}",
        config.webContainer,
      ]),
    );
  if (config.webCommit) console.log("Web snapshot:", config.webCommit);
  console.log("Snapshot:", config.commit);
  console.log("Forwarder:", (await ownsForwarder()) ? "running" : "stopped");
  if (config.tlsBridgeScript)
    console.log(
      "TLS bridge:",
      (await ownsProcess(config.tlsBridgePid, config.tlsBridgeScript))
        ? "running"
        : "stopped",
    );
  console.log("Guide:", guide);
}

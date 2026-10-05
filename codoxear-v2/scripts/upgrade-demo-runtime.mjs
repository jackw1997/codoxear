// Docker-only side-by-side controller upgrade. Existing broker/CLI processes survive.
import { existsSync, openSync } from "node:fs";
import {
  readFile,
  writeFile,
  cp,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { spawn } from "node:child_process";
if (!existsSync("/.dockerenv")) throw new Error("Docker only");
const [mode] = process.argv.slice(2),
  release = "/provider-release";
const manifest =
  mode === "authenticated"
    ? "/live/provider-release.json"
    : "/demo-data/provider-release.json";
if (existsSync(manifest)) {
  const previous = JSON.parse(await readFile(manifest, "utf8"));
  const args = await readFile(
    `/proc/${previous.supervisorPid}/cmdline`,
    "utf8",
  ).catch(() => "");
  if (
    args.includes(release + "/codoxear-v2/scripts/upgrade-demo-runtime.mjs") &&
    args.split("\0").includes(mode)
  ) {
    console.log("Matching runtime upgrade already running");
    process.exit(0);
  }
}
await symlink(
  "/work/node_modules",
  release + "/codoxear-v2/node_modules",
  "dir",
).catch((e) => {
  if (e.code !== "EEXIST") throw e;
});
const homes =
  mode === "authenticated"
    ? [{ home: "/live", port: 19559 }]
    : [
        { home: "/demo-data/c0", port: 19553 },
        { home: "/demo-data/c1", port: 19554 },
        { home: "/demo-data/c2", port: 19555 },
      ];
const environment = async (pid) =>
  Object.fromEntries(
    (await readFile(`/proc/${pid}/environ`, "utf8"))
      .split("\0")
      .filter(Boolean)
      .map((s) => {
        const at = s.indexOf("=");
        return [s.slice(0, at), s.slice(at + 1)];
      }),
  );
async function findComputer(home) {
  for (let attempt = 0; attempt < 300; attempt++) {
    for (const pid of (await readdir("/proc")).filter((p) => /^\d+$/.test(p))) {
      try {
        const args = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if (
          args.includes("computer/main.js") &&
          (await environment(pid)).CODOXEAR_COMPUTER_HOME === home + "/computer"
        )
          return Number(pid);
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Original Computer did not start");
}
const children = [],
  parked = [];
const log = openSync(
  mode === "authenticated"
    ? "/live/provider-release.log"
    : "/demo-data/provider-release.log",
  "a",
  0o600,
);
const start = (exe, args, env, cwd) => {
  const p = spawn(exe, args, {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["ignore", log, log],
  });
  children.push(p);
  return p;
};
const proxyEnv = {
  HTTP_PROXY: "http://127.0.0.1:19590",
  HTTPS_PROXY: "http://127.0.0.1:19590",
  NO_PROXY: "localhost,127.0.0.1,::1",
  NODE_USE_ENV_PROXY: "1",
};
const network = start(
  process.execPath,
  [
    release + "/codoxear-v2/scripts/demo-provider-network.mjs",
    "container",
    "/demo-bridge/provider-egress.sock",
  ],
  {},
  release,
);
const own = {
  release,
  mode,
  supervisorPid: process.pid,
  networkPid: network.pid,
  children: [],
  parked,
};
try {
  for (const row of homes) {
    row.oldComputerPid = await findComputer(row.home);
    const oldEnv = await environment(row.oldComputerPid);
    const oldArgs = await readFile(
      `/proc/${row.oldComputerPid}/cmdline`,
      "utf8",
    );
    if (
      !oldArgs.includes("computer/main.js") ||
      oldEnv.CODOXEAR_COMPUTER_HOME !== row.home + "/computer"
    )
      throw new Error(
        "Original Computer identity changed; refusing to signal it",
      );
    // Install tools before accepting the first prompt; Pi otherwise downloads them during TUI startup.
    const tools = start(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {ensureTool} from "/opt/codoxear-tools/node/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js"; for(const tool of ["fd","rg"]) if(!await ensureTool(tool)) process.exitCode=1;',
      ],
      {
        ...oldEnv,
        ...proxyEnv,
        HOME: row.home,
        TAR_OPTIONS: "--no-same-owner",
      },
      row.home + "/workspace",
    );
    await new Promise((resolve, reject) => {
      tools.once("error", reject);
      tools.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Pi tools failed to install")),
      );
    });
    const config = JSON.parse(
      await readFile(row.home + "/computer/attachment.json", "utf8"),
    );
    process.kill(row.oldComputerPid, "SIGSTOP");
    parked.push(row.oldComputerPid);
    const target = row.home + "/provider-computer";
    if (!existsSync(target))
      await cp(row.home + "/computer", target, { recursive: true });
    await rm(target + "/service.lock", { force: true });
    config.runtime = "native";
    config.nativeHome = row.home;
    config.workspacePath = row.home + "/workspace";
    delete config.localUrl;
    delete config.localPassword;
    await writeFile(target + "/attachment.json", JSON.stringify(config), {
      mode: 0o600,
    });
    const startedAt = Date.now();
    const computer = start(
      process.execPath,
      [release + "/codoxear-v2/dist/server/computer/main.js", "start"],
      {
        ...oldEnv,
        CODOXEAR_COMPUTER_HOME: target,
      },
      row.home + "/workspace",
    );
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (computer.exitCode !== null)
        throw new Error("Computer exited during upgrade");
      const status = JSON.parse(
        await readFile(target + "/status.json", "utf8").catch(() => "{}"),
      );
      if (status.state === "online" && status.updatedAt >= startedAt) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error("Computer did not reconnect");
    own.children.push({
      home: row.home,
      computerPid: computer.pid,
      computerHome: target,
      port: row.port,
    });
  }
  await writeFile(manifest, JSON.stringify(own, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ mode, upgraded: own.children.length }));
} catch (error) {
  for (const p of children) if (p.exitCode === null) p.kill("SIGTERM");
  for (const pid of parked) process.kill(pid, "SIGCONT");
  throw error;
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    for (const p of children) if (p.exitCode === null) p.kill(signal);
  });

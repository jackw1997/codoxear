// Clean source-package acceptance. Host orchestration needs only Node built-ins
// and Git; exporting and every install/build/behavioral check run in bounded
// serial Docker containers under the shared verification lock.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const args = process.argv.slice(2);
const locked = args[0] === "--locked";
if (locked) args.shift();
let browserImage: string | undefined;
if (args[0] === "--browser-image") {
  args.shift();
  browserImage = args.shift();
  if (!browserImage || browserImage.startsWith("-") || /\s/.test(browserImage))
    throw Error("Invalid browser image");
}
if (args.length !== 1)
  throw Error(
    "Usage: verify-isolation.ts [--browser-image image] <committed snapshot>",
  );
const commit = execFileSync(
  "git",
  ["rev-parse", "--verify", "--end-of-options", args[0] + "^{commit}"],
  { cwd: root, encoding: "utf8" },
).trim();
const uid = process.getuid?.();
if (uid === undefined)
  throw Error("Package isolation verification requires Linux");
const lock = `/tmp/codoxear-v2-verification-${uid}.lock`;
const roles = ["computer", "hub", "identity", "server"] as const;
let active: ReturnType<typeof spawn> | undefined;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    if (active?.exitCode === null && active.signalCode === null)
      active.kill(signal);
  });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (parameters: string[], input?: string) =>
  execFileSync("git", parameters, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
async function run(
  command: string,
  parameters: string[],
  timeoutMs = 20 * 60 * 1000,
) {
  const child = spawn(command, parameters, { cwd: root, stdio: "inherit" });
  active = child;
  let force: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    force = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, timeoutMs);
  try {
    await new Promise<void>((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) =>
        code === 0
          ? done()
          : fail(Error(`${command} exited ${code ?? signal}`)),
      );
    });
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    if (active === child) active = undefined;
  }
}
function container(
  command: string,
  image = "node:24-bookworm",
  workdir = "/package",
) {
  if (interrupted) throw Error("Verification interrupted");
  return execFileSync(
    "docker",
    [
      "create",
      "--init",
      "--memory",
      "2g",
      "--memory-swap",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--shm-size",
      "256m",
      "--label",
      "org.codoxear.verification.commit=" + commit,
      "--env",
      "NODE_OPTIONS=--max-old-space-size=768",
      "--workdir",
      workdir,
      "--entrypoint",
      "bash",
      image,
      "-euc",
      command,
    ],
    { encoding: "utf8", timeout: 30000 },
  ).trim();
}
async function start(id: string, label: string) {
  await run("docker", ["start", "--attach", id]);
  const outcome = execFileSync(
    "docker",
    ["inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", id],
    { encoding: "utf8", timeout: 10000 },
  ).trim();
  if (outcome !== "0 false") throw Error(`${label} failed: ${outcome}`);
}
async function cleanup(id: string) {
  await run("docker", ["rm", "--force", id], 30000);
}

if (!locked) {
  const fd = openSync(
    lock,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (info.uid !== uid || !info.isFile())
      throw Error("Invalid verification lock");
  } finally {
    closeSync(fd);
  }
  await run(
    "flock",
    [
      "--no-fork",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      lock,
      process.execPath,
      "--experimental-strip-types",
      fileURLToPath(import.meta.url),
      "--locked",
      ...(browserImage ? ["--browser-image", browserImage] : []),
      commit,
    ],
    2 * 60 * 60 * 1000,
  );
} else {
  await run("docker", ["info", "--format", "{{.ServerVersion}}"], 10000);
  const temporary = await mkdtemp("/tmp/codoxear-isolation-");
  const artifact = resolve(root, "artifacts/package-isolation.json");
  const checks: string[] = [];
  const packages: Record<string, unknown>[] = [];
  let browser: unknown;
  let passed = false;
  let failure: string | undefined;
  let phase = "reviewed-source-export";
  const smoke = join(temporary, "package-isolation-smoke.ts");
  const browserSmoke = join(temporary, "package-browser-oauth.ts");
  const exports = join(temporary, "exports");
  const installed = join(temporary, "installed");
  try {
    await mkdir(resolve(root, "artifacts"), { recursive: true });
    await writeFile(
      artifact,
      JSON.stringify(
        { passed: false, commit, phase, checks, packages },
        null,
        2,
      ) + "\n",
    );
    await mkdir(exports);
    await mkdir(installed);
    // Pack exactly this commit and its tree. This works in shallow CI clones,
    // preserves its original SHA, and never copies mutable checkout files.
    const tree = git(["rev-parse", commit + "^{tree}"]).trim();
    const objects = new Set([
      commit,
      tree,
      ...git(["ls-tree", "-r", "-t", "-z", "--full-tree", commit])
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(0, entry.indexOf("\t")).split(" ")[2]!),
    ]);
    const packPrefix = join(temporary, "reviewed");
    const packHash = git(
      ["pack-objects", packPrefix],
      [...objects].join("\n") + "\n",
    ).trim();
    const pack = packPrefix + "-" + packHash + ".pack";
    for (const [file, destination] of [
      ["scripts/package-isolation-smoke.ts", smoke],
      ["scripts/package-browser-oauth.ts", browserSmoke],
    ])
      await writeFile(
        destination!,
        execFileSync("git", ["show", commit + ":" + prefix + file], {
          cwd: repository,
        }),
      );
    const exporter = container(
      [
        "git init --quiet /reviewed",
        "git -C /reviewed unpack-objects -q < /tmp/reviewed.pack",
        "printf '%s\\n' " + quote(commit) + " > /reviewed/.git/shallow",
        "git -C /reviewed checkout --quiet --detach " + quote(commit),
        "cd " + quote("/reviewed/" + prefix),
        "npm ci --ignore-scripts --no-audit --no-fund",
        ...roles.map(
          (role) =>
            "node --experimental-strip-types scripts/package-component.ts " +
            role +
            " " +
            quote(commit) +
            " /exports/" +
            role,
        ),
      ].join("\n"),
      "node:24-bookworm",
      "/reviewed",
    );
    try {
      await run("docker", ["cp", pack, exporter + ":/tmp/reviewed.pack"]);
      await start(exporter, "reviewed component exporter");
      await run("docker", ["cp", exporter + ":/exports/.", exports]);
    } finally {
      await cleanup(exporter);
    }
    checks.push(
      "all four archives exported from the exact reviewed commit in bounded tooling; host needs no npm dependencies",
    );

    for (const role of ["frontend", ...roles]) {
      phase = role;
      let archive: string;
      let release: Record<string, any> | undefined;
      if (role === "frontend") {
        archive = join(temporary, "frontend.tar");
        git([
          "archive",
          "--format=tar",
          "--output=" + archive,
          commit + ":" + prefix + "frontend",
        ]);
      } else {
        archive = join(exports, role, "codoxear-" + role + "-source.tar.gz");
        release = JSON.parse(
          await readFile(join(exports, role, "release.json"), "utf8"),
        );
        if (release!.commit !== commit || release!.component !== role)
          throw Error("Export provenance mismatch: " + role);
        const digest = createHash("sha256")
          .update(await readFile(archive))
          .digest("hex");
        if (release!.sha256 !== digest)
          throw Error("Export archive checksum mismatch: " + role);
      }
      const id = container(
        [
          "tar -xf /tmp/package.tar -C /package" +
            (role === "frontend" ? "" : " --strip-components=1"),
          "npm ci --no-audit --no-fund",
          "npm run build",
          ...(role === "frontend" ? ["npm test"] : []),
          "node --experimental-strip-types /tmp/package-isolation-smoke.ts " +
            role +
            " /tmp/package-smoke.json",
        ].join("\n"),
      );
      try {
        await run("docker", ["cp", archive, id + ":/tmp/package.tar"]);
        await run("docker", [
          "cp",
          smoke,
          id + ":/tmp/package-isolation-smoke.ts",
        ]);
        await start(id, role + " package isolation");
        const evidence = join(temporary, role + "-smoke.json");
        await run("docker", ["cp", id + ":/tmp/package-smoke.json", evidence]);
        const observation = JSON.parse(await readFile(evidence, "utf8"));
        if (!observation.passed || observation.role !== role)
          throw Error("Missing passing smoke evidence: " + role);
        packages.push({
          ...observation,
          commit,
          archiveSha256: createHash("sha256")
            .update(await readFile(archive))
            .digest("hex"),
          commands: [
            "npm ci",
            "npm run build",
            ...(role === "frontend" ? ["npm test"] : []),
            "compiled package smoke",
          ],
        });
        checks.push(
          role +
            " independently installs, builds and runs its own API/static host without peer source or dependencies",
        );
        if (role === "frontend" || role === "hub") {
          const destination = join(installed, role);
          await mkdir(destination);
          await run("docker", ["cp", id + ":/package/.", destination]);
        }
      } finally {
        await cleanup(id);
      }
    }

    phase = "installed-browser-oauth";
    const rootLock = JSON.parse(
      git(["show", commit + ":" + prefix + "package-lock.json"]),
    );
    const playwrightVersion = rootLock.packages["node_modules/playwright"]
      .version as string;
    if (!/^\d+\.\d+\.\d+$/.test(playwrightVersion))
      throw Error("Invalid reviewed Playwright version");
    const browserCommand = [
      ...(browserImage
        ? [
            "if test -f /opt/codoxear/node_modules/playwright/index.mjs; then export PLAYWRIGHT_MODULE=/opt/codoxear/node_modules/playwright/index.mjs; elif test -f /work/node_modules/playwright/index.mjs; then export PLAYWRIGHT_MODULE=/work/node_modules/playwright/index.mjs; else echo 'Browser image has no installed Playwright module' >&2; exit 1; fi",
          ]
        : [
            "export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
            "npm install --prefix /browser-tools --no-audit --no-fund playwright@" +
              playwrightVersion,
            "/browser-tools/node_modules/.bin/playwright install --with-deps chromium",
            "export PLAYWRIGHT_MODULE=/browser-tools/node_modules/playwright/index.mjs",
          ]),
      "export FRONTEND_PACKAGE_ROOT=/installed/frontend HUB_PACKAGE_ROOT=/installed/hub",
      "node --experimental-strip-types /tmp/package-browser-oauth.ts /tmp/package-browser-oauth.json",
    ].join("\n");
    const browserContainer = container(
      browserCommand,
      browserImage,
      "/installed",
    );
    let browserFailure: unknown;
    try {
      for (const role of ["frontend", "hub"])
        await run("docker", [
          "cp",
          join(installed, role),
          browserContainer + ":/installed/" + role,
        ]);
      await run("docker", [
        "cp",
        browserSmoke,
        browserContainer + ":/tmp/package-browser-oauth.ts",
      ]);
      await start(browserContainer, "installed package browser OAuth");
    } catch (error) {
      browserFailure = error;
    } finally {
      // A failed harness writes observations too. Retrieve them before removing
      // the container, while retaining its original startup/harness failure.
      try {
        const evidence = join(temporary, "browser-oauth.json");
        await run("docker", [
          "cp",
          browserContainer + ":/tmp/package-browser-oauth.json",
          evidence,
        ]);
        browser = JSON.parse(await readFile(evidence, "utf8"));
      } catch (error) {
        browser = {
          passed: false,
          evidenceError: error instanceof Error ? error.message : String(error),
        };
        if (browserFailure === undefined) browserFailure = error;
      }
      try {
        await cleanup(browserContainer);
      } catch (error) {
        if (browserFailure === undefined) browserFailure = error;
        else console.error("Browser container cleanup also failed:", error);
      }
    }
    if (browserFailure !== undefined) throw browserFailure;
    if (!(browser as { passed?: boolean }).passed)
      throw Error("Installed package browser OAuth evidence failed");
    checks.push(
      "independently installed frontend and Hub complete browser OAuth using their own compiled artifacts",
    );
    passed = true;
    phase = "complete";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await mkdir(resolve(root, "artifacts"), { recursive: true });
    await writeFile(
      artifact,
      JSON.stringify(
        {
          passed,
          commit,
          phase,
          checks,
          packages,
          browser,
          memoryLimitMiB: 2048,
          swap: false,
          concurrency: 1,
          source: "reviewed Git commit only",
          ...(failure ? { failure } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    await rm(temporary, { recursive: true, force: true });
  }
}

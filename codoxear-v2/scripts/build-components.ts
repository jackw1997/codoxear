/** Build reviewed independent release images without unbounded Docker builds.
 * Usage: node --import tsx scripts/build-components.ts <reviewed-sha> [tag] [roles]
 * NODE24_IMAGE may select an approved Node 24 bookworm image/digest.
 * CODOXEAR_OPERATOR_TOOLS_IMAGE records a separate optional verification image.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageComponent } from "./package-component.js";

const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), "..");
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: project,
  encoding: "utf8",
}).trim();
const args = process.argv.slice(2);
const locked = args[0] === "--locked";
if (locked) args.shift();
const [revision, requestedTag, requestedRoles] = args;
if (args.length > 3 || !revision || !/^[a-f0-9]{40}$/i.test(revision))
  throw Error(
    "Usage: build-components.ts <reviewed 40-character commit SHA> [tag] [computer,hub,identity,server,frontend]",
  );
const commit = execFileSync(
  "git",
  ["rev-parse", "--verify", revision + "^{commit}"],
  { cwd: project, encoding: "utf8" },
).trim();
if (commit.toLowerCase() !== revision.toLowerCase())
  throw Error("Reviewed revision must identify this exact commit");
const tag = requestedTag ?? commit.slice(0, 12);
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag))
  throw Error("Invalid release tag");
const uid = process.getuid?.();
if (uid === undefined) throw Error("Component image builds require Linux");
const base = process.env.NODE24_IMAGE ?? "node:24-bookworm-slim";
if (
  !/^node:24[^@]*-bookworm-slim[^@]*(?:@sha256:[a-f0-9]{64})?$/.test(base) ||
  /\s/.test(base)
)
  throw Error(
    "NODE24_IMAGE must be a Node 24 bookworm-slim image, optionally pinned by digest",
  );
const limits = {
  memoryBytes: 2 * 1024 ** 3,
  swapBytes: 0,
  cpus: 2,
  pids: 512,
  serial: true,
};
const roles = ["computer", "hub", "identity", "server", "frontend"] as const;
type Role = (typeof roles)[number];
const selection = requestedRoles?.split(",") ?? [...roles];
if (
  selection.some((role) => !roles.includes(role as Role)) ||
  new Set(selection).size !== selection.length
)
  throw Error("Select unique roles from computer,hub,identity,server,frontend");
const selectedRoles = roles.filter((role) => selection.includes(role));
const buildsFrontend = selectedRoles.includes("frontend");
const sourceOnlyRoles: readonly Role[] =
  buildsFrontend && !selectedRoles.includes("computer") ? ["computer"] : [];
let active: ReturnType<typeof spawn> | undefined;
let interrupted: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = signal;
    active?.kill(signal);
  });

async function command(
  executable: string,
  arguments_: string[],
  capture = false,
): Promise<string> {
  if (interrupted && !(executable === "docker" && arguments_[0] === "rm"))
    throw Error("Release build interrupted by " + interrupted);
  const child = spawn(executable, arguments_, {
    cwd: project,
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  active = child;
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    const code = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolveExit(value ?? 1));
    });
    if (code !== 0)
      throw Object.assign(
        Error(`${executable} ${arguments_[0]} failed (${code})`),
        { exitCode: code },
      );
    return output.trim();
  } finally {
    if (active === child) active = undefined;
  }
}

function buildCommand(role: Role): string {
  const frontend = role === "frontend";
  const tools =
    role === "computer"
      ? `
    apt-get update
    apt-get install -y --no-install-recommends git ca-certificates ripgrep fd-find ffmpeg
    ln -s /usr/bin/fdfind /usr/local/bin/fd
    rm -rf /var/lib/apt/lists/*
    npm install --global --no-audit --no-fund @earendil-works/pi-coding-agent@1.0.0 @openai/codex@0.160.0 @anthropic-ai/claude-code@2.1.287
  `
      : "";
  const keep = frontend
    ? ["dist", "serve.mjs"]
    : [
        "dist",
        "node_modules",
        "package.json",
        ...(role === "computer" ? ["runtime"] : []),
      ];
  return `
    mkdir -p /app
    tar -xzf /tmp/source.tar.gz -C /app ${frontend ? "" : "--strip-components=1"}
    rm /tmp/source.tar.gz
    cd /app
    ${tools}
    npm ci --no-audit --no-fund
    npm run build
    ${frontend ? "" : "npm prune --omit=dev --ignore-scripts --no-audit --no-fund"}
    ${role === "computer" ? "npm --prefix runtime/oar prune --omit=dev --ignore-scripts --no-audit --no-fund\nnode --input-type=module -e 'await import(\"@lydell/node-pty\")'" : ""}
    node --input-type=module <<'CODOXEAR_STRIP_BUILD'
      import { readdir, rm } from 'node:fs/promises';
      const keep = new Set(${JSON.stringify(keep)});
      for (const name of await readdir('/app'))
        if (!keep.has(name)) await rm('/app/' + name, { recursive: true, force: true });
    CODOXEAR_STRIP_BUILD
    rm -rf /root/.npm
    if command -v python3 || command -v python; then
      echo 'Independent runtime image unexpectedly contains a Python interpreter' >&2
      exit 1
    fi
  `.replace(/^    /gm, "");
}

async function freeze(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw Error(
        "Immutable frontend assets cannot contain symbolic links: " + path,
      );
    if (info.isDirectory()) await freeze(path);
    else await chmod(path, 0o444);
  }
  await chmod(directory, 0o555);
}

async function buildRelease() {
  await command("docker", ["info", "--format", "{{.ServerVersion}}"]);
  const output = resolve(project, "releases", tag);
  try {
    await stat(join(output, "images.json"));
    throw Error("This release artifact already exists: " + output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp("/tmp/codoxear-component-build-");
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  const gitFiles = new Set(
    execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", "--full-tree", commit],
      {
        cwd: project,
        encoding: "utf8",
        maxBuffer: 32 * 1024 ** 2,
      },
    ).split("\n"),
  );
  const archives = new Map<Role, string>();
  const sources: Record<string, unknown> = {};
  const images: Record<string, unknown> = {};
  const frontendAssets = join(output, "frontend-assets");
  let container: string | undefined;
  let cleanupFailed = false;
  try {
    for (const role of roles.filter(
      (role) =>
        role !== "frontend" &&
        (selectedRoles.includes(role) || sourceOnlyRoles.includes(role)),
    )) {
      const packaged = await packageComponent(role, commit, join(output, role));
      archives.set(role, packaged.archive);
      sources[role] = packaged.release;
    }
    const releaseAssets = join(temporary, "release-assets");
    if (buildsFrontend) {
      const frontendArchive = join(
        output,
        "frontend",
        "codoxear-frontend-source.tar.gz",
      );
      await mkdir(dirname(frontendArchive), { recursive: true });
      await command("git", [
        "-C",
        repository,
        "archive",
        "--format=tar.gz",
        "--output=" + frontendArchive,
        commit + ":" + prefix + "frontend",
      ]);
      archives.set("frontend", frontendArchive);
      sources.frontend = {
        commit,
        sha256: createHash("sha256")
          .update(await readFile(frontendArchive))
          .digest("hex"),
      };
      await mkdir(join(releaseAssets, "downloads"), { recursive: true });
      for (const [source, destination] of [
        ["independent-hubs.html", "guide.html"],
        ["oar-cutover.html", "oar-cutover.html"],
        ["progress.html", "progress.html"],
      ]) {
        const path = prefix + "docs/" + source;
        if (!gitFiles.has(path)) continue;
        await writeFile(
          join(releaseAssets, destination!),
          execFileSync("git", ["show", commit + ":" + path], {
            cwd: project,
            maxBuffer: 16 * 1024 ** 2,
          }),
        );
      }
      await cp(
        archives.get("computer")!,
        join(releaseAssets, "downloads", "codoxear-computer-source.tar.gz"),
      );
      await cp(
        join(output, "computer", "release.json"),
        join(releaseAssets, "downloads", "release.json"),
      );
    }

    for (const role of selectedRoles) {
      const image = `codoxear-${role}:${tag}`;
      console.log(`Building ${image} from ${commit} (2 GiB, no swap, serial)`);
      container = await command(
        "docker",
        [
          "create",
          "--init",
          "--memory=2g",
          "--memory-swap=2g",
          "--cpus=2",
          "--pids-limit=512",
          "--env",
          "NODE_OPTIONS=--max-old-space-size=768",
          "--label",
          "org.codoxear.build.commit=" + commit,
          "--label",
          "org.codoxear.component=" + role,
          "--workdir",
          "/app",
          base,
          "bash",
          "-euc",
          buildCommand(role),
        ],
        true,
      );
      if (!/^[a-f0-9]{64}$/.test(container))
        throw Error("Docker did not return an owned container ID");
      const baseImageId = await command(
        "docker",
        ["inspect", "--format", "{{.Image}}", container],
        true,
      );
      await command("docker", [
        "cp",
        archives.get(role)!,
        container + ":/tmp/source.tar.gz",
      ]);
      await command("docker", ["start", "--attach", container]);
      const state = JSON.parse(
        await command(
          "docker",
          ["inspect", "--format", "{{json .State}}", container],
          true,
        ),
      );
      if (
        state.Running ||
        state.Status !== "exited" ||
        state.ExitCode !== 0 ||
        state.OOMKilled
      )
        throw Error(`Bounded ${role} build failed; no image committed`);
      if (role === "frontend") {
        await command("docker", [
          "cp",
          releaseAssets + "/.",
          container + ":/app/dist/client",
        ]);
        await mkdir(frontendAssets, { recursive: true });
        await command("docker", [
          "cp",
          container + ":/app/dist/.",
          frontendAssets,
        ]);
      }
      const runtimeEnv =
        role === "computer"
          ? "HOME=/home/node CODOXEAR_COMPUTER_HOME=/home/node/.local/share/codoxear-v2/computer PI_BIN=/usr/local/bin/pi CODEX_BIN=/usr/local/bin/codex CLAUDE_BIN=/usr/local/bin/claude NODE_OPTIONS=--max-old-space-size=384"
          : role === "frontend"
            ? "HOME=/home/node CODOXEAR_CLIENT_HOST=0.0.0.0 CODOXEAR_CLIENT_PORT=19520 NODE_OPTIONS=--max-old-space-size=384"
            : role === "server"
              ? "HOME=/home/node CODOXEAR_V2_DATABASE=/home/node/.local/share/codoxear-v2/server/catalog.sqlite NODE_OPTIONS=--max-old-space-size=384"
              : "HOME=/home/node NODE_OPTIONS=--max-old-space-size=384";
      const entry =
        role === "frontend"
          ? ["node", "serve.mjs"]
          : [
              "node",
              `dist/server/${role}/main.js`,
              ...(role === "computer" ? ["start"] : []),
            ];
      await command("docker", [
        "commit",
        "--change",
        "WORKDIR /app",
        "--change",
        "USER node",
        "--change",
        "ENTRYPOINT []",
        "--change",
        "CMD " + JSON.stringify(entry),
        "--change",
        "ENV " + runtimeEnv,
        "--change",
        "LABEL org.opencontainers.image.revision=" + commit,
        "--change",
        "LABEL org.codoxear.component=" + role,
        "--change",
        "LABEL org.codoxear.release.base-image=" + baseImageId,
        container,
        image,
      ]);
      const id = await command(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", image],
        true,
      );
      images[role] = { tag: image, id, baseImageId, commit, limits };
      await command("docker", ["rm", container]);
      container = undefined;
    }
    let assets: {
      directory: string;
      archive: string;
      sha256: string;
      commit: string;
    } | null = null;
    if (buildsFrontend) {
      const assetsArchive = join(output, "frontend-assets.tar.gz");
      await command("tar", [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        assetsArchive,
        "-C",
        frontendAssets,
        ".",
      ]);
      assets = {
        directory: frontendAssets,
        archive: assetsArchive,
        sha256: createHash("sha256")
          .update(await readFile(assetsArchive))
          .digest("hex"),
        commit,
      };
      await freeze(frontendAssets);
      await chmod(assetsArchive, 0o444);
    }
    await writeFile(
      join(output, "images.json"),
      JSON.stringify(
        {
          commit,
          tag,
          base,
          limits,
          roles: selectedRoles,
          sourceOnlyRoles,
          sources,
          images,
          frontendAssets: assets,
          operatorToolsImage: process.env.CODOXEAR_OPERATOR_TOOLS_IMAGE ?? null,
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Independent release artifacts recorded in " +
        join(output, "images.json"),
    );
  } finally {
    if (container && /^[a-f0-9]{64}$/.test(container)) {
      try {
        await command("docker", ["rm", "--force", container]);
      } catch {
        cleanupFailed = true;
        console.error("Owned build container cleanup failed: " + container);
      }
    }
    await rm(temporary, { recursive: true, force: true });
    if (cleanupFailed)
      throw Error(
        "Remove the exact owned build container before another build",
      );
  }
}

if (!locked) {
  const lockPath = `/tmp/codoxear-v2-verification-${uid}.lock`;
  const fd = openSync(
    lockPath,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (info.uid !== uid || !info.isFile())
      throw Error("Verification lock must be an owned regular file");
  } finally {
    closeSync(fd);
  }
  try {
    await command("flock", [
      "--no-fork",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      lockPath,
      process.execPath,
      ...process.execArgv,
      script,
      "--locked",
      commit,
      tag,
      ...(requestedRoles ? [selectedRoles.join(",")] : []),
    ]);
  } catch (error) {
    const code = (error as { exitCode?: number }).exitCode;
    console.error(
      code === 75
        ? "The shared verification lock is busy; wait for the existing build or verification."
        : String(error),
    );
    process.exitCode = code ?? 1;
  }
} else {
  try {
    await buildRelease();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

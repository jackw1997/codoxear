import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readlink, lstat, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { rawPath, pathFields, displayPath, pathBytes } from "./paths.js";
import { resolve, relative, join, basename } from "node:path";
import { DomainError } from "../../../contracts/model.js";
import { inside, openFile, pinnedParent } from "./files.js";
async function gitBytes(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  allowDiff = false,
) {
  const directory = await openFile(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
  try { return await new Promise<Buffer>((yes, no) =>
    execFile(
      "git",
      [
        "--literal-pathspecs",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        `/proc/${process.pid}/fd/${directory.fd}`,
        ...(args[0] === "diff"
          ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)]
          : args),
      ],
      {
        encoding: "buffer",
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) =>
        error && !(allowDiff && (error as { code?: number }).code === 1)
          ? no(
              new DomainError(
                409,
                "git_error",
                /not a git repository/i.test(stderr.toString("utf8"))
                  ? "Not a git repository"
                  : "Git operation failed",
              ),
            )
          : yes(stdout),
    ),
  ); } finally { await directory.close(); }
}
export async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return rawPath(await gitBytes(cwd, args, signal));
}
async function blob(
  root: string,
  rel: string,
  staged: boolean,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const rows = rawPath(
    await gitBytes(
      root,
      staged ? ["ls-files", "-s", "-z"] : ["ls-tree", "-r", "-z", "HEAD"],
      signal,
    ),
  ).split("\0");
  const row = rows.find((row) => row.slice(row.indexOf("\t") + 1) === rel);
  if (!row) return undefined;
  const oid = staged ? row.split(" ")[1] : row.split(" ")[2]?.split("\t")[0];
  if (!oid || !/^[a-f0-9]{40,64}$/.test(oid)) return undefined;
  return gitBytes(root, ["cat-file", "blob", oid], signal);
}
async function workingBytes(target: string) {
  try {
    const file = await openFile(target);
    try {
      if ((await file.stat()).size > 2 * 1024 * 1024)
        throw new DomainError(400, "file_too_large", "File too large");
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function gitRoot(cwd: string, signal?: AbortSignal) {
  return (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
}
export async function gitPayload(
  cwd: string,
  action: string,
  path: string,
  query: URLSearchParams,
  signal?: AbortSignal,
  approvedRoot?: string,
) {
  const root = await gitRoot(cwd, signal);
  if (approvedRoot) {
    if (resolve(root) !== resolve(approvedRoot)) throw new DomainError(403, "git_repository_scope", "Approve the complete repository root to share its history");
    const metadata = await openFile(join(root, ".git"), constants.O_RDONLY | constants.O_DIRECTORY);
    await metadata.close();
    for (const name of ["objects/info/alternates", "objects/info/http-alternates", "commondir", "gitdir"]) {
      try { await lstat(join(root, ".git", name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new DomainError(403, "git_external_objects", "Delegated repositories cannot use external Git object stores or linked worktrees");
    }
    // Git reads its own metadata; audit it before granting object/history reads.
    let scanned = 0;
    const audit = async (path: string): Promise<void> => {
      if (++scanned > 100000) throw new DomainError(413, "git_metadata_limit", "Repository metadata exceeds the delegated inspection limit");
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new DomainError(403, "git_metadata_boundary", "Delegated Git metadata must stay inside the repository");
      if (stat.isDirectory()) for (const name of await readdir(path)) await audit(join(path, name));
    };
    await audit(join(root, ".git"));
  }
  const target = resolve(root, path);
  if (path && !inside(root, target))
    throw new DomainError(403, "git_boundary", "Path is outside repository");
  const rel = relative(root, target);
  if (approvedRoot && rel.split("/").includes(".git")) throw new DomainError(403, "git_boundary", "Git paths must refer to repository files");
  if (action === "changed_files") {
    const [unstaged, staged, untracked, numA, numB] = await Promise.all([
      git(root, ["diff", "--name-only", "-z"], signal),
      git(root, ["diff", "--name-only", "--cached", "-z"], signal),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
      git(root, ["diff", "--numstat", "-z"], signal),
      git(root, ["diff", "--cached", "--numstat", "-z"], signal),
    ]);
    const split = (s: string) => s.split("\0").filter(Boolean);
    const a = split(unstaged),
      b = split(staged),
      c = split(untracked);
    const stats = new Map<
      string,
      { additions: number | null; deletions: number | null }
    >();
    const rows = split(numA + numB);
    for (let i = 0; i < rows.length; i++) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(rows[i]!);
      if (!match) continue;
      const name = match[3] || ((i += 2), rows[i]);
      if (!name) continue;
      const prev = stats.get(name) ?? { additions: 0, deletions: 0 };
      stats.set(name, {
        additions:
          match[1] === "-" || prev.additions === null
            ? null
            : prev.additions + Number(match[1]),
        deletions:
          match[2] === "-" || prev.deletions === null
            ? null
            : prev.deletions + Number(match[2]),
      });
    }
    const files = [...new Set([...a, ...b, ...c])].slice(0, 10000);
    return {
      ok: true,
      cwd,
      files: files.map(displayPath),
      unstaged: a.map(displayPath),
      staged: b.map(displayPath),
      untracked: c.map(displayPath),
      entries: files.map((path) => ({
        ...pathFields(path),
        ...(stats.get(path) ?? { additions: null, deletions: null }),
        changed: !c.includes(path),
        untracked: c.includes(path),
        state: c.includes(path) ? "untracked" : "changed",
      })),
    };
  }
  if (!path) throw new DomainError(400, "path_required", "path required");
  if (action === "diff") {
    if (approvedRoot || /[\udc80-\udcff]/u.test(rel)) {
      const staged = query.get("staged") === "1";
      const base = await blob(
        root,
        rel,
        !staged && query.get("head") !== "1",
        signal,
      ).catch(() => undefined);
      const current = staged
        ? await blob(root, rel, true, signal)
        : await workingBytes(target);
      const dir = await mkdtemp(join(tmpdir(), "codoxear-git-diff-"));
      try {
        const before = join(dir, "before"),
          after = join(dir, "after");
        await writeFile(before, base ?? Buffer.alloc(0));
        await writeFile(after, current ?? Buffer.alloc(0));
        const diff = (
          await gitBytes(
            root,
            [
              "diff",
              "--no-index",
              "--no-ext-diff",
              "--no-textconv",
              "-U3",
              "--",
              before,
              after,
            ],
            signal,
            true,
          )
        ).toString("utf8");
        return {
          ok: true,
          cwd,
          ...pathFields(rel),
          staged,
          diff: diff
            .split(before)
            .join(displayPath(rel))
            .split(after)
            .join(displayPath(rel)),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const args = ["diff", "--no-ext-diff", "--no-textconv", "-U3"];
    if (query.get("head") === "1") args.push("HEAD");
    else if (query.get("staged") === "1") args.push("--cached");
    return {
      ok: true,
      cwd,
      path: rel,
      staged: query.get("staged") === "1",
      diff: await git(root, [...args, "--", rel], signal),
    };
  }
  let current_text = "",
    current_size = 0,
    current_exists = false;
  try {
    const file = await openFile(target);
    try {
      const stat = await file.stat();
      if (stat.size > 2 * 1024 * 1024)
        throw new DomainError(400, "file_too_large", "File too large");
      const bytes = await file.readFile();
      if (bytes.includes(0))
        throw new DomainError(
          400,
          "binary_file",
          "Binary file is not supported by the text diff viewer",
        );
      current_text = bytes.toString("utf8");
      current_size = stat.size;
      current_exists = true;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      const parent = await pinnedParent(target);
      try {
        const bytes = await readlink(
          pathBytes(`/proc/self/fd/${parent.fd}/${basename(target)}`),
          { encoding: "buffer" },
        );
        current_text = rawPath(bytes);
        current_size = bytes.length;
        current_exists = true;
      } finally {
        await parent.close();
      }
    } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let base_text = "",
    base_exists = false;
  try {
    const bytes = await blob(root, rel, false, signal);
    if (bytes !== undefined) {
      base_text = bytes.toString("utf8");
      base_exists = true;
    }
  } catch {}
  return {
    ok: true,
    cwd,
    ...pathFields(rel),
    abs_path: target,
    current_exists,
    current_size,
    current_text,
    base_exists,
    base_text,
  };
}

import { constants } from "node:fs";
import { open, realpath, readdir, rename, unlink, lstat } from "node:fs/promises";
import { requireAllowedPath, requireSingleLink, validateRootHandle, allowedPath, workspaceSecurity } from "./security.js";
import {
  dirname,
  basename,
  resolve,
  relative,
  isAbsolute,
  extname,
  join,
  sep,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../../contracts/model.js";
import { pathBytes, rawPath, pathFields, decodePathToken } from "./paths.js";
export const VIEW_LIMIT = 2 * 1024 * 1024;
const denied = () =>
  new DomainError(
    403,
    "workspace_boundary",
    "Path is outside the granted workspace or crosses a symlink",
  );
export function inside(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}
export const tokenPath = decodePathToken;
export function requireSecureFilePlatform(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "linux")
    throw new DomainError(
      501,
      "unsupported_platform",
      "Secure native workspace file access currently requires Linux; this platform is not supported yet.",
    );
}
export async function pinnedParent(path: string) {
  requireSecureFilePlatform();
  const parts = resolve(path).split(sep).filter(Boolean);
  parts.pop();
  let handle = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let currentPath = "/";
  try {
    for (const part of parts) {
      const next = await open(
        pathBytes(`/proc/self/fd/${handle.fd}/${part}`),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
      currentPath = join(currentPath, part);
      await validateRootHandle(currentPath, handle);
    }
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}
export async function guardedPath(root: string | undefined, raw: string) {
  if (typeof raw !== "string" || !raw || raw.includes("\0"))
    throw new DomainError(400, "invalid_path", "path required");
  const path = resolve(root ?? "/", raw);
  if (root && !inside(root, path)) throw denied();
  requireAllowedPath(path);
  return path;
}
export async function openFile(path: string, flags = constants.O_RDONLY) {
  const parent = await pinnedParent(path);
  try {
    const file = await open(
      pathBytes(`/proc/self/fd/${parent.fd}/${basename(path)}`),
      flags | constants.O_NOFOLLOW,
    );
    try { await validateRootHandle(path, file); await requireSingleLink(file); }
    catch (error) { await file.close(); throw error; }
    return file;
  } finally {
    await parent.close();
  }
}
export const version = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export function kind(path: string, prefix: Buffer) {
  const ext = extname(path).toLowerCase();
  const mime: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".3gp": "video/3gpp",
    ".flv": "video/x-flv",
    ".m4v": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".ogv": "video/ogg",
    ".wmv": "video/x-ms-wmv",
  };
  let content_type = mime[ext];
  if (
    prefix.length >= 8 &&
    prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    content_type = "image/png";
  else if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255)
    content_type = "image/jpeg";
  else if (
    prefix.toString("ascii", 0, 6) === "GIF87a" ||
    prefix.toString("ascii", 0, 6) === "GIF89a"
  )
    content_type = "image/gif";
  else if (
    prefix.toString("ascii", 0, 4) === "RIFF" &&
    prefix.toString("ascii", 8, 12) === "WEBP"
  )
    content_type = "image/webp";
  else if (prefix.toString("ascii", 0, 5) === "%PDF-")
    content_type = "application/pdf";
  if (content_type)
    return {
      kind: content_type.startsWith("image/")
        ? "image"
        : content_type.startsWith("video/")
          ? "video"
          : "pdf",
      content_type,
    };
  return {
    kind: [".md", ".markdown", ".mdown", ".mkd"].includes(ext)
      ? "markdown"
      : "text",
    content_type: null,
  };
}
export async function view(path: string, editable = true) {
  const file = await openFile(path);
  try {
    const stat = await file.stat();
    if (stat.isDirectory())
      return { kind: "directory", size: 0, content_type: null };
    if (!stat.isFile())
      throw new DomainError(400, "not_file", "path is not a file");
    const prefix = Buffer.alloc(Math.min(stat.size, 4096));
    await file.read(prefix, 0, prefix.length, 0);
    const type = kind(path, prefix);
    if (type.content_type) return { ...type, size: stat.size };
    if (stat.size > VIEW_LIMIT)
      return {
        kind: "download_only",
        size: stat.size,
        reason: "too_large",
        viewer_max_bytes: VIEW_LIMIT,
      };
    const bytes = await file.readFile();
    if (bytes.includes(0))
      return { kind: "download_only", size: stat.size, reason: "binary" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      const textual =
        /\.(txt|md|markdown|log|json|jsonl|csv|conf|ini|toml|yaml|yml|js|ts|tsx|py|sh|css|html|xml|c|cpp|h|go|rs)$/i.test(
          path,
        ) ||
        !bytes.some((byte) => byte < 32 && ![9, 10, 12, 13, 27].includes(byte));
      if (!textual)
        return { kind: "download_only", size: stat.size, reason: "binary" };
      text = bytes.toString("utf8");
      editable = false;
    }
    return {
      ...type,
      size: stat.size,
      text,
      editable,
      version: version(bytes),
    };
  } finally {
    await file.close();
  }
}
export async function listFiles(root: string) {
  const result: Array<{
    path: string;
    api_path?: string;
    non_utf8_path?: boolean;
  }> = [];
  const ignored = new Set([
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
  ]);
  const deadline = Date.now() + 2000;
  async function walk(path: string, prefix: string, depth: number) {
    if (depth > 64 || result.length >= 10000 || Date.now() > deadline) return;
    const handle = await openFile(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      const entries = await readdir(`/proc/self/fd/${handle.fd}`, {
        withFileTypes: true,
        encoding: "buffer",
      });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const name = rawPath(entry.name);
        const rel = prefix + name;
        if (entry.isDirectory() && !ignored.has(name))
          await walk(join(path, name), rel + "/", depth + 1);
        else if (entry.isFile() && allowedPath(join(path, name))) {
          try {
            const checked = await openFile(join(path, name));
            await checked.close();
            result.push(pathFields(rel));
          } catch (error) {
            if (!workspaceSecurity.getStore()) throw error;
          }
        }
        if (result.length >= 10000 || Date.now() > deadline) break;
      }
    } finally {
      await handle.close();
    }
  }
  await walk(root, "", 0);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
const locks = new Map<string, Promise<void>>();
export async function writeFileVersioned(
  path: string,
  text: string,
  create: boolean,
  expected?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (typeof text !== "string" || Buffer.byteLength(text) > VIEW_LIMIT)
    throw new DomainError(400, "invalid_text", "Text exceeds file limit");
  const prior = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  locks.set(path, current);
  await prior;
  try {
    signal?.throwIfAborted();
    requireAllowedPath(path);
    const parent = await pinnedParent(path);
    const pinned = `/proc/self/fd/${parent.fd}/${basename(path)}`;
    let temporary: string | undefined;
    let mode = 0o600;
    let original: { dev: number; ino: number; version: string } | undefined;
    try {
      if (!create) {
        if (!expected)
          throw new DomainError(400, "version_required", "version required");
        const existing = await open(
          pathBytes(pinned),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await existing.stat();
          await requireSingleLink(existing);
          if (!stat.isFile())
            throw new DomainError(400, "not_file", "path is not a file");
          if (stat.size > VIEW_LIMIT)
            throw new DomainError(
              400,
              "file_too_large",
              "File exceeds editor limit",
            );
          mode = stat.mode & 0o777;
          const bytes = await existing.readFile();
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new DomainError(
              400,
              "not_editable",
              "file is not editable as utf-8 text",
            );
          }
          if (version(bytes) !== expected)
            throw new DomainError(
              409,
              "file_changed",
              "file changed; reload before saving",
            );
          original = { dev: stat.dev, ino: stat.ino, version: version(bytes) };
        } finally {
          await existing.close();
        }
      }
      const bytes = Buffer.from(text);
      signal?.throwIfAborted();
      if (create) {
        const file = await open(
          pathBytes(pinned),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      } else {
        temporary = `/proc/self/fd/${parent.fd}/.codoxear-${randomUUID()}`;
        const file = await open(temporary, "wx", mode);
        try {
          await file.chmod(mode);
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        // Compare the pinned entry again immediately before the atomic replacement.
        const current = await open(pathBytes(pinned), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await current.stat();
          await requireSingleLink(current);
          if (stat.dev !== original!.dev || stat.ino !== original!.ino || version(await current.readFile()) !== original!.version)
            throw new DomainError(409, "file_changed", "file changed; reload before saving");
        } finally { await current.close(); }
        signal?.throwIfAborted();
        await rename(temporary, pathBytes(pinned));
        temporary = undefined;
      }
      return {
        ok: true,
        path,
        size: bytes.length,
        version: version(bytes),
        editable: true,
      };
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await parent.close();
    }
  } finally {
    release();
    if (locks.get(path) === current) locks.delete(path);
  }
}
export async function canonicalRoot(path: string) {
  return realpath(path);
}

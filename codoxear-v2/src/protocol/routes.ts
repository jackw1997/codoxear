import { DomainError } from "../contracts/model.js";
export type RouteAccess =
  | "read"
  | "send"
  | "interrupt"
  | "files.read"
  | "files.write"
  | "session.delete"
  | "computer.admin";
const reads = new Set([
  "live",
  "messages/tail",
  "messages/live",
  "messages/history",
  "messages/window",
  "messages/export",
  "search",
  "tail",
  "unread",
  "diagnostics",
  "draft",
  "queue",
  "attachments",
  "unattended",
]);
const controls = new Set([
  "enqueue",
  "queue/delete",
  "queue/update",
  "queue/move",
  "send",
  "settings",
  "edit",
  "rename",
  "unattended",
  "read",
  "draft",
  "pending_attachment/clear",
  "attachments/delete",
  "attachments/clear",
  "commit_unknown_send/clear",
]);
const fileReads = new Set([
  "file/read",
  "file/search",
  "file/list",
  "file/image-dimensions",
  "file/blob",
  "file/video_preview",
  "file/download",
  "git/changed_files",
  "git/diff",
  "git/file_versions",
]);
export function classifyRoute(
  method: string,
  path: string,
): { localId: string | null; action: RouteAccess } {
  if (!path.startsWith("/api/") || path.includes("\\") || /[\r\n\0]/.test(path))
    throw new DomainError(400, "invalid_route", "Invalid local route");
  const pathname = path.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new DomainError(400, "invalid_route", "Invalid route encoding");
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.split("/").some((x) => x === "." || x === "..")
  )
    throw new DomainError(400, "invalid_route", "Non-canonical route");
  // These established global APIs expose computer-wide files/settings. Only the
  // computer owner may call them; session retention never confers this capability.
  const ownerRead = new Set([
    "/api/settings/voice",
    "/api/settings/unattended-prompt",
    "/api/file/blob",
    "/api/file/download",
    "/api/files/blob",
    "/api/files/download",
    "/api/files/image-dimensions",
    "/api/files/video_preview",
    "/api/file/image-dimensions",
    "/api/file/video_preview",
    "/api/cwd-suggest",
    "/api/session_resume_candidates",
    "/api/audio/live.m3u8",
    "/api/notifications/feed",
    "/api/notifications/text",
    "/api/notifications/state",
  ]);
  const ownerWrite = new Set([
    "/api/files/read",
    "/api/files/inspect",
    "/api/files/inspect-batch",
    "/api/settings/voice",
    "/api/settings/unattended-prompt",
    "/api/audio/listener",
  ]);
  if (
    (["GET", "HEAD"].includes(method) &&
      (ownerRead.has(decoded) ||
        /^\/api\/audio\/segments\/[A-Za-z0-9_.-]+$/.test(decoded))) ||
    (method === "POST" && ownerWrite.has(decoded))
  )
    return { localId: null, action: "computer.admin" };
  const match = /^\/api\/sessions\/([A-Za-z0-9_.:-]+)\/(.+)$/.exec(decoded);
  if (!match)
    throw new DomainError(
      403,
      "route_denied",
      "Only explicitly supported session routes may be relayed",
    );
  const localId = match[1]!,
    route = match[2]!;
  if (["GET", "HEAD"].includes(method)) {
    if (reads.has(route)) return { localId, action: "read" };
    if (fileReads.has(route)) return { localId, action: "files.read" };
  }
  if (method === "POST") {
    if (["file/inspect", "file/inspect-batch"].includes(route))
      return { localId, action: "files.read" };
    if (route === "delete") return { localId, action: "session.delete" };
    if (route === "draft") return { localId, action: "read" };
    if (route === "interrupt") return { localId, action: "interrupt" };
    if (controls.has(route)) return { localId, action: "send" };
    if (["file/write", "inject_file", "inject_image"].includes(route))
      return { localId, action: "files.write" };
  }
  throw new DomainError(
    403,
    "route_denied",
    "This route is not enabled for remote access",
  );
}
const requestNames = new Set([
  "content-type",
  "content-length",
  "range",
  "if-none-match",
  "if-modified-since",
  "if-range",
  "last-event-id",
  "accept",
]);
const responseNames = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "content-disposition",
  "cache-control",
  "x-accel-buffering",
]);
export function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  direction: "request" | "response",
) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (
      (direction === "request" ? requestNames : responseNames).has(
        key.toLowerCase(),
      ) &&
      typeof value === "string" &&
      !/[\r\n]/.test(value)
    )
      result[key.toLowerCase()] = value;
  return result;
}

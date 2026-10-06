import { constants } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, basename, relative, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { DomainError } from "../../contracts/model.js";
import { classifyRoute, filterHeaders } from "../../protocol/routes.js";
import { requireRelaySessionId } from "../runtime-identity.js";
import {
  emptyBody,
  type HttpRequest,
  type HttpResponse,
} from "../../protocol/http-frames.js";
import type { WorkspaceRuntime } from "../runtime.js";
import { displayPath, mediaQuery, pathFields } from "./workspace/paths.js";
import {
  canonicalRoot,
  guardedPath,
  inside,
  tokenPath,
  view,
  listFiles,
  openFile,
  writeFileVersioned,
  kind,
} from "./workspace/files.js";
import { gitPayload, gitRoot } from "./workspace/git.js";
import { dimensions } from "./workspace/media.js";
import {
  DEFAULT_UNATTENDED_PROMPT,
  readUnattendedPrompt,
} from "./workspace/unattended.js";
import { updateSettings } from "./workspace/settings.js";
import { NativeVoice } from "./workspace/voice.js";
import { videoPreview } from "./workspace/video.js";
import { WorkspaceRegistry } from "./workspace/registry.js";
import { workspaceSecurity, requireAllowedPath } from "./workspace/security.js";
const scopedRoutes = new Set([
  "read",
  "write",
  "blob",
  "download",
  "list",
  "search",
  "image-dimensions",
  "inspect",
  "inspect-batch",
  "video_preview",
]);
function json(value: unknown, status = 200): HttpResponse {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    },
    body: (async function* () {
      yield bytes;
    })(),
  };
}
async function bodyBytes(request: HttpRequest, max = 256 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    request.signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > max)
      throw new DomainError(413, "body_limit", "Upload exceeds limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function pathValue(q: URLSearchParams | Record<string, unknown>) {
  const get = (name: string) =>
    q instanceof URLSearchParams ? q.get(name) : q[name];
  const token = get("path_token");
  if (typeof token === "string" && token) return tokenPath(token);
  const path = get("path");
  if (typeof path !== "string" || !path)
    throw new DomainError(400, "path_required", "path required");
  return path;
}
function flag(value: unknown) {
  return (
    value === true ||
    ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase())
  );
}
export class NativeHttpTarget {
  private voice: NativeVoice;
  private registry: WorkspaceRegistry;
  constructor(
    private runtime: WorkspaceRuntime,
    private workspacePath: string,
  ) {
    this.voice = new NativeVoice(runtime);
    this.registry = new WorkspaceRegistry(runtime.stateHome, workspacePath);
  }
  close() {
    this.voice.close();
  }
  async execute(request: HttpRequest): Promise<HttpResponse> {
    try {
      const approvedRoot = request.workspace
        ? await this.registry.selected(request.workspace.id)
        : undefined;
      if (request.workspace)
        request = {
          ...request,
          signal: AbortSignal.any([
            request.signal,
            this.registry.authorizationSignal(request.workspace.id),
          ]),
        };
      const result = request.workspace
        ? await workspaceSecurity.run(
            { root: approvedRoot!, grant: request.workspace },
            () => this.dispatch(request),
          )
        : await this.dispatch(request);
      return request.method === "HEAD"
        ? { ...result, body: emptyBody }
        : result;
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof DomainError)
        return json({ error: error.message, code: error.code }, error.status);
      const code = (error as NodeJS.ErrnoException).code;
      if (["ELOOP", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? ""))
        return json({ error: "Path is unavailable or crosses a symlink" }, 403);
      if (code === "ENOENT")
        return json({ error: "file or session not found" }, 404);
      if (code === "EEXIST") return json({ error: "file already exists" }, 409);
      return json({ error: "Native operation failed" }, 500);
    }
  }
  private async dispatch(request: HttpRequest): Promise<HttpResponse> {
    request.signal.throwIfAborted();
    const route = classifyRoute(request.method, request.path);
    if (route.localId) requireRelaySessionId(route.localId);
    const url = new URL(request.path, "http://native.invalid"),
      q = url.searchParams;
    const pathname = url.pathname;
    const match = /^\/api\/sessions\/([^/]+)\/(.+)$/.exec(pathname);
    const action = match?.[2] ?? "";
    const localId = match?.[1];
    if (/\/draft$/.test(pathname))
      throw new DomainError(
        403,
        "draft_scope",
        "Remote drafts require account-scoped Computer storage",
      );
    if (
      request.method === "POST" &&
      ["enqueue", "queue/delete", "queue/update", "queue/move"].includes(action)
    )
      throw new DomainError(
        403,
        "queue_scope",
        "Remote queues require authorized Computer queue storage",
      );
    let root: string | undefined;
    let cwd = this.workspacePath;
    if (localId) {
      const catalog = (await this.runtime.request("/api/sessions")) as {
        sessions: Array<{ session_id: string; cwd: string }>;
      };
      const session = catalog.sessions.find(
        (row) => row.session_id === localId,
      );
      if (!session)
        throw new DomainError(404, "unknown_session", "unknown session");
      cwd = session.cwd;
    }
    if (request.workspace) {
      if (!request.actorId)
        throw new DomainError(
          403,
          "workspace_unavailable",
          "Verified workspace context required",
        );
      const upload = ["inject_file", "inject_image"].includes(action);
      const gitAction = action.startsWith("git/");
      const attachmentControl = [
        "send",
        "attachments",
        "attachments/delete",
        "attachments/clear",
        "pending_attachment/clear",
      ].includes(action);
      if (action === "file/video_preview" && !request.workspace.transcode)
        throw new DomainError(
          403,
          "video_scope",
          "Video processing requires a separate owner grant",
        );
      if (
        !(action.startsWith("file/") && scopedRoutes.has(action.slice(5))) &&
        !(gitAction && request.workspace.git) &&
        !(upload && request.workspace.uploads) &&
        !attachmentControl
      )
        throw new DomainError(
          403,
          "workspace_route",
          "This action requires a separate computer capability",
        );
      if (
        route.action === "files.write" &&
        !upload &&
        request.workspace.access !== "write"
      )
        throw new DomainError(
          403,
          "workspace_read_only",
          "Workspace access is read-only",
        );
      root = workspaceSecurity.getStore()!.root.path;
      if (!inside(root, resolve(cwd)))
        throw new DomainError(
          403,
          "workspace_boundary",
          "Session is outside the granted workspace",
        );
    }
    if (
      localId &&
      request.actorId &&
      (request.workspace || request.actorIsOwner === false) &&
      [
        "inject_file",
        "inject_image",
        "send",
        "attachments",
        "attachments/delete",
        "attachments/clear",
        "pending_attachment/clear",
      ].includes(action)
    ) {
      const state = (await this.runtime.request(
        `/api/sessions/${localId}/state`,
        "GET",
        { actorId: request.actorId },
      )) as { actor_attachments?: boolean; attachments?: unknown[] };
      if (
        !state.actor_attachments &&
        (action !== "send" || !!state.attachments?.length)
      )
        throw new DomainError(
          409,
          "attachment_runtime_update",
          "This running session predates private member attachments. Resume it with the updated broker to use attachments; its current process has been preserved.",
        );
    }
    let body: Record<string, unknown> | undefined;
    if (
      request.method === "POST" &&
      !["inject_file", "inject_image"].includes(action)
    ) {
      const bytes = await bodyBytes(request, 8 * 1024 * 1024);
      if (bytes.length) {
        try {
          body = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new DomainError(400, "invalid_json", "Invalid JSON body");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new DomainError(400, "invalid_json", "JSON object required");
      } else body = {};
    }
    if (action.startsWith("git/")) {
      if (request.workspace && !request.workspace.git)
        throw new DomainError(
          403,
          "git_scope",
          "Repository history requires separate access",
        );
      const payload = async () =>
        json(
          await gitPayload(
            cwd,
            action.slice(4),
            q.get("path") || q.get("path_token") ? pathValue(q) : "",
            q,
            request.signal,
            request.workspace ? root : undefined,
          ),
        );
      if (request.workspace)
        return workspaceSecurity.run(
          {
            ...workspaceSecurity.getStore()!,
            grant: { ...request.workspace, paths: ["."] },
          },
          payload,
        );
      return payload();
    }
    if (
      action.startsWith("file/") ||
      /^\/api\/files?\/(read|inspect|inspect-batch|blob|download|image-dimensions|video_preview)$/.test(
        pathname,
      )
    ) {
      const fileAction = action.startsWith("file/")
        ? action.slice(5)
        : pathname.split("/").at(-1)!;
      let base = localId ? await canonicalRoot(cwd) : undefined;
      if (body?.session_id && localId && body.session_id !== localId)
        throw new DomainError(
          403,
          "session_mismatch",
          "File inspection session does not match its route",
        );
      if (
        request.workspace &&
        (flag(body?.git_path) || flag(q.get("git_path")))
      )
        throw new DomainError(
          403,
          "git_scope",
          "Repository history requires separate access",
        );
      if (!localId && typeof body?.session_id === "string") {
        const catalog = (await this.runtime.request("/api/sessions")) as {
          sessions: Array<{ session_id: string; cwd: string }>;
        };
        const session = catalog.sessions.find(
          (row) => row.session_id === body!.session_id,
        );
        if (!session)
          throw new DomainError(404, "unknown_session", "unknown session");
        base = await canonicalRoot(session.cwd);
      }
      if (flag(q.get("git_path")) || flag(body?.git_path))
        base = await gitRoot(cwd, request.signal);
      if (["list", "search"].includes(fileAction)) {
        const entries = await listFiles(base ?? (await canonicalRoot(cwd)));
        if (fileAction === "list")
          return json({
            ok: true,
            cwd,
            files: entries.map((r) => r.path),
            entries,
          });
        const query = q.get("q");
        if (!query?.trim())
          throw new DomainError(400, "query_required", "q required");
        const limit = Number(q.get("limit") ?? 120);
        if (!Number.isSafeInteger(limit) || limit < 1)
          throw new DomainError(
            400,
            "invalid_limit",
            "limit must be a positive integer",
          );
        const matches = entries.filter((r) =>
          r.path.toLowerCase().includes(query.toLowerCase()),
        );
        return json({
          ok: true,
          cwd,
          query,
          mode: request.workspace ? "workspace" : "native",
          matches: matches.slice(0, Math.min(limit, 1000)),
          scanned: entries.length,
          truncated: matches.length > limit || entries.length >= 10000,
        });
      }
      if (fileAction === "inspect-batch") {
        const paths = body?.paths;
        if (
          !Array.isArray(paths) ||
          paths.length > 50 ||
          paths.some((p) => typeof p !== "string" || !p)
        )
          throw new DomainError(
            400,
            "invalid_paths",
            "At most 50 non-empty paths required",
          );
        const results = [];
        for (const raw of paths) {
          try {
            const target = await guardedPath(base, raw);
            results.push({
              ok: true,
              path: raw,
              exists: true,
              resolved_path: target,
              ...(await view(target, request.workspace?.access !== "read")),
            });
          } catch (error) {
            if (
              error instanceof DomainError &&
              error.code === "unsupported_platform"
            )
              throw error;
            results.push({
              path: raw,
              exists: false,
              ...((error as NodeJS.ErrnoException).code === "ENOENT"
                ? {}
                : { error: "Path unavailable" }),
            });
          }
        }
        return json({ results });
      }
      const raw = pathValue(body ?? q);
      const target = await guardedPath(base, raw);
      if (root && !inside(root, target))
        throw new DomainError(
          403,
          "workspace_boundary",
          "Path is outside the approved workspace",
        );
      if (fileAction === "write") {
        if (body?.create && body?.path_token)
          throw new DomainError(
            400,
            "invalid_create",
            "path_token is not supported for create",
          );
        const result = await writeFileVersioned(
          target,
          body?.text as string,
          body?.create === true,
          typeof body?.version === "string" ? body.version : undefined,
          request.signal,
        );
        return json({ ...result, rel: raw });
      }
      if (fileAction === "image-dimensions")
        return json(await dimensions(target));
      if (["blob", "download", "video_preview"].includes(fileAction)) {
        const streamPath =
          fileAction === "video_preview"
            ? await videoPreview(
                target,
                this.runtime.stateHome,
                request.signal,
                request.workspace
                  ? `${request.actorId}:${JSON.stringify(request.workspace)}`
                  : undefined,
              )
            : target;
        return this.streamFile(request, streamPath, fileAction === "download");
      }
      const inspected = await view(
        target,
        request.workspace?.access !== "read",
      );
      if (fileAction === "inspect")
        return json({ ok: true, path: target, ...inspected });
      const prefix = localId ? `/api/sessions/${localId}/file` : "/api/file";
      const query = mediaQuery(localId ? raw : target);
      return json({
        ok: true,
        rel: displayPath(raw),
        ...pathFields(target),
        ...(pathFields(raw).api_path
          ? { api_path: pathFields(raw).api_path, non_utf8_path: true }
          : {}),
        ...inspected,
        ...(inspected.kind === "image"
          ? { image_url: prefix + "/blob" + query }
          : inspected.kind === "pdf"
            ? { pdf_url: prefix + "/blob" + query }
            : inspected.kind === "video"
              ? {
                  video_url: prefix + "/blob" + query,
                  video_preview_url: prefix + "/video_preview" + query,
                  preview_content_type: "video/mp4",
                }
              : {}),
      });
    }
    if (["inject_file", "inject_image"].includes(action)) {
      const headers = filterHeaders(request.headers, "request");
      const bytes = await bodyBytes(request);
      let upload: Record<string, unknown>;
      if (headers["content-type"]?.startsWith("multipart/form-data")) {
        const form = await new Response(bytes, {
          headers: { "content-type": headers["content-type"] },
        }).formData();
        const part = form.get("file") ?? form.get("image");
        if (!part || typeof part === "string")
          throw new DomainError(400, "upload_required", "file required");
        if (!part.size)
          throw new DomainError(
            400,
            "empty_upload",
            "Attachment must not be empty",
          );
        if (part.size > 64 * 1024 * 1024)
          throw new DomainError(413, "upload_limit", "File too large");
        const name =
          basename(part.name)
            .replace(/[^\p{L}\p{N}_. -]/gu, "_")
            .slice(0, 150) || "file";
        const dir = this.uploadDirectory(request, localId!);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, randomUUID() + "-" + name);
        await writeFile(path, Buffer.from(await part.arrayBuffer()), {
          flag: "wx",
          mode: 0o600,
        });
        upload = { path, name, size: part.size, content_type: part.type };
      } else {
        try {
          upload = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new DomainError(400, "invalid_upload", "Invalid upload");
        }
        if (!upload || typeof upload !== "object" || Array.isArray(upload))
          throw new DomainError(400, "invalid_upload", "Invalid upload");
        if (
          typeof upload.filename === "string" &&
          typeof upload.data_b64 === "string"
        ) {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(upload.data_b64))
            throw new DomainError(
              400,
              "invalid_base64",
              "Invalid attachment data",
            );
          const raw = Buffer.from(upload.data_b64, "base64");
          if (!raw.length)
            throw new DomainError(
              400,
              "empty_upload",
              "Attachment must not be empty",
            );
          if (raw.length > 64 * 1024 * 1024)
            throw new DomainError(413, "upload_limit", "File too large");
          const name =
            basename(upload.filename)
              .replace(/[^\p{L}\p{N}_. -]/gu, "_")
              .slice(0, 150) || "file";
          const dir = this.uploadDirectory(request, localId!);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, randomUUID() + "-" + name);
          await writeFile(path, raw, { flag: "wx", mode: 0o600 });

          upload = {
            path,
            name,
            size: raw.length,
            content_type:
              typeof upload.content_type === "string" && upload.content_type
                ? upload.content_type
                : (kind(name, raw).content_type ?? "application/octet-stream"),
          };
        } else if (typeof upload.path === "string") {
          if (request.workspace)
            throw new DomainError(
              403,
              "upload_path",
              "Delegated attachments must use the file picker; arbitrary stored paths cannot be injected",
            );
          await openFile(
            await guardedPath(await canonicalRoot(cwd), upload.path),
          ).then((f) => f.close());
        } else
          throw new DomainError(
            400,
            "upload_required",
            "Attachment data required",
          );
      }
      request.signal.throwIfAborted();
      return json(
        await this.runtime.request(request.path, request.method, {
          ...upload,
          actorId: request.actorId,
          workspace: request.workspace,
        }),
      );
    }
    if (["live", "messages/live"].includes(action)) {
      const runtime = this.runtime;
      const signal = request.signal;
      return {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
        body: (async function* () {
          let cursor = q.get("after") ?? q.get("cursor") ?? "";
          while (!signal.aborted) {
            const payload = (await runtime.request(
              `/api/sessions/${localId}/messages/live${cursor ? "?after=" + encodeURIComponent(cursor) : ""}`,
            )) as Record<string, unknown>;
            if (typeof payload.live_cursor === "string")
              cursor = payload.live_cursor;
            yield Buffer.from(
              "event: message\ndata: " + JSON.stringify(payload) + "\n\n",
            );
            try {
              await setTimeout(250, undefined, { signal });
            } catch {
              break;
            }
          }
        })(),
      };
    }
    if (pathname === "/api/cwd-suggest") {
      const raw = q.get("path") || "/",
        prefix = q.get("prefix") || "";
      const path = raw.startsWith("~/")
        ? join(this.runtime.home, raw.slice(2))
        : raw;
      const operation = (async () => {
        let handle;
        try {
          handle = await openFile(
            resolve(path),
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          const entries = await readdir(`/proc/self/fd/${handle.fd}`, {
            withFileTypes: true,
          });
          return entries
            .filter(
              (entry) =>
                entry.isDirectory() &&
                entry.name.startsWith(prefix) &&
                (prefix.startsWith(".") || !entry.name.startsWith(".")),
            )
            .slice(0, 50)
            .map((entry) => ({
              name: entry.name,
              path: join(path, entry.name),
            }));
        } catch (error) {
          if (
            error instanceof DomainError &&
            error.code === "unsupported_platform"
          )
            throw error;
          return [];
        } finally {
          await handle?.close();
        }
      })();
      return json({
        directories: await Promise.race([operation, setTimeout(2000, [])]),
      });
    }
    if (pathname === "/api/settings/voice")
      return json(
        request.method === "POST"
          ? await this.voice.settings(body ?? {})
          : await this.voice.snapshot(),
      );
    if (pathname === "/api/settings/unattended-prompt")
      return this.settings(pathname, request.method, body ?? {});
    if (pathname === "/api/notifications/feed") {
      const since = Number(q.get("since") ?? 0);
      if (!Number.isFinite(since))
        throw new DomainError(400, "invalid_since", "invalid since");
      return json({
        ok: true,
        items: await this.notificationRows(since * 1000),
      });
    }
    if (pathname === "/api/audio/live.m3u8") {
      const data = this.voice.playlist();
      return {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "no-store",
        },
        body: (async function* () {
          yield data;
        })(),
      };
    }
    if (pathname.startsWith("/api/audio/segments/"))
      return this.streamFile(
        request,
        this.voice.segmentPath(pathname.split("/").at(-1)!),
        false,
        "video/mp2t",
      );
    if (pathname === "/api/audio/listener")
      return json(this.voice.listener(body ?? {}));
    if (
      ["/api/notifications/text", "/api/notifications/state"].includes(pathname)
    ) {
      const id = q.get("message_id");
      if (!id)
        throw new DomainError(400, "message_required", "message_id required");
      const rows = await this.notificationRows(0);
      const row = rows.find(
        (r) => r.message_id === id || r.source_message_id === id,
      );
      if (!row) return json({ error: "unknown message" }, 404);
      return json({ ok: true, ...row, text: row.notification_text });
    }
    return json(
      await this.runtime.request(request.path, request.method, {
        ...body,
        actorId: request.actorId,
        workspace: request.workspace,
      }),
    );
  }
  private uploadDirectory(request: HttpRequest, localId: string) {
    if (!request.actorId)
      return join(this.runtime.stateHome, "uploads", localId);
    const actor = request.actorId
      ? createHash("sha256")
          .update(
            request.actorId +
              ":" +
              JSON.stringify(request.workspace ?? "owner"),
          )
          .digest("hex")
      : "local";
    return join(this.runtime.stateHome, "uploads", actor, localId);
  }
  private async notificationRows(since: number) {
    const notifications = await this.runtime.completions(since);
    if (!notifications.length) return [];
    const catalog = (await this.runtime.request("/api/sessions")) as {
      sessions: Array<{ session_id: string; alias?: string }>;
    };
    const names = new Map(
      catalog.sessions.map((row) => [
        row.session_id,
        row.alias?.trim() || row.session_id,
      ]),
    );
    const transcripts = new Map<
      string,
      Promise<{
        events?: Array<{
          message_id?: string;
          role?: string;
          text?: string;
          ts?: number;
          message_class?: string;
        }>;
      }>
    >();
    return Promise.all(
      notifications.slice(-500).map(async (item) => {
        let transcript = transcripts.get(item.localId);
        if (!transcript) {
          transcript = this.runtime.request(
            `/api/sessions/${item.localId}/messages/tail?limit=100`,
          ) as Promise<{
            events?: Array<{
              message_id?: string;
              role?: string;
              text?: string;
              ts?: number;
              message_class?: string;
            }>;
          }>;
          transcripts.set(item.localId, transcript);
        }
        const events = (await transcript).events ?? [];
        const event =
          events
            .filter((e) => e.role === "assistant" && e.text)
            .find(
              (e) =>
                e.ts !== undefined &&
                createHash("sha256")
                  .update(item.localId + e.message_id)
                  .digest("hex") === item.id,
            ) ?? events.filter((e) => e.role === "assistant" && e.text).at(-1);
        return {
          message_id: item.id,
          source_message_id: event?.message_id,
          session_id: item.localId,
          session_display_name: names.get(item.localId) ?? item.localId,
          updated_ts: item.occurredAt / 1000,
          message_class: event?.message_class ?? "final_response",
          summary_status: "ready",
          push_status: "not_requested",
          notification_text: (event?.text ?? "").slice(0, 2400),
        };
      }),
    );
  }
  private async settings(
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    if (method === "POST") {
      if (typeof body.prompt !== "string")
        throw new DomainError(400, "invalid_prompt", "prompt must be a string");
      await updateSettings(this.runtime.stateHome, (state) => {
        state.unattended = body.prompt;
      });
    }
    return json({
      ok: true,
      prompt: await readUnattendedPrompt(this.runtime.stateHome),
      default_prompt: DEFAULT_UNATTENDED_PROMPT,
    });
  }
  private async streamFile(
    request: HttpRequest,
    path: string,
    download: boolean,
    contentType?: string,
  ): Promise<HttpResponse> {
    const file = await openFile(path);
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new DomainError(400, "not_file", "path is not a file");
      const prefix = Buffer.alloc(Math.min(4096, stat.size));
      await file.read(prefix, 0, prefix.length, 0);
      const type = kind(path, prefix);
      if (!download && !type.content_type && !contentType)
        throw new DomainError(
          400,
          "not_previewable",
          "file is not previewable inline",
        );
      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      const headers: Record<string, string> = {
        "content-type":
          contentType ?? type.content_type ?? "application/octet-stream",
        "accept-ranges": "bytes",
        etag: etag,
        "last-modified": stat.mtime.toUTCString(),
        "cache-control": "private, no-cache",
      };
      if (download)
        headers["content-disposition"] =
          `attachment; filename*=UTF-8''${encodeURIComponent(displayPath(basename(path)))}`;
      if (request.headers["if-none-match"] === etag) {
        await file.close();
        return { status: 304, headers, body: emptyBody };
      }
      let start = 0,
        end = stat.size - 1,
        status = 200;
      const range = request.headers.range;
      if (
        range &&
        (!request.headers["if-range"] || request.headers["if-range"] === etag)
      ) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          throw new DomainError(416, "invalid_range", "Invalid byte range");
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (start >= stat.size || start > end) {
          await file.close();
          return {
            status: 416,
            headers: { ...headers, "content-range": `bytes */${stat.size}` },
            body: emptyBody,
          };
        }
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers["content-length"] = String(Math.max(0, end - start + 1));
      if (request.method === "HEAD") {
        await file.close();
        return { status, headers, body: emptyBody };
      }
      const signal = request.signal,
        registry = this.registry;
      return {
        status,
        // Keep the native root fence active after handing the streaming body to the tunnel.
        headers,
        body: (async function* () {
          let position = start;
          try {
            while (position <= end) {
              signal.throwIfAborted();
              if (request.workspace)
                await registry.selected(request.workspace.id);
              const buffer = Buffer.alloc(Math.min(65536, end - position + 1));
              const { bytesRead } = await file.read(
                buffer,
                0,
                buffer.length,
                position,
              );
              if (!bytesRead) break;
              position += bytesRead;
              yield buffer.subarray(0, bytesRead);
            }
          } finally {
            await file.close();
          }
        })(),
      };
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  }
}

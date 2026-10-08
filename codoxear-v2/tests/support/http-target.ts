// Node HTTP fixture adapter used only to exercise the tunnel contract.
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { DomainError } from "../../src/contracts/model.js";
import { classifyRoute, filterHeaders } from "../../src/protocol/routes.js";
import { relaySessionId, requireRelaySessionId } from "../../src/computer/runtime-identity.js";
import {
  emptyBody,
  type HttpRequest,
  type HttpResponse,
} from "../../src/protocol/http-frames.js";
export class LocalHttpTarget {
  private cookie = "";
  private login: Promise<void> | undefined;
  constructor(
    private origin: string,
    private password: string,
    private workspacePath?: string,
  ) {
    const u = new URL(origin);
    if (
      u.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw new Error("Local target must be an explicit loopback origin");
  }
  private async authenticate() {
    if (this.cookie) return;
    this.login ??= (async () => {
      const response = await fetch(new URL("/api/login", this.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: this.password }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Local authentication failed");
      const value = response.headers.get("set-cookie")?.split(";")[0];
      if (!value) throw new Error("Missing local authentication");
      this.cookie = value;
    })();
    try {
      await this.login;
    } finally {
      this.login = undefined;
    }
  }
  async execute(request: HttpRequest): Promise<HttpResponse> {
    const route = classifyRoute(request.method, request.path);
    if (route.localId) requireRelaySessionId(route.localId);
    if (/\/draft(?:\?|$)/.test(request.path))
      throw new Error("Remote drafts require account-scoped Computer storage");
    if (
      request.method === "POST" &&
      /\/(enqueue|queue\/(delete|update|move))(?:\?|$)/.test(request.path)
    )
      throw new Error(
        "Remote queued actions must use the computer's authorized queue",
      );
    await this.authenticate();
    const headers = filterHeaders(request.headers, "request");
    let path = request.path;
    if (request.workspace) {
      if (!this.workspacePath || !request.actorId) throw new DomainError(403, "workspace_unavailable", "Verified workspace context required");
      if (route.action === "files.write" && request.workspace.access !== "write") throw new DomainError(403, "workspace_read_only", "Workspace access is read-only");
      headers["x-codoxear-workspace"] = Buffer.from(JSON.stringify({ root: await realpath(this.workspacePath), access: request.workspace.access })).toString("base64url");
      path = "/api/relay-workspace/v1" + path;
    }
    headers.cookie = this.cookie;
    headers["accept-encoding"] = "identity";
    let temporary: string | undefined,
      body: ReadableStream<Uint8Array> | undefined;
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        if (headers["content-length"]) {
          const size = Number(headers["content-length"]);
          if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > 256 * 1024 * 1024
          )
            throw new Error("Invalid upload length");
          body = Readable.toWeb(
            Readable.from(request.body),
          ) as ReadableStream<Uint8Array>;
        } else {
          temporary = await mkdtemp(join(tmpdir(), "codoxear-upload-"));
          const path = join(temporary, "body"),
            file = await open(path, "wx", 0o600);
          let size = 0;
          try {
            for await (const chunk of request.body) {
              size += chunk.byteLength;
              if (size > 256 * 1024 * 1024)
                throw new Error("Upload exceeds limit");
              await file.write(chunk);
            }
          } finally {
            await file.close();
          }
          headers["content-length"] = String(size);
          body = Readable.toWeb(
            createReadStream(path),
          ) as ReadableStream<Uint8Array>;
        }
      }
      const response = await fetch(new URL(path, this.origin), {
        method: request.method,
        headers,
        redirect: "manual",
        signal: request.signal,
        ...(body ? { body, duplex: "half" } : {}),
      } as RequestInit);
      if (response.status === 401) this.cookie = "";
      const responseHeaders = filterHeaders(
        Object.fromEntries(response.headers.entries()),
        "response",
      );
      // fetch decodes compressed bodies. Their original wire length must never truncate the relayed body.
      if (
        response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity"
      )
        delete responseHeaders["content-length"];
      const result: HttpResponse = {
        status: response.status,
        headers: responseHeaders,
        body: response.body
          ? (response.body as unknown as AsyncIterable<Uint8Array>)
          : emptyBody,
      };
      if (response.ok && request.path.split("?")[0] === "/api/notifications/feed") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of result.body) {
          size += chunk.byteLength;
          if (size > 1024 * 1024) throw new Error("Notification feed exceeds limit");
          chunks.push(Buffer.from(chunk));
        }
        const feed = JSON.parse(Buffer.concat(chunks).toString()) as { items: Array<{ session_id: string }> };
        const content = Buffer.from(JSON.stringify({ ...feed, items: feed.items.filter((item) => relaySessionId(item.session_id)) }));
        result.headers["content-length"] = String(content.byteLength);
        result.body = (async function* () { yield content; })();
      }
      if (temporary) {
        await rm(temporary, { recursive: true });
        temporary = undefined;
      }
      return result;
    } finally {
      if (temporary) await rm(temporary, { recursive: true });
    }
  }
}

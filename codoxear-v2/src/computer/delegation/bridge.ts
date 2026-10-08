import { createServer, type Server, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, unlink, readFile, rmdir } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Launch } from "../../contracts/tunnel.js";
import type { Attachment } from "../config.js";
import { atomicJson } from "../../persistence/files.js";
import { DomainError, Id } from "../../contracts/model.js";
import { DelegationClient } from "./client.js";

export type DelegationEndpoint = { descriptor: string };
const ToolRequest = z
  .object({
    action: z.enum([
      "targets",
      "spawn",
      "list",
      "status",
      "messages",
      "send",
      "interrupt",
    ]),
    requestId: Id.optional(),
    targetComputerId: Id.optional(),
    childId: Id.optional(),
    backend: z.enum(["pi", "codex", "cc"]).optional(),
    name: z.string().max(120).optional(),
    launch: Launch.pick({
      model: true,
      model_provider: true,
      reasoning_effort: true,
      cwd: true,
    })
      .strict()
      .optional(),
    text: z.string().min(1).max(200000).optional(),
  })
  .strict();
type Session = {
  capability: string;
  descriptor: string;
  abort: AbortController;
};
type Grant = { parent: string; grant: string; expires: number; scope: string };

/** Local tools receive only a session capability. Attachment bearer and Hub
 * delegation grants stay in this Computer-owned process/private database. */
export class DelegationBridge {
  private server: Server | undefined;
  private db: DatabaseSync | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly sockets = new Set<Socket>();
  private readonly active = new Map<string, number>();
  private inFlight = 0;
  private readonly scope: string;
  private socketPath = "";
  private socketDirectory = "";
  private readonly abort = new AbortController();
  private closed = false;
  constructor(
    private readonly stateHome: string,
    private readonly attachment: Attachment,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.scope = createHash("sha256")
      .update(
        JSON.stringify([
          attachment.hubUrl,
          attachment.hubId,
          attachment.computerId,
          attachment.binding ?? 0,
          attachment.credential,
        ]),
      )
      .digest("hex");
  }
  async start() {
    const privateDir = join(this.stateHome, "delegation");
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await chmod(privateDir, 0o700);
    this.db = new DatabaseSync(join(privateDir, "grants.sqlite"));
    chmodSync(join(privateDir, "grants.sqlite"), 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS grants(local TEXT PRIMARY KEY,parent TEXT,grant TEXT,expires INTEGER,scope TEXT); DELETE FROM grants;",
    );
    const socketDir = join(
      tmpdir(),
      "codoxear-delegation-" + randomBytes(16).toString("hex"),
    );
    this.socketDirectory = socketDir;
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    await chmod(socketDir, 0o700);
    this.socketPath = join(socketDir, "tools.sock");
    await unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.server = createServer((socket) => this.connection(socket));
    this.server.on("error", () => {
      this.abort.abort();
    });
    this.server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }
  async prepare(localId: string): Promise<DelegationEndpoint> {
    if (this.closed || !this.db)
      throw Error("Delegation bridge is unavailable");
    if (!/^managed-[a-f0-9]{32}$/.test(localId))
      throw new DomainError(
        409,
        "setup_required",
        "Delegation tools currently require a managed Pi session; running terminal sessions need separately reviewed extension reload setup",
      );
    let session = this.sessions.get(localId);
    {
      const capability = randomBytes(32).toString("hex");
      const descriptor = join(this.stateHome, "delegation", localId + ".json");
      session = { capability, descriptor, abort: new AbortController() };
      this.sessions.set(localId, session);
      await atomicJson(descriptor, {
        version: 1,
        socket: this.socketPath,
        capability,
        localId,
      });
      await unlink(descriptor + ".loaded.json").catch(() => {});
    }
    return { descriptor: session.descriptor };
  }
  async install(input: {
    parentId: string;
    localId: string;
    grant: string;
    expiresAt: number;
  }) {
    const session = this.sessions.get(input.localId);
    if (!session || this.closed || !this.db)
      throw new DomainError(
        409,
        "setup_required",
        "This exact session has no controlled delegation extension. Start a managed Pi session; existing CLI sessions are preserved",
      );
    if (input.expiresAt <= Date.now())
      throw new DomainError(
        403,
        "delegation_expired",
        "Delegation grant expired",
      );
    let loaded: { capability?: unknown; localId?: unknown };
    try {
      loaded = JSON.parse(
        await readFile(session.descriptor + ".loaded.json", "utf8"),
      );
    } catch {
      throw new DomainError(
        409,
        "setup_required",
        "The Pi delegation extension has not confirmed loading for this session",
      );
    }
    if (
      loaded.capability !== session.capability ||
      loaded.localId !== input.localId
    )
      throw new DomainError(
        409,
        "setup_required",
        "Delegation extension belongs to another runtime incarnation",
      );
    this.db
      .prepare(
        "INSERT INTO grants VALUES(?,?,?,?,?) ON CONFLICT(local) DO UPDATE SET parent=excluded.parent,grant=excluded.grant,expires=excluded.expires,scope=excluded.scope",
      )
      .run(
        input.localId,
        input.parentId,
        input.grant,
        input.expiresAt,
        this.scope,
      );
    return {
      installed: true,
      parentId: input.parentId,
      localId: input.localId,
      expiresAt: input.expiresAt,
      grantDigest: createHash("sha256").update(input.grant).digest("hex"),
      supportedBackends: ["pi"],
    };
  }
  async status(input: { parentId: string; localId: string }) {
    const session = this.sessions.get(input.localId);
    const grant = this.db
      ?.prepare("SELECT parent,grant,expires,scope FROM grants WHERE local=?")
      .get(input.localId) as Grant | undefined;
    if (
      this.closed ||
      !session ||
      !grant ||
      grant.parent !== input.parentId ||
      grant.scope !== this.scope ||
      grant.expires <= Date.now()
    )
      return { installed: false };
    try {
      const loaded = JSON.parse(
        await readFile(session.descriptor + ".loaded.json", "utf8"),
      );
      if (
        loaded.capability !== session.capability ||
        loaded.localId !== input.localId
      )
        return { installed: false };
    } catch {
      return { installed: false };
    }
    return {
      installed: true,
      expiresAt: grant.expires,
      grantDigest: createHash("sha256").update(grant.grant).digest("hex"),
      supportedBackends: ["pi"],
    };
  }
  revoke(input: { parentId: string; localId: string }) {
    this.db
      ?.prepare("DELETE FROM grants WHERE local=? AND parent=?")
      .run(input.localId, input.parentId);
    return { revoked: true };
  }
  async release(localId: string) {
    const session = this.sessions.get(localId);
    if (!session) return;
    session.abort.abort();
    this.sessions.delete(localId);
    await unlink(session.descriptor).catch(() => {});
    await unlink(session.descriptor + ".loaded.json").catch(() => {});
  }
  private connection(socket: Socket) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(45000, () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "",
      received = false;
    socket.on("data", (chunk: string) => {
      if (received) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 256 * 1024) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      received = true;
      let message: { localId: string; capability: string; request: unknown };
      try {
        message = JSON.parse(buffer.slice(0, end));
      } catch {
        socket.destroy();
        return;
      }
      void this.dispatch(message).then(
        (value) => this.answer(socket, { ok: true, value }),
        (error) =>
          this.answer(socket, {
            ok: false,
            error:
              error instanceof DomainError
                ? error.message
                : "Delegation request failed; delivery may be unknown. Inspect child receipts before retrying",
            code:
              error instanceof DomainError ? error.code : "delegation_unknown",
          }),
      );
    });
  }
  private answer(socket: Socket, value: unknown) {
    const json = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(json) > 1024 * 1024) {
      socket.end(
        JSON.stringify({
          ok: false,
          code: "delegation_response_limit",
          error: "Delegation response exceeded the bounded local channel",
        }) + "\n",
      );
      return;
    }
    socket.end(json);
  }
  private async dispatch(message: {
    localId: string;
    capability: string;
    request: unknown;
  }) {
    const session = this.sessions.get(message.localId);
    if (
      !session ||
      typeof message.capability !== "string" ||
      Buffer.byteLength(message.capability) !==
        Buffer.byteLength(session.capability) ||
      !timingSafeEqual(
        Buffer.from(message.capability),
        Buffer.from(session.capability),
      )
    )
      throw new DomainError(
        403,
        "delegation_capability",
        "Invalid local session capability",
      );
    const request = ToolRequest.parse(message.request);
    const count = this.active.get(message.localId) ?? 0;
    if (count >= 4 || this.inFlight >= 32)
      throw new DomainError(
        429,
        "delegation_busy",
        "Too many local delegation calls",
      );
    const grant = this.db!.prepare(
      "SELECT parent,grant,expires,scope FROM grants WHERE local=?",
    ).get(message.localId) as Grant | undefined;
    if (!grant || grant.scope !== this.scope || grant.expires <= Date.now())
      throw new DomainError(
        403,
        "delegation_expired",
        "An active owner-approved delegation grant is required for this parent",
      );
    const client = new DelegationClient(
      this.attachment,
      grant.parent,
      grant.grant,
      this.transport,
    );
    const signal = AbortSignal.any([this.abort.signal, session.abort.signal]);
    this.active.set(message.localId, count + 1);
    this.inFlight++;
    try {
      if (request.action === "targets") return await client.targets(signal);
      if (request.action === "list") return await client.list(signal);
      if (request.action === "spawn") {
        if (!request.requestId || !request.targetComputerId || !request.backend)
          throw new DomainError(
            400,
            "delegation_input",
            "Spawn requires requestId, targetComputerId and backend",
          );
        return await client.spawn(
          {
            requestId: request.requestId,
            targetComputerId: request.targetComputerId,
            backend: request.backend,
            name: request.name ?? "Subagent",
            ...(request.launch ? { launch: request.launch } : {}),
          },
          signal,
        );
      }
      if (!request.childId)
        throw new DomainError(
          400,
          "delegation_input",
          "Child identity is required",
        );
      if (request.action === "status")
        return await client.status(request.childId, signal);
      if (request.action === "messages")
        return await client.messages(request.childId, signal);
      if (request.action === "interrupt")
        return await client.interrupt(request.childId, signal);
      if (!request.text)
        throw new DomainError(
          400,
          "delegation_input",
          "Child input is required",
        );
      return await client.send(request.childId, request.text, signal);
    } finally {
      this.inFlight--;
      const remaining = Math.max(
        0,
        (this.active.get(message.localId) ?? 1) - 1,
      );
      if (remaining) this.active.set(message.localId, remaining);
      else this.active.delete(message.localId);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.db?.exec("DELETE FROM grants");
    this.db?.close();
    this.db = undefined;
    for (const session of this.sessions.values()) {
      await unlink(session.descriptor).catch(() => {});
      await unlink(session.descriptor + ".loaded.json").catch(() => {});
    }
    this.sessions.clear();
    if (this.socketPath) await unlink(this.socketPath).catch(() => {});
    if (this.socketDirectory) await rmdir(this.socketDirectory).catch(() => {});
  }
}

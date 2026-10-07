import { HttpMux } from "../protocol/http-mux.js";
import { NativeHttpTarget } from "./native/http.js";
import { NativeRuntime } from "./native/runtime.js";
import { ManagedRuntime } from "./managed/runtime.js";
import { DelegationBridge } from "./delegation/bridge.js";
import type { HttpRequest, HttpResponse } from "../protocol/http-frames.js";
import { ComputerDrafts } from "./drafts.js";
import { ComputerLaunches } from "./launches.js";
import { relaySessionId, requireRelaySessionId } from "./runtime-identity.js";
import { classifyRoute } from "../protocol/routes.js";
import { ComputerQueue } from "./queue.js";
import { CompletionOutbox } from "./notifications.js";
import { NotificationAck } from "../protocol/notifications.js";
import { DomainError } from "../contracts/model.js";
import { WebSocket } from "ws";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RequestFrame,
  WelcomeFrame,
  MAX_FRAME_BYTES,
} from "../contracts/tunnel.js";
import {
  acquireLock,
  atomicJson,
  readAttachment,
  type Attachment,
} from "./config.js";
import type { Runtime, WorkspaceRuntime } from "./runtime.js";
import { RuntimeConfig } from "./config.js";

export type ComputerDependencies = {
  runtime?: (config: Attachment, home: string) => Runtime;
  httpTarget?: (
    runtime: Runtime,
    config: Attachment,
  ) => { execute(request: HttpRequest): Promise<HttpResponse>; close?(): void };
};
export type ComputerStatus = {
  state:
    "starting" | "connecting" | "online" | "offline" | "blocked" | "stopped";
  computerId: string;
  hubId: string;
  runtime: string;
  updatedAt: number;
  detail: string;
};
// Shared public API: CLI and a future desktop presenter use this same object.
// The service owns local state. A network disconnect never destroys runtime.
export class ComputerService {
  private writes: Promise<void> = Promise.resolve();
  private running = new Set<Promise<unknown>>();
  private http: HttpMux | undefined;
  private httpTarget:
    | { execute(request: HttpRequest): Promise<HttpResponse>; close?(): void }
    | undefined;
  private socket: WebSocket | undefined;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private epoch = "";
  private inFlight = new Set<string>();
  private unlock: (() => Promise<void>) | undefined;
  private runtime: Runtime | undefined;
  private delegation: DelegationBridge | undefined;
  private queue: ComputerQueue | undefined;
  private drafts: ComputerDrafts | undefined;
  private launches: ComputerLaunches | undefined;
  private providerLaunch = false;
  private queueTimer: ReturnType<typeof setInterval> | undefined;
  private outbox: CompletionOutbox | undefined;
  private noticeTimer: ReturnType<typeof setInterval> | undefined;
  private collecting = false;
  private noticeEnabled = false;
  constructor(
    private home: string,
    private onStatus: (status: ComputerStatus) => void = () => {},
    private dependencies: ComputerDependencies = {},
  ) {}
  async start(): Promise<void> {
    this.unlock = await acquireLock(this.home);
    try {
      if (await (await import("./transfer.js")).transferStatus(this.home))
        throw new DomainError(
          409,
          "transfer_pending",
          "Finish the saved Computer transfer before connecting to a Hub",
        );
      const config = await readAttachment(this.home);
      if (!config)
        throw new Error("Computer is not attached; use attach first");
      RuntimeConfig.parse(config);
      if (config.runtime === "fixture" && !this.dependencies.runtime)
        throw new DomainError(
          400,
          "setup_required",
          "Synthetic runtimes require an explicitly injected verification adapter",
        );
      if (config.runtime === "native" && !config.workspacePath)
        throw new Error("Native runtime requires an explicit workspace path");
      if (config.runtime === "oar") {
        this.delegation = new DelegationBridge(
          config.nativeStateHome ?? this.home,
          config,
        );
        await this.delegation.start();
      }
      this.runtime =
        this.dependencies.runtime?.(config, this.home) ??
        (config.runtime === "oar"
          ? new ManagedRuntime({
              databasePath: join(
                config.nativeStateHome ?? this.home,
                "managed.sqlite",
              ),
              home: config.nativeHome ?? homedir(),
              workspace: config.workspacePath!,
              stateHome: config.nativeStateHome ?? this.home,
              ...(config.oarPermissionPolicy
                ? { permissionPolicy: config.oarPermissionPolicy }
                : {}),
              maxResident: config.oarMaxResident ?? 2,
              idleMs: config.oarIdleMs ?? 60000,
              ...(this.delegation ? { delegation: this.delegation } : {}),
              legacy: new NativeRuntime(
                config.nativeHome ?? homedir(),
                config.workspacePath!,
                config.nativeStateHome ?? this.home,
              ),
            })
          : new NativeRuntime(
              config.nativeHome ?? homedir(),
              config.workspacePath!,
              config.nativeStateHome ?? this.home,
            ));
      this.providerLaunch =
        (await this.runtime!.supportsProviderLaunch?.().catch(() => false)) ??
        false;
      this.launches = new ComputerLaunches(
        join(this.home, "launches.sqlite"),
        JSON.stringify([config.hubId, config.computerId, config.binding ?? 0]),
      );
      if (config.runtime !== "fixture") {
        this.drafts = new ComputerDrafts(
          join(this.home, "drafts.sqlite"),
          JSON.stringify([
            config.hubId,
            config.computerId,
            config.binding ?? 0,
          ]),
        );
        this.outbox = new CompletionOutbox(
          join(this.home, "notifications.sqlite"),
          JSON.stringify([
            config.hubId,
            config.computerId,
            config.binding ?? 0,
          ]),
        );
        this.noticeTimer = setInterval(() => {
          if (this.stopped || this.collecting) return;
          this.collecting = true;
          const run = (async () => {
            this.outbox!.observe(
              await this.runtime!.completions!(this.outbox!.cursor() - 1000),
            );
            const socket = this.socket;
            if (this.noticeEnabled && socket?.readyState === WebSocket.OPEN)
              for (const event of this.outbox!.pending().filter((event) =>
                relaySessionId(event.localId),
              ))
                socket.send(
                  JSON.stringify({
                    type: "notification",
                    epoch: this.epoch,
                    event,
                  }),
                );
          })();
          this.running.add(run);
          void run
            .catch(() => {})
            .finally(() => {
              this.running.delete(run);
              this.collecting = false;
            });
        }, 2000);
        this.runtime!.setQueueScope?.(
          JSON.stringify([
            config.hubId,
            config.computerId,
            config.binding ?? 0,
          ]),
        );
        this.queue = new ComputerQueue(
          join(this.home, "queues.sqlite"),
          JSON.stringify([
            config.hubId,
            config.computerId,
            config.binding ?? 0,
          ]),
          {
            ...(config.runtime === "native" && this.runtime!.queueControl
              ? {
                  unified: {
                    sessions: () => this.runtime!.queueControl!("", "sessions"),
                    control: (
                      localId: string,
                      operation: string,
                      body?: Record<string, unknown>,
                    ) => this.runtime!.queueControl!(localId, operation, body),
                  },
                }
              : {}),
            idle: async (localId) => {
              const catalog = (await this.runtime!.execute({
                op: "discover",
              })) as { sessions: Array<Record<string, unknown>> };
              const row = catalog.sessions.find(
                (s) => s.session_id === localId,
              );
              return (
                !!row &&
                row.busy === false &&
                !row.commit_unknown_send &&
                !row.pending_attachment &&
                !row.orphan_recovery
              );
            },
            authorize: async (permit, localId) => {
              const response = await fetch(
                new URL(
                  `/connect/v1/computers/${config.computerId}/authorize-queue`,
                  config.hubUrl,
                ),
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${config.credential}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ permit, localId }),
                  signal: AbortSignal.timeout(5000),
                  redirect: "error",
                },
              );
              if (!response.ok)
                throw new DomainError(
                  response.status,
                  "queue_authorization_unavailable",
                  "Queued action requires current user authorization",
                );
              await response.body?.cancel();
            },
            send: async (localId, text) => {
              const result = (
                this.runtime!.sendQueued
                  ? await this.runtime!.sendQueued(localId, text)
                  : await this.runtime!.execute({
                      op: "send",
                      agentId: config.computerId,
                      localId,
                      text,
                    })
              ) as { ok?: boolean; commit_unknown?: boolean };
              if (result.ok !== true || result.commit_unknown)
                throw new Error("Queued send outcome is unknown");
            },
          },
        );
        this.queueTimer = setInterval(() => {
          if (this.stopped) return;
          const run = this.queue!.drain();
          this.running.add(run);
          void run.catch(() => {}).finally(() => this.running.delete(run));
        }, 1000);
      }
      await this.status(config, "starting", "Computer runtime initialized");
      this.connect(config);
    } catch (e) {
      if (this.noticeTimer) clearInterval(this.noticeTimer);
      if (this.queueTimer) clearInterval(this.queueTimer);
      await Promise.allSettled([...this.running]);
      this.outbox?.close();
      this.outbox = undefined;
      this.drafts?.close();
      this.drafts = undefined;
      this.launches?.close();
      this.launches = undefined;
      this.queue?.close();
      this.queue = undefined;
      try {
        await this.delegation?.close();
        this.delegation = undefined;
        await this.runtime?.close();
      } finally {
        this.runtime = undefined;
        await this.unlock();
        this.unlock = undefined;
      }
      throw e;
    }
  }
  private async status(
    c: Attachment,
    state: ComputerStatus["state"],
    detail: string,
  ) {
    const value = {
      state,
      computerId: c.computerId,
      hubId: c.hubId,
      runtime: c.runtime,
      updatedAt: Date.now(),
      detail,
    };
    this.writes = this.writes
      .catch(() => {})
      .then(() => atomicJson(join(this.home, "status.json"), value));
    await this.writes;
    this.onStatus(value);
  }
  private connect(c: Attachment): void {
    if (this.stopped) return;
    void this.status(c, "connecting", "Connecting to the assigned hub").catch(
      () => this.stop(),
    );
    const url = new URL(`/connect/v1/computers/${c.computerId}`, c.hubUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${c.credential}`,
        "X-Codoxear-Hub": c.hubId,
      },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 10_000,
    });
    this.socket = ws;
    let blocked = false;
    ws.on("unexpected-response", (_request, response) => {
      if ([401, 403, 404].includes(response.statusCode ?? 0)) {
        blocked = true;
        void this.status(
          c,
          "blocked",
          "Attachment rejected. The owner must review pairing or credentials.",
        ).catch(() => this.stop());
      }
      response.resume();
      ws.terminate();
    });
    ws.on("message", async (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        ws.close(1008, "Invalid frame");
        return;
      }
      const welcome = WelcomeFrame.safeParse(frame);
      if (welcome.success) {
        this.epoch = welcome.data.epoch;
        this.noticeEnabled =
          !!welcome.data.capabilities?.includes("notifications");
        this.http?.close();
        this.httpTarget?.close?.();
        const target =
          c.runtime !== "fixture"
            ? (this.dependencies.httpTarget?.(this.runtime!, c) ??
              new NativeHttpTarget(
                this.runtime! as WorkspaceRuntime,
                c.workspacePath!,
              ))
            : undefined;
        this.httpTarget = target;
        this.http = new HttpMux(
          ws,
          this.epoch,
          target
            ? async (request) => {
                const route = classifyRoute(request.method, request.path);
                if (route.localId) requireRelaySessionId(route.localId);
                return (
                  (await this.drafts?.handle(request)) ??
                  (await this.queue?.handle(request)) ??
                  target.execute(request)
                );
              }
            : undefined,
        );
        ws.send(
          JSON.stringify({
            type: "hello",
            protocol: 1,
            capabilities: [
              "agents",
              "launch-receipts",
              ...(c.runtime === "oar"
                ? [
                    "managed-runtime",
                    ...(this.delegation ? ["delegation-tools"] : []),
                  ]
                : []),
              ...(target
                ? [
                    "http-streams",
                    "files",
                    "git",
                    "transcript-cursors",
                    "launch-options",
                    "resume-candidates",
                    ...(this.providerLaunch ? ["provider-launch"] : []),
                    "authorized-queue",
                    "personal-drafts",
                    "session-incarnations",
                    "workspace-files",
                    "workspace-capabilities-v2",
                  ]
                : []),
            ],
          }),
        );
        this.attempts = 0;
        await this.status(c, "online", "Connected").catch(() => this.stop());
        return;
      }
      const acknowledged = NotificationAck.safeParse(frame);
      if (acknowledged.success) {
        try {
          if (
            !this.stopped &&
            this.socket === ws &&
            acknowledged.data.epoch === this.epoch
          )
            this.outbox?.acknowledge(acknowledged.data.id);
        } catch {
          ws.close(1011, "Notification journal unavailable");
        }
        return;
      }
      if (
        frame &&
        typeof frame === "object" &&
        "type" in frame &&
        typeof frame.type === "string" &&
        frame.type.startsWith("http.")
      )
        return;
      const parsed = RequestFrame.safeParse(frame);
      if (!parsed.success || parsed.data.epoch !== this.epoch) {
        ws.close(1008, "Invalid request");
        return;
      }
      const request = parsed.data,
        key = `${request.epoch}:${request.id}`;
      if (this.inFlight.has(key)) return;
      if (this.inFlight.size >= 32) {
        ws.close(1013, "Too many requests");
        return;
      }
      this.inFlight.add(key);
      try {
        const op = request.operation;
        const execute = () =>
          this.runtime!.executeWithReceipt
            ? this.runtime!.executeWithReceipt(op, request.id)
            : this.runtime!.execute(op);
        const operation =
          op.op === "launch-status"
            ? Promise.resolve(this.launches!.status(op.agentId))
            : op.op === "create"
              ? this.launches!.create(op, execute)
              : execute();
        this.running.add(operation);
        let value: unknown;
        try {
          value = await operation;
          if (c.runtime !== "fixture" && op.op === "launch-status") {
            const receipt = value as {
              state: string;
              result?: { localId: string };
            };
            if (receipt.state === "ready")
              requireRelaySessionId(receipt.result!.localId);
          }
          if (request.operation.op === "discover" && this.queue) {
            const catalog = value as {
              sessions: Array<Record<string, unknown>>;
            };
            const timestamps = this.drafts?.timestamps(
              request.operation.actorId ?? "",
            );
            for (const session of catalog.sessions) {
              session.draft_updated_ts =
                timestamps?.get(String(session.session_id)) ?? 0;
              const queued = await this.queue
                .listAsync(String(session.session_id))
                .catch(() => this.queue!.list(String(session.session_id)));
              session.remote_queue_len = queued.filter(
                (item: any) => item.origin !== "local",
              ).length;
              session.queue_len =
                session.unified_queue === true
                  ? queued.length
                  : Number(session.queue_len ?? 0) +
                    Number(session.remote_queue_len);
            }
          }
        } finally {
          this.running.delete(operation);
        }
        const result = JSON.stringify({
          type: "result",
          id: request.id,
          epoch: request.epoch,
          ok: true,
          value,
        });
        if (Buffer.byteLength(result) > MAX_FRAME_BYTES)
          throw new Error("Response exceeds the current tunnel frame limit");
        if (ws.readyState === WebSocket.OPEN) ws.send(result);
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: "result",
              id: request.id,
              epoch: request.epoch,
              ok: false,
              ...(error instanceof DomainError &&
              ["not_dispatched", "setup_required"].includes(error.code)
                ? { errorCode: error.code }
                : {}),
              error:
                error instanceof Error
                  ? error.message
                  : "Runtime operation failed",
            }),
          );
      } finally {
        this.inFlight.delete(key);
      }
    });
    ws.on("error", () => {}); // close drives recovery; no unhandled EventEmitter error.
    ws.on("close", () => {
      if (this.stopped || blocked) return;
      void this.status(
        c,
        "offline",
        "Connection lost; local runtime remains available",
      ).catch(() => this.stop());
      const delay =
        Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) *
        (0.8 + Math.random() * 0.4);
      this.retry = setTimeout(() => this.connect(c), delay);
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.noticeTimer) clearInterval(this.noticeTimer);
    if (this.retry) clearTimeout(this.retry);
    this.http?.close();
    this.httpTarget?.close?.();
    this.httpTarget = undefined;
    this.socket?.close(1000, "Computer service stopped");
    await Promise.allSettled([...this.running]);
    this.queue?.close();
    this.drafts?.close();
    this.launches?.close();
    this.outbox?.close();
    try {
      await this.delegation?.close();
      this.delegation = undefined;
      await this.runtime?.close();
      const c = await readAttachment(this.home);
      if (c)
        await this.status(
          c,
          "stopped",
          c.runtime === "oar"
            ? "Service stopped; owned OAR workers disposed and conversation history retained"
            : "Service stopped; externally managed agents were not terminated",
        );
    } finally {
      await this.unlock?.();
    }
  }
}

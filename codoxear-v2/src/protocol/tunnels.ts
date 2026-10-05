import { HttpMux } from "./http-mux.js";
import { type RequestHead, type Bytes } from "./http-frames.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  ResultFrame,
  type Operation,
  MAX_FRAME_BYTES,
} from "../contracts/tunnel.js";
import { DomainError } from "../contracts/model.js";
import {
  NotificationFrame,
  type Notification,
} from "./notifications.js";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
};
type Link = {
  http?: HttpMux;
  capabilities?: string[];
  socket: WebSocket;
  epoch: string;
  pending: Map<string, Pending>;
  alive: boolean;
  notices: Set<string>;
  heartbeat: ReturnType<typeof setInterval>;
};
export class Tunnels {
  private links = new Map<string, Link>();
  online(computerId: string): boolean {
    return this.links.get(computerId)?.socket.readyState === WebSocket.OPEN;
  }
  supports(computerId: string, capability: string): boolean {
    return (
      this.online(computerId) &&
      !!this.links.get(computerId)?.capabilities?.includes(capability)
    );
  }
  attach(
    computerId: string,
    socket: WebSocket,
    receiveNotification?: (event: Notification) => Promise<void>,
  ): void {
    this.disconnect(computerId, "Connection replaced");
    const link: Link = {
      socket,
      epoch: randomUUID(),
      pending: new Map(),
      alive: true,
      notices: new Set(),
      heartbeat: setInterval(() => {
        if (!link.alive) {
          socket.terminate();
          return;
        }
        link.alive = false;
        socket.ping();
      }, 15_000),
    };
    link.http = new HttpMux(socket, link.epoch);
    this.links.set(computerId, link);
    socket.on("pong", () => {
      link.alive = true;
    });
    socket.send(
      JSON.stringify({
        type: "welcome",
        epoch: link.epoch,
        protocol: 1,
        capabilities: receiveNotification ? ["notifications"] : [],
      }),
    );
    socket.on("message", (raw) => {
      if (raw.toString().length > MAX_FRAME_BYTES) {
        socket.close(1009, "Frame too large");
        return;
      }
      let result;
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "notification") {
          const notice = NotificationFrame.parse(frame);
          if (
            !receiveNotification ||
            notice.epoch !== link.epoch ||
            this.links.get(computerId) !== link
          )
            return;
          if (link.notices.has(notice.event.id) || link.notices.size >= 32)
            return;
          link.notices.add(notice.event.id);
          void receiveNotification(notice.event)
            .then(() => {
              if (
                this.links.get(computerId) === link &&
                socket.readyState === WebSocket.OPEN
              )
                socket.send(
                  JSON.stringify({
                    type: "notification.ack",
                    epoch: link.epoch,
                    id: notice.event.id,
                  }),
                );
            })
            .catch(() => {})
            .finally(() => link.notices.delete(notice.event.id)); // No ACK until durable acceptance; the computer retries the hint.
          return;
        }
        if (typeof frame.type === "string" && frame.type.startsWith("http."))
          return;
        if (frame.type === "hello") {
          if (
            frame.protocol !== 1 ||
            !Array.isArray(frame.capabilities) ||
            frame.capabilities.length > 32 ||
            frame.capabilities.some(
              (x: unknown) => typeof x !== "string" || x.length > 80,
            )
          ) {
            socket.close(1008, "Unsupported protocol");
            return;
          }
          link.capabilities = frame.capabilities;
          return;
        }
        result = ResultFrame.parse(frame);
      } catch {
        socket.close(1008, "Invalid frame");
        return;
      }
      if (this.links.get(computerId) !== link || result.epoch !== link.epoch)
        return;
      const p = link.pending.get(result.id);
      if (!p) return;
      clearTimeout(p.timer);
      link.pending.delete(result.id);
      if (result.ok) p.resolve(result.value);
      else
        p.reject(
          new DomainError(
            result.errorCode === "not_dispatched" ? 400 : result.errorCode === "setup_required" ? 409 : 502,
            result.errorCode
              ? result.errorCode
              : p.mutation ? "outcome_unknown" : "computer_error",
            result.error ?? "Computer operation failed",
          ),
        );
    });
    const close = () => {
      link.http?.close();
      clearInterval(link.heartbeat);
      if (this.links.get(computerId) === link) this.links.delete(computerId);
      for (const p of link.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new DomainError(
            503,
            p.mutation ? "outcome_unknown" : "computer_offline",
            p.mutation
              ? "Connection lost after dispatch; the operation may have completed. Do not resend automatically."
              : "Computer disconnected",
          ),
        );
      }
      link.pending.clear();
    };
    socket.on("close", close);
    socket.on("error", () => socket.terminate());
  }
  disconnect(computerId: string, reason = "Connection closed"): void {
    this.links.get(computerId)?.socket.close(1000, reason);
  }
  async request(computerId: string, operation: Operation): Promise<unknown> {
    const link = this.links.get(computerId);
    if (!link || link.socket.readyState !== WebSocket.OPEN)
      throw new DomainError(
        503,
        "not_dispatched",
        "Computer offline; the operation was not dispatched",
      );
    if (link.pending.size >= 32 || link.socket.bufferedAmount > MAX_FRAME_BYTES)
      throw new DomainError(
        429,
        "not_dispatched",
        "Computer busy; the operation was not dispatched",
      );
    const mutation = ![
        "messages",
        "discover",
        "launch-status",
        "workspace",
        "resume-candidates",
      ].includes(operation.op),
      id = randomUUID();
    const frame = JSON.stringify({
      type: "request",
      id,
      epoch: link.epoch,
      operation,
    });
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
      throw new DomainError(
        413,
        "not_dispatched",
        "Request exceeds tunnel limit",
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(
          new DomainError(
            504,
            mutation ? "outcome_unknown" : "timeout",
            mutation
              ? "Response timed out; check the existing agent before trying again."
              : "Computer read timed out",
          ),
        );
      }, 30_000);
      link.pending.set(id, { resolve, reject, timer, mutation });
      link.socket.send(frame, (error) => {
        if (error) {
          const p = link.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            link.pending.delete(id);
            p.reject(
              new DomainError(
                503,
                mutation ? "outcome_unknown" : "computer_offline",
                "Tunnel write failed",
              ),
            );
          }
        }
      });
    });
  }
  capabilities(computerId: string) {
    return this.links.get(computerId)?.capabilities ?? ["agents"];
  }
  http(
    computerId: string,
    head: RequestHead,
    body?: Bytes,
    signal?: AbortSignal,
  ) {
    const link = this.links.get(computerId);
    if (!link?.http || !this.online(computerId))
      throw new DomainError(503, "not_dispatched", "Computer is offline");
    if (!link.capabilities?.includes("http-streams"))
      throw new DomainError(
        409,
        "unsupported_capability",
        "Computer does not support HTTP streams",
      );
    return link.http.request(head, body, signal);
  }
  close(): void {
    for (const link of this.links.values()) link.socket.terminate();
  }
}

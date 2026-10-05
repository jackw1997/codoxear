import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { DomainError } from "../contracts/model.js";
import {
  HttpFrame,
  RequestHead,
  ResponseHead,
  type Bytes,
  type HttpRequest,
  type HttpResponse,
  CHUNK_BYTES,
  STREAM_WINDOW,
  COMPUTER_WINDOW,
  MAX_STREAMS,
  emptyBody,
} from "./http-frames.js";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
class ByteQueue implements Bytes {
  private values: Uint8Array[] = [];
  private done = false;
  private error: Error | undefined;
  private notify: (() => void) | undefined;
  bytes = 0;
  constructor(private consumed: (bytes: number) => void) {}
  push(value: Uint8Array) {
    if (this.done) throw new Error("Data after end");
    this.values.push(value);
    this.bytes += value.byteLength;
  }
  wake() {
    this.notify?.();
    this.notify = undefined;
  }
  end() {
    this.done = true;
    this.wake();
  }
  fail(error: Error) {
    this.error = error;
    this.done = true;
    const held = this.bytes;
    this.values = [];
    this.bytes = 0;
    if (held) this.consumed(held);
    this.wake();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.error) throw this.error;
      const value = this.values.shift();
      if (value) {
        this.bytes -= value.byteLength;
        this.consumed(value.byteLength);
        yield value;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}
type Direction = "request" | "response";
type Stream = {
  id: string;
  local: boolean;
  head: RequestHead;
  controller: AbortController;
  input: ByteQueue;
  incoming: Direction;
  expected: number;
  outgoing: Direction;
  credit: number;
  creditWait: ReturnType<typeof deferred<void>> | undefined;
  response: ReturnType<typeof deferred<HttpResponse>>;
  responded: boolean;
  receivedEnd: boolean;
  sentEnd: boolean;
  last: number;
  totalIncoming: number;
  cleanup?: () => void;
};
/** Bounded, credit-controlled transport. Application mutation outcomes are deliberately not retried. */
export class HttpMux {
  private streams = new Map<string, Stream>();
  private queued = 0;
  private highWater = 0;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private socket: WebSocket,
    private epoch: string,
    private handler?: (r: HttpRequest) => Promise<HttpResponse>,
    private idleMs = 60000,
    private maxBodyBytes = 256 * 1024 * 1024,
  ) {
    this.timer = setInterval(
      () => {
        for (const s of this.streams.values())
          if (Date.now() - s.last > this.idleMs)
            this.cancel(s, "Stream idle timeout");
      },
      Math.min(5000, idleMs),
    );
    socket.on("message", this.receive);
    socket.once("close", () => this.close());
  }
  metrics() {
    return {
      streams: this.streams.size,
      queuedBytes: this.queued,
      highWaterBytes: this.highWater,
    };
  }
  private frame(frame: HttpFrame): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Tunnel closed"));
    const encoded = JSON.stringify(frame);
    if (
      this.socket.bufferedAmount + Buffer.byteLength(encoded) >
      COMPUTER_WINDOW
    )
      return Promise.reject(new Error("Tunnel output budget exceeded"));
    return new Promise((resolve, reject) =>
      this.socket.send(encoded, (e) => (e ? reject(e) : resolve())),
    );
  }
  private create(id: string, head: RequestHead, local: boolean) {
    if (this.streams.size >= MAX_STREAMS)
      throw new DomainError(
        429,
        "not_dispatched",
        "Too many concurrent streams",
      );
    const s = {} as Stream;
    Object.assign(s, {
      id,
      local,
      head,
      controller: new AbortController(),
      incoming: local ? "response" : "request",
      outgoing: local ? "request" : "response",
      expected: 0,
      credit: STREAM_WINDOW,
      response: deferred<HttpResponse>(),
      responded: false,
      receivedEnd: false,
      sentEnd: false,
      last: Date.now(),
      totalIncoming: 0,
    });
    s.input = new ByteQueue((bytes) => {
      this.queued -= bytes;
      if (!this.streams.has(id) || this.closed) return;
      void this.frame({
        type: "http.credit",
        id,
        epoch: this.epoch,
        direction: s.incoming,
        bytes,
      }).catch(() => this.cancel(s, "Credit write failed"));
      this.finish(s);
    });
    this.streams.set(id, s);
    return s;
  }
  async request(
    head: RequestHead,
    body: Bytes = emptyBody,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    RequestHead.parse(head);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new DomainError(503, "not_dispatched", "Computer offline");
    if (signal?.aborted)
      throw new DomainError(499, "not_dispatched", "Request cancelled");
    const s = this.create(randomUUID(), head, true);
    if (signal) {
      const abort = () => this.cancel(s, "Client cancelled");
      signal.addEventListener("abort", abort, { once: true });
      s.cleanup = () => signal.removeEventListener("abort", abort);
    }
    try {
      await this.frame({
        type: "http.request",
        id: s.id,
        epoch: this.epoch,
        head,
      });
      void this.sendBody(s, body).catch(() =>
        this.cancel(s, "Request body failed"),
      );
    } catch {
      this.cancel(s, "Request dispatch failed");
    }
    return s.response.promise;
  }
  private async sendBody(s: Stream, body: Bytes) {
    let sequence = 0;
    for await (const data of body) {
      for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
        if (!this.streams.has(s.id)) throw new Error("Stream cancelled");
        const chunk = data.subarray(offset, offset + CHUNK_BYTES);
        while (s.credit < chunk.byteLength) {
          s.creditWait ??= deferred<void>();
          await s.creditWait.promise;
          if (!this.streams.has(s.id)) throw new Error("Stream cancelled");
        }
        s.credit -= chunk.byteLength;
        s.last = Date.now();
        await this.frame({
          type: "http.chunk",
          id: s.id,
          epoch: this.epoch,
          direction: s.outgoing,
          sequence: sequence++,
          data: Buffer.from(chunk).toString("base64"),
        });
      }
    }
    if (!this.streams.has(s.id)) return;
    await this.frame({
      type: "http.end",
      id: s.id,
      epoch: this.epoch,
      direction: s.outgoing,
      sequence,
    });
    s.sentEnd = true;
    this.finish(s);
  }
  private receive = (raw: WebSocket.RawData) => {
    let object: unknown;
    try {
      object = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (
      !object ||
      typeof object !== "object" ||
      !("type" in object) ||
      typeof object.type !== "string" ||
      !object.type.startsWith("http.")
    )
      return;
    const parsed = HttpFrame.safeParse(object);
    if (!parsed.success) {
      this.socket.close(1008, "Invalid HTTP frame");
      return;
    }
    const f = parsed.data;
    if (f.epoch !== this.epoch) return;
    try {
      if (f.type === "http.request") {
        if (!this.handler || this.streams.has(f.id))
          throw new Error("Unexpected request");
        const s = this.create(f.id, f.head, false);
        void this.respond(s).catch(() =>
          this.cancel(s, "Local response failed"),
        );
        return;
      }
      const s = this.streams.get(f.id);
      if (!s) return;
      s.last = Date.now();
      if (f.type === "http.cancel") {
        this.cancel(s, f.reason, false);
        return;
      }
      if (f.type === "http.credit") {
        if (f.direction !== s.outgoing || s.credit + f.bytes > STREAM_WINDOW)
          throw new Error("Invalid credit");
        s.credit += f.bytes;
        s.creditWait?.resolve();
        s.creditWait = undefined;
        return;
      }
      if (f.type === "http.response") {
        if (!s.local || s.responded) throw new Error("Duplicate response");
        s.responded = true;
        s.response.resolve({ ...f.head, body: s.input });
        return;
      }
      if (
        f.direction !== s.incoming ||
        f.sequence !== s.expected ||
        s.receivedEnd
      )
        throw new Error("Out-of-order body");
      if (f.type === "http.end") {
        s.receivedEnd = true;
        s.input.end();
        this.finish(s);
        return;
      }
      if (s.local && !s.responded)
        throw new Error("Body before response headers");
      const chunk = Buffer.from(f.data, "base64");
      if (
        chunk.toString("base64") !== f.data ||
        chunk.byteLength > CHUNK_BYTES ||
        s.input.bytes + chunk.byteLength > STREAM_WINDOW ||
        this.queued + chunk.byteLength > COMPUTER_WINDOW
      )
        throw new Error("Body exceeds negotiated credit");
      s.totalIncoming += chunk.byteLength;
      if (!s.local && s.totalIncoming > this.maxBodyBytes)
        throw new Error("Upload too large");
      s.expected++;
      this.queued += chunk.byteLength;
      this.highWater = Math.max(this.highWater, this.queued);
      s.input.push(chunk);
      s.input.wake();
    } catch {
      this.socket.close(1008, "HTTP stream protocol violation");
    }
  };
  private async respond(s: Stream) {
    const response = await this.handler!({
      ...s.head,
      body: s.input,
      signal: s.controller.signal,
    });
    if (!this.streams.has(s.id)) return;
    const head = ResponseHead.parse(response);
    s.responded = true;
    await this.frame({
      type: "http.response",
      id: s.id,
      epoch: this.epoch,
      head,
    });
    await this.sendBody(s, response.body);
  }
  private finish(s: Stream) {
    if (s.receivedEnd && s.sentEnd && s.input.bytes === 0) {
      this.streams.delete(s.id);
      s.cleanup?.();
    }
  }
  private cancel(s: Stream, reason: string, notify = true) {
    if (!this.streams.has(s.id)) return;
    this.streams.delete(s.id);
    s.cleanup?.();
    const mutation = !["GET", "HEAD"].includes(s.head.method),
      error = new DomainError(
        503,
        mutation ? "outcome_unknown" : "stream_interrupted",
        mutation
          ? "Operation may have completed; inspect state before retrying"
          : reason,
      );
    s.controller.abort(error);
    s.input.fail(error);
    s.creditWait?.reject(error);
    s.response.reject(error);
    if (notify && !this.closed)
      void this.frame({
        type: "http.cancel",
        id: s.id,
        epoch: this.epoch,
        reason: reason.slice(0, 200),
      }).catch(() => {});
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.socket.off("message", this.receive);
    for (const s of this.streams.values())
      this.cancel(s, "Computer connection closed", false);
  }
}

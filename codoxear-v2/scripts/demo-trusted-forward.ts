/** Transparent loopback gateway for a trusted preview cutover. Upstreams retain all authentication. */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket, type AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const forwardPorts = [19500, 19520, 19530, 19531] as const;
type ForwardPort = (typeof forwardPorts)[number];
type HubPort = 19530 | 19531;
export type TrustedForwardConfig = {
  newDir: string;
  legacyDir: string;
  legacyComputers: Array<{ id: string; hubPort: HubPort }>;
  ports?: Partial<Record<ForwardPort, number>>;
  legacyJwtKids?: Array<{ kid: string; hubPort: HubPort }>;
};

function configuration(input: TrustedForwardConfig): TrustedForwardConfig {
  if (!isAbsolute(input.newDir) || !isAbsolute(input.legacyDir))
    throw new Error("Bridge directories must be absolute");
  const seen = new Set<string>();
  for (const computer of input.legacyComputers) {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(computer.id) ||
      ![19530, 19531].includes(computer.hubPort) ||
      seen.has(computer.id)
    )
      throw new Error("Invalid legacy Computer route");
    seen.add(computer.id);
  }
  for (const [port, value] of Object.entries(input.ports ?? {})) {
    if (
      !forwardPorts.includes(Number(port) as ForwardPort) ||
      !Number.isInteger(value) ||
      value! < 0 ||
      value! > 65535
    )
      throw new Error("Invalid loopback port override");
  }
  for (const entry of input.legacyJwtKids ?? []) {
    if (
      !entry.kid ||
      entry.kid.length > 200 ||
      ![19530, 19531].includes(entry.hubPort)
    )
      throw new Error("Invalid explicit legacy signing-key route");
  }
  return structuredClone(input);
}

export function createTrustedForwarder(input: TrustedForwardConfig) {
  const config = configuration(input);
  const sockets = new Set<Socket>();
  function track(socket: Socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }
  function destination(port: ForwardPort, request: IncomingMessage) {
    let legacy = false;
    if (port === 19530 || port === 19531) {
      let segments: string[] = [];
      try {
        segments = new URL(
          request.url ?? "/",
          "http://loopback.invalid",
        ).pathname
          .split("/")
          .map(decodeURIComponent);
      } catch {
        /* Backend checks malformed paths. */
      }
      legacy = config.legacyComputers.some(
        (computer) =>
          computer.hubPort === port && segments.includes(computer.id),
      );
      // A caller-supplied public kid is only a routing hint. Never infer or grant identity here.
      const bearer = request.headers.authorization;
      if (!legacy && bearer?.startsWith("Bearer ") && bearer.length < 16384) {
        try {
          const header = bearer.slice(7).split(".")[0]!;
          if (header.length < 2048) {
            const value = JSON.parse(
              Buffer.from(header, "base64url").toString("utf8"),
            );
            legacy =
              config.legacyJwtKids?.some(
                (entry) => entry.hubPort === port && entry.kid === value.kid,
              ) ?? false;
          }
        } catch {
          /* Invalid credentials remain backend checked. */
        }
      }
    }
    return legacy
      ? join(
          config.legacyDir,
          port === 19530 ? "independent-hub-0.sock" : "independent-hub-1.sock",
        )
      : join(config.newDir, port + ".sock");
  }
  function proxy(
    port: ForwardPort,
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) {
    const upstream = httpRequest({
      socketPath: destination(port, incoming),
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
      agent: false,
    });
    let body: IncomingMessage | undefined;
    const timer = setTimeout(
      () => upstream.destroy(new Error("Upstream connection timed out")),
      10000,
    );
    upstream.once("socket", (socket) => {
      track(socket);
      socket.once("connect", () => clearTimeout(timer));
    });
    upstream.once("response", (response) => {
      clearTimeout(timer);
      body = response;
      outgoing.writeHead(
        response.statusCode ?? 502,
        response.statusMessage,
        response.headers,
      );
      response.once("error", () => outgoing.destroy());
      response.once("aborted", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.once("error", () => {
      clearTimeout(timer);
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        });
        outgoing.end("Preview upstream unavailable");
      } else outgoing.destroy();
    });
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) {
        body?.destroy();
        upstream.destroy();
      }
    });
    incoming.pipe(upstream);
  }
  const servers = new Map(
    forwardPorts.map((port) => {
      const server = createServer((request, response) =>
        proxy(port, request, response),
      );
      server.on("connection", track);
      server.on("upgrade", (request, client, head) => {
        // Net bridging preserves the backend's actual upgrade or rejection response.
        const upstream = connect(destination(port, request));
        track(upstream);
        let received = false;
        const timer = setTimeout(
          () => upstream.destroy(new Error("Upstream connection timed out")),
          10000,
        );
        upstream.once("connect", () => {
          clearTimeout(timer);
          upstream.write(
            `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((lines, value, index) => (index % 2 ? lines : lines + value + ": " + request.rawHeaders[index + 1] + "\r\n"), "")}\r\n`,
          );
          if (head.length) upstream.write(head);
          client.pipe(upstream).pipe(client);
        });
        upstream.on("data", () => {
          received = true;
        });
        upstream.once("error", () => {
          clearTimeout(timer);
          if (!received && !client.destroyed)
            client.end(
              "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
          else client.destroy();
        });
        client.once("error", () => upstream.destroy());
        client.once("close", () => {
          clearTimeout(timer);
          upstream.destroy();
        });
        upstream.once("close", () => client.destroy());
      });
      return [port, server] as const;
    }),
  );
  return {
    async listen() {
      const addresses = new Map<ForwardPort, AddressInfo>();
      try {
        for (const [port, server] of servers) {
          await new Promise<void>((done, reject) => {
            server.once("error", reject);
            server.listen(config.ports?.[port] ?? port, "127.0.0.1", () => {
              server.off("error", reject);
              done();
            });
          });
          addresses.set(port, server.address() as AddressInfo);
        }
      } catch (error) {
        for (const server of servers.values())
          if (server.listening) server.close();
        for (const socket of sockets) socket.destroy();
        throw error;
      }
      return addresses;
    },
    stopAccepting() {
      for (const server of servers.values())
        if (server.listening) server.close();
    },
    async close() {
      const closing = [...servers.values()].map(
        (server) =>
          new Promise<void>((done) => {
            if (server.listening) server.close(() => done());
            else done();
          }),
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all(closing);
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const config = JSON.parse(
    await readFile(resolve(process.argv[2] ?? ""), "utf8"),
  ) as TrustedForwardConfig;
  const gateway = createTrustedForwarder(config);
  await gateway.listen();
  console.log(
    "Trusted preview forwarder listening on configured loopback ports",
  );
  process.on("SIGTERM", () => gateway.stopAccepting());
  process.on("SIGINT", () => gateway.stopAccepting());
}

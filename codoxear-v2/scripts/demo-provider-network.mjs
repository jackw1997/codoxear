// Private Unix-socket egress for the disposable Docker demo. No request logging.
import { createServer, connect } from "node:net";
import http from "node:http";
import { lookup } from "node:dns/promises";
import { chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
const [mode, socket] = process.argv.slice(2);
if (!socket || !["host", "container"].includes(mode)) throw new Error("mode and socket required");
const pipe = (a, b) => {
  a.on("error", () => b.destroy()); b.on("error", () => a.destroy());
  a.on("close", () => b.destroy()); b.on("close", () => a.destroy());
  a.pipe(b).pipe(a);
};
if (mode === "container") {
  if (!existsSync("/.dockerenv")) throw new Error("Docker only");
  createServer(input => pipe(input, connect(socket))).listen(19590, "127.0.0.1");
} else {
  const address = async (hostname) => {
    const { address } = await lookup(hostname);
    if (/^(127\.|169\.254\.|0\.)/.test(address) || address === "::1" || /^fe80:/i.test(address)) throw new Error("Local host addresses are unavailable");
    return address;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url);
      if (url.protocol !== "http:") throw new Error("Use CONNECT for TLS");
      const ip = await address(url.hostname);
      const headers = { ...req.headers, host: url.host }; delete headers["proxy-authorization"];
      const upstream = http.request({ hostname: ip, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    } catch { res.writeHead(502); res.end(); }
  });
  server.on("connect", async (req, input, head) => {
    try {
      const url = new URL("http://" + req.url), ip = await address(url.hostname);
      const output = connect(Number(url.port || 443), ip);
      output.once("connect", () => { input.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) output.write(head); pipe(input, output); });
      output.on("error", () => input.destroy()); input.on("error", () => output.destroy());
    } catch { input.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); }
  });
  await unlink(socket).catch(e => { if (e.code !== "ENOENT") throw e; });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
}

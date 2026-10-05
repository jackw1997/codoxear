import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import WebSocket from "ws";
export async function codexRpc(
  path: string,
  method: string,
  params: Record<string, unknown>,
) {
  const socket = new WebSocket(`ws+unix://${path}:/`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error("Codex control connection timed out"));
    }, 2000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  let id = 0;
  const rpc = (name: string, payload: unknown) =>
    new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        socket.off("message", onMessage);
        reject(Error("Codex settings response timed out"));
      }, 2000);
      const onMessage = (data: WebSocket.RawData) => {
        let result: any;
        try {
          result = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (result.id !== requestId) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(result);
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({ id: requestId, method: name, params: payload }),
      );
    });
  try {
    const initialized = await rpc("initialize", {
      clientInfo: { name: "codoxear", title: "Codoxear", version: "2.0.0" },
      capabilities: { experimentalApi: true },
    });
    if (initialized.error) throw Error("Codex control initialization failed");
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    return await rpc(method, params);
  } finally {
    socket.close();
  }
}
export async function startCodexControl(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  path: string,
): Promise<ChildProcess | undefined> {
  const config: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (
      ["-c", "--config", "--enable", "--disable"].includes(args[i]!) &&
      args[i + 1]
    ) {
      config.push(args[i]!, args[++i]!);
    }
  }
  const child = spawn(
    command,
    [...config, "app-server", "--listen", `unix://${path}`],
    { cwd, env, stdio: "ignore" },
  );
  child.on("error", () => {});
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (existsSync(path)) {
      try {
        const result = await codexRpc(path, "thread/settings/update", {
          threadId: "00000000-0000-0000-0000-000000000000",
          model: "codoxear-capability-probe",
        });
        if (
          result.error?.code !== -32601 &&
          !/method not found|requires experimental/i.test(
            result.error?.message ?? "",
          )
        )
          return child;
      } catch {}
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  try {
    unlinkSync(path);
  } catch {}
  return undefined;
}

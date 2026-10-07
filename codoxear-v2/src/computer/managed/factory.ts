import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  computerPackagePaths,
  requireOarLoaderPath,
} from "../package-paths.js";
import { prepareProfile } from "./profiles.js";
import {
  ManagedSetupError,
  type ManagedFactory,
  type ManagedOpen,
  type ManagedSession,
  type ManagedRecord,
} from "./driver.js";

/** One owned process per resident session: Pi globals and OAR record buffers
 * disappear on quiescence. No detached session daemon remains after disposal. */
export class OarFactory implements ManagedFactory {
  constructor(private readonly options: { loaderPath?: string } = {}) {}
  async open(input: ManagedOpen): Promise<ManagedSession> {
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw new ManagedSetupError(
        "OAR managed sessions require Node.js 24 or newer",
      );
    if (input.permissionPolicy !== "locally-trusted")
      throw new ManagedSetupError(
        "OAR requires an explicitly configured locally-trusted permission policy; interactive approval policies are not supported",
      );
    const paths = computerPackagePaths();
    const worker = paths.entry("managed/worker");
    const loaderPath = requireOarLoaderPath(
      this.options.loaderPath ?? paths.oarLoader,
    );
    if (!existsSync(worker))
      throw new ManagedSetupError(
        "The managed runtime worker is missing from this Computer package",
      );
    const profile = await prepareProfile(input);
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=384",
        ...(paths.source ? ["--import", import.meta.resolve("tsx")] : []),
        worker,
      ],
      {
        cwd: input.cwd,
        env: profile.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let seq = 0,
      buffer = "",
      ended = false,
      closing: Promise<void> | undefined;
    const listeners = new Set<(event: ManagedRecord) => void>();
    const exitListeners = new Set<() => void>();
    const backlog: ManagedRecord[] = [];
    let backlogBytes = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid && !ended)
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            name,
          );
      } catch {}
    };
    const fail = () => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(
          Error(
            "Managed worker connection ended; delivery outcome may be unknown",
          ),
        );
      }
      pending.clear();
    };
    const exited = () => {
      ended = true;
      fail();
      for (const observer of exitListeners) observer();
      exitListeners.clear();
    };
    child.on("error", exited);
    child.on("exit", () => {
      signal("SIGKILL");
      exited();
    });
    child.stderr.resume(); // Runtime stderr may contain provider secrets; never return it to Hub/client.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
        signal("SIGKILL");
        fail();
        return;
      }
      for (
        let end = buffer.indexOf("\n");
        end >= 0;
        end = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.event) {
            if (listeners.size)
              for (const listener of listeners) listener(message.event);
            else {
              backlogBytes += Buffer.byteLength(line);
              if (backlog.length >= 1000 || backlogBytes > 2 * 1024 * 1024) {
                signal("SIGKILL");
                fail();
                return;
              }
              backlog.push(message.event);
            }
          } else {
            const item = pending.get(message.id);
            if (!item) continue;
            pending.delete(message.id);
            clearTimeout(item.timer);
            if (message.error)
              item.reject(
                message.setup
                  ? new ManagedSetupError(message.error)
                  : Error(message.error),
              );
            else item.resolve(message.value);
          }
        } catch {
          signal("SIGKILL");
          fail();
        }
      }
    });
    const rpc = (op: string, args: unknown = {}) =>
      new Promise<any>((resolve, reject) => {
        if (ended || pending.size >= 32) {
          reject(Error("Managed worker unavailable"));
          return;
        }
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Managed operation timed out; outcome may be unknown"));
          signal("SIGKILL");
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, op, args }) + "\n", (error) => {
          if (error) fail();
        });
      });
    const dispose = () =>
      (closing ??= (async () => {
        if (ended) return;
        const hard = setTimeout(() => signal("SIGKILL"), 5000);
        try {
          await rpc("dispose");
        } catch {
        } finally {
          signal("SIGTERM");
        }
        if (!ended)
          await new Promise<void>((resolve) =>
            child.once("exit", () => resolve()),
          );
        clearTimeout(hard);
        listeners.clear();
        backlog.length = 0;
      })());
    try {
      const opened = await rpc("open", {
        loaderPath,
        backend: input.backend,
        cwd: input.cwd,
        model: profile.model,
        effort: input.effort,
        resume: input.resume,
      });
      return {
        id: opened.id,
        profile: profile.profile,
        onExit(observer) {
          if (ended) observer();
          else exitListeners.add(observer);
          return () => {
            exitListeners.delete(observer);
          };
        },
        rawEvents(observer) {
          for (const record of backlog.splice(0)) observer(record);
          backlogBytes = 0;
          listeners.add(observer);
          return () => {
            listeners.delete(observer);
          };
        },
        prompt: (text, options) => rpc("prompt", { text, ...options }),
        abort: () => rpc("abort"),
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

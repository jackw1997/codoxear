import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  attach,
  RuntimeConfig,
  readAttachment,
  acquireLock,
  type Attachment,
} from "./config.js";
import { ComputerService, type ComputerStatus, type ComputerDependencies } from "./service.js";

/** Local, typed boundary shared by CLI and future desktop presenters. Secrets never appear in status. */
export function createComputerApi(home: string) {
  return {
    async attach(input: Attachment) {
      const unlock = await acquireLock(home);
      try {
        await attach(home, input);
      } finally {
        await unlock();
      }
    },
    async enroll(input: {
      enrollment: { identityUrl: string; code: string };
      runtime: Attachment["runtime"];
      nativeHome?: string;
      nativeStateHome?: string;
      workspacePath?: string;
    }) {
      RuntimeConfig.parse(input);
      const unlock = await acquireLock(home);
      try {
        if (await readAttachment(home))
          throw new Error(
            "Detach the current local attachment before enrolling again",
          );
        const url = new URL(input.enrollment.identityUrl);
        if (
          url.origin !== input.enrollment.identityUrl ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
        )
          throw new Error("Enrollment requires an exact HTTPS identity origin");
        const response = await fetch(new URL("/api/v1/pairing/redeem", url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: input.enrollment.code }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw new Error(
            "Enrollment rejected; obtain a new owner-issued pairing code",
          );
        const binding = (await response.json()) as Attachment;
        await attach(home, {
          ...binding,
          runtime: input.runtime,
          ...(input.nativeHome ? {nativeHome: input.nativeHome} : {}),
          ...(input.nativeStateHome ? {nativeStateHome: input.nativeStateHome} : {}),
          ...(input.workspacePath
            ? { workspacePath: input.workspacePath }
            : {}),
        });
      } finally {
        await unlock();
      }
    },
    async status() {
      const config = await readAttachment(home);
      const last = await readFile(join(home, "status.json"), "utf8")
        .then((x) => JSON.parse(x) as ComputerStatus)
        .catch(() => null);
      const pid = Number(
        await readFile(join(home, "service.lock"), "utf8").catch(() => ""),
      );
      let running = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          running = true;
        } catch {}
      }
      return {
        attached: !!config,
        hubId: config?.hubId,
        computerId: config?.computerId,
        runtime: config?.runtime,
        binding: config?.binding,
        running,
        lastObserved: last,
        pendingTransfer: await import("./transfer.js").then((module) => module.transferStatus(home)),
      };
    },
    async doctor() {
      const state = await this.status();
      return {
        ...state,
        issues: [
          ...(!state.attached ? ["Computer is not attached"] : []),
          ...(!state.running ? ["Computer service is not running"] : []),
          ...(state.lastObserved?.state === "blocked"
            ? [
                "Hub rejected attachment; rotate credentials or review membership",
              ]
            : []),
        ],
      };
    },
    async transfer(input: { hub: string; code: string }, transport: typeof fetch = fetch) {
      const unlock = await acquireLock(home);
      try { return await import("./transfer.js").then((module) => module.transferComputer(home, input, transport)); }
      finally { await unlock(); }
    },
    async detach() {
      const unlock = await acquireLock(home);
      try {
        await unlink(join(home, "attachment.json")).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      } finally {
        await unlock();
      }
    },
    service(onStatus?: (status: ComputerStatus) => void, dependencies?: ComputerDependencies) {
      return new ComputerService(home, onStatus, dependencies);
    },
  };
}
export type ComputerApi = ReturnType<typeof createComputerApi>;

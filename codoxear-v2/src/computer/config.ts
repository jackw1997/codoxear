import { mkdir, readFile, open, unlink } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { Id } from "../contracts/model.js";
import { atomicJson } from "../persistence/files.js";
export { atomicJson } from "../persistence/files.js";
export const RuntimeConfig = z.object({
  runtime: z.enum(["native", "fixture"]),
  workspacePath: z.string().min(1).refine(isAbsolute, "Workspace must be an absolute path").optional(),
  nativeHome: z.string().min(1).refine(isAbsolute, "Native home must be an absolute path").optional(),
  nativeStateHome: z.string().min(1).refine(isAbsolute, "Native state home must be an absolute path").optional(),
}).superRefine((config, ctx) => {
  if (config.runtime === "native" && !config.workspacePath)
    ctx.addIssue({code:"custom",message:"Native runtime requires workspacePath"});
});
export const Attachment = z.object({
  version: z.literal(1),
  hubUrl: z.url(),
  hubId: Id,
  computerId: Id,
  credential: z.string().min(32),
  binding: z.number().int().positive().optional(),
  runtime: z.enum(["native", "fixture"]),
  workspacePath: z.string().min(1).refine(isAbsolute, "Workspace must be an absolute path").optional(),
  nativeHome: z.string().min(1).refine(isAbsolute, "Native home must be an absolute path").optional(),
  nativeStateHome: z.string().min(1).refine(isAbsolute, "Native state home must be an absolute path").optional(),
});
export type Attachment = z.infer<typeof Attachment>;
export async function readAttachment(home: string): Promise<Attachment | null> {
  try {
    return Attachment.parse(
      JSON.parse(await readFile(join(home, "attachment.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function attach(home: string, input: Attachment): Promise<void> {
  RuntimeConfig.parse(input);
  const config = Attachment.parse(input),
    old = await readAttachment(home);
  if (
    old &&
    (old.hubId !== config.hubId ||
      old.computerId !== config.computerId ||
      old.hubUrl !== config.hubUrl)
  )
    throw new Error(
      "This computer already has a hub attachment. Detach explicitly before changing hubs.",
    );
  const url = new URL(config.hubUrl);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Hub URL must not contain credentials, query or fragment");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Use HTTPS for remote hubs");
  await atomicJson(join(home, "attachment.json"), config);
}
export async function acquireLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "service.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        const pid = await readFile(path, "utf8").catch(() => null);
        if (pid === String(process.pid)) await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Invalid service lock; inspect it before removing it");
      try {
        process.kill(pid, 0);
        throw new Error("Computer service is already running");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        await unlink(path);
      }
    }
  }
  throw new Error("Unable to acquire computer service lock");
}

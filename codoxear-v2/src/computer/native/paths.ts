import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
export const stateDirectory = (stateHome: string) => join(stateHome, "native");
function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw Error(
      "Native socket directory must be private and owned by the current user",
    );
  chmodSync(directory, 0o700);
}
export function ensureStateDirectory(stateHome: string): string {
  const directory = stateDirectory(stateHome);
  privateDirectory(directory);
  return directory;
}
export function socketDirectory(stateHome: string): string {
  const native = stateDirectory(stateHome),
    longest = "broker-" + "a".repeat(32) + ".codex";
  if (Buffer.byteLength(join(native, longest)) < 104) {
    privateDirectory(native);
    return native;
  }
  const hash = createHash("sha256")
      .update(resolve(stateHome))
      .digest("hex")
      .slice(0, 20),
    namespace = `codoxear-v2-${process.getuid?.() ?? "user"}`;
  let parent = join(tmpdir(), namespace);
  if (Buffer.byteLength(join(parent, hash, longest)) >= 104)
    parent = join("/tmp", namespace);
  privateDirectory(parent);
  const directory = join(parent, hash);
  privateDirectory(directory);
  return directory;
}
export const socketPath = (stateHome: string, id: string, suffix = ".sock") =>
  join(socketDirectory(stateHome), id + suffix);

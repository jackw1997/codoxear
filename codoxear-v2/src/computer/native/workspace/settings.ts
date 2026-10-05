import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const locks = new Map<string, Promise<void>>();
export async function readSettings(
  home: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await readFile(join(home, "native-settings.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export async function updateSettings(
  home: string,
  update: (previous: Record<string, unknown>) => void,
) {
  const previous = locks.get(home) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((r) => (release = r));
  locks.set(home, lock);
  await previous;
  try {
    const state = await readSettings(home);
    update(state);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const path = join(home, "native-settings.json"),
      temporary = path + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(state), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    return state;
  } finally {
    release();
    if (locks.get(home) === lock) locks.delete(home);
  }
}

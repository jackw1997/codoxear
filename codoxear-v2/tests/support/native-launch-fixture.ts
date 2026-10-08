import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { Backend } from "../../src/computer/native/types.js";

/** Fixture-only credentials and consent; the runtime never borrows a real home. */
export const faultLaunch = {
  model: "fixture",
  provider_config: { base_url: "http://127.0.0.1:19999/v1", api_key: "fixture-private-key" },
};
export async function prepareNativeLaunchFixture(home: string, backend: Backend) {
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  if (backend === "codex") {
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "config.toml"),
      `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
  } else if (backend === "cc") {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "settings.json"),
      JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
    await writeFile(join(home, ".claude", ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [faultLaunch.provider_config.api_key.slice(-20)], rejected: [] },
      bypassPermissionsModeAccepted: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    }), { mode: 0o600 });
  } else {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ quietStartup: true }), { mode: 0o600 });
  }
}
export function processIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  return {
    pid,
    startTicks: fields[19]!,
    executable: readlinkSync(`/proc/${pid}/exe`),
    command: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
  };
}
export type NativeProcessIdentity = ReturnType<typeof processIdentity>;

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
/** Isolated runtime homes never borrow credentials or config from the host. */
export function backendHomes(home: string) {
  const inherited = home === homedir();
  const codex =
    inherited && process.env.CODEX_HOME
      ? process.env.CODEX_HOME
      : join(home, ".codex");
  const pi =
    inherited && process.env.PI_CODING_AGENT_DIR
      ? process.env.PI_CODING_AGENT_DIR
      : join(home, ".pi", "agent");
  const explicitClaude =
    inherited && process.env.CLAUDE_CONFIG_DIR
      ? process.env.CLAUDE_CONFIG_DIR
      : undefined;
  const fixtureClaude =
    !existsSync(join(home, ".claude.json")) &&
    existsSync(join(home, ".claude", ".claude.json"))
      ? join(home, ".claude")
      : undefined;
  const claudeConfigDir = explicitClaude ?? fixtureClaude;
  return {
    codex,
    pi,
    claude: claudeConfigDir ?? join(home, ".claude"),
    claudeConfigDir,
    claudeConfigFile: join(claudeConfigDir ?? home, ".claude.json"),
  };
}

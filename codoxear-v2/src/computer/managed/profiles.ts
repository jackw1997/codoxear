import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  copyFile,
  access,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { computerPackagePaths } from "../package-paths.js";
import { scanLogs } from "../native/logs.js";
import { Launch } from "../../contracts/tunnel.js";
import { atomicJson } from "../../persistence/files.js";
import { backendHomes } from "../native/homes.js";
import { ManagedSetupError, type ManagedOpen } from "./driver.js";

/** Credentials are Computer-local, never part of the Hub catalogue or receipts. */
export async function prepareProfile(input: ManagedOpen) {
  if (input.profile && !/^[a-f0-9]{32}$/.test(input.profile))
    throw new ManagedSetupError("Invalid managed profile identity");
  const profile = input.profile ?? randomUUID().replaceAll("-", "");
  const directory = join(input.stateHome, "managed-profiles", profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const launch = input.profile
    ? Launch.strict().parse(
        JSON.parse(await readFile(join(directory, "launch.json"), "utf8")),
      )
    : Launch.strict().parse(input.launch ?? {});
  if (!input.profile) await atomicJson(join(directory, "launch.json"), launch);
  const homes = backendHomes(input.home);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Do not give a model process the Computer/Hub service credentials.
    if (
      value !== undefined &&
      !/^(CODOXEAR_|CODEX_WEB_|OAR_|NODE_OPTIONS$)/.test(key)
    )
      env[key] = value;
  }
  for (const [key, value] of Object.entries(launch.env_vars ?? {})) {
    if (
      /^(CODOXEAR_|CODEX_WEB_|OAR_)/.test(key) ||
      [
        "HOME",
        "CODEX_HOME",
        "PI_CODING_AGENT_DIR",
        "CLAUDE_CONFIG_DIR",
        "NODE_OPTIONS",
        "NODE_PATH",
      ].includes(key) ||
      value.includes("\0")
    )
      throw new ManagedSetupError(
        "Controller environment variables cannot be overridden",
      );
    env[key] = value;
  }
  env.HOME = input.home;
  env.CODEX_HOME = homes.codex;
  env.OAR_PI_AGENT_DIR = homes.pi;
  // OAR probes its own executable pins, while the native adapter uses *_BIN.
  if (env.CODEX_BIN) env.OAR_CODEX_BIN = env.CODEX_BIN;
  if (env.CLAUDE_BIN) env.OAR_CLAUDE_BIN = env.CLAUDE_BIN;
  if (homes.claudeConfigDir) env.CLAUDE_CONFIG_DIR = homes.claudeConfigDir;
  if (input.backend === "pi") {
    // Every managed Pi gets a private agent directory, retaining the user's
    // native provider/settings/auth configuration without editing originals.
    const agentDir = join(directory, "pi");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    for (const name of ["settings.json", "auth.json", "models.json"]) {
      const destination = join(agentDir, name);
      try {
        await access(destination);
      } catch {
        try {
          await copyFile(join(homes.pi, name), destination);
          await chmod(destination, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    if (input.resume) {
      const native = scanLogs(input.home, "pi").find(
        (log) => log.id === input.resume,
      );
      if (native) {
        const sessions = join(
          agentDir,
          "sessions",
          `--${input.cwd.replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-")}--`,
        );
        await mkdir(sessions, { recursive: true, mode: 0o700 });
        const destination = join(sessions, basename(native.path));
        try {
          await access(destination);
        } catch {
          await copyFile(native.path, destination);
          await chmod(destination, 0o600);
        }
      }
    }
    env.OAR_PI_AGENT_DIR = agentDir;
    env.PI_CODING_AGENT_DIR = agentDir;
  }
  if (input.backend === "pi" && input.delegation) {
    const agentDir = env.OAR_PI_AGENT_DIR!;
    env.CODOXEAR_DELEGATION_DESCRIPTOR = input.delegation.descriptor;
    const extensionDir = join(agentDir, "extensions");
    await mkdir(extensionDir, { recursive: true, mode: 0o700 });
    const source = computerPackagePaths().entry("delegation/pi-extension");
    if (!existsSync(source))
      throw new ManagedSetupError(
        "Pi delegation extension is missing from the Computer package",
      );
    // Keep bundled relative imports anchored at their installed location.
    // Copying a split tsup entry into the profile can orphan its shared chunks.
    await writeFile(
      join(extensionDir, "codoxear-delegation.ts"),
      `export { default } from ${JSON.stringify(source)};\n`,
      { mode: 0o600 },
    );
  }
  if (
    launch.service_tier ||
    launch.preferred_auth_method ||
    launch.command ||
    launch.worktree_branch
  )
    throw new ManagedSetupError(
      "This OAR adapter cannot honor service tier, auth-method, command, or worktree overrides yet",
    );
  let model = input.model === "default" ? undefined : input.model;
  if (
    input.backend === "pi" &&
    launch.provider_config?.base_url &&
    model?.startsWith("codoxear_private/")
  )
    model = model.slice("codoxear_private/".length);
  const provider = launch.provider_config;
  if (provider?.base_url) {
    const url = new URL(provider.base_url);
    if (
      !model ||
      launch.model_provider ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      /[\r\n\0]/.test(provider.api_key)
    )
      throw new ManagedSetupError(
        "A private provider needs a model, API key, and HTTP endpoint without embedded credentials",
      );
    if (
      input.backend !== "pi" &&
      (provider.api !== undefined || provider.image_support !== undefined)
    )
      throw new ManagedSetupError(
        "API compatibility and image support settings apply only to Pi",
      );
    if (input.backend === "pi") {
      const agentDir = join(directory, "pi");
      await mkdir(agentDir, { recursive: true, mode: 0o700 });
      env.OAR_PI_AGENT_DIR = agentDir;
      env.PI_CODING_AGENT_DIR = agentDir;
      env.CODOXEAR_PROVIDER_API_KEY = provider.api_key;
      await atomicJson(join(agentDir, "models.json"), {
        providers: {
          codoxear_private: {
            baseUrl: provider.base_url,
            apiKey: "$CODOXEAR_PROVIDER_API_KEY",
            api: provider.api ?? "openai-completions",
            models: [
              {
                id: model,
                name: model,
                reasoning: !!input.effort && input.effort !== "off",
                input: provider.image_support ? ["text", "image"] : ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
          },
        },
      });
      model = `codoxear_private/${model}`;
    } else if (input.backend === "codex") {
      const codexDir = join(directory, "codex");
      await mkdir(codexDir, { recursive: true, mode: 0o700 });
      env.CODEX_HOME = codexDir;
      env.CODOXEAR_PROVIDER_API_KEY = provider.api_key;
      const config = `model_provider = "codoxear_private"\n[model_providers.codoxear_private]\nname = "Private provider"\nbase_url = ${JSON.stringify(provider.base_url)}\nenv_key = "CODOXEAR_PROVIDER_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`;
      await writeFile(join(codexDir, "config.toml"), config, { mode: 0o600 });
    } else {
      for (const key of Object.keys(env))
        if (/^ANTHROPIC_|^CLAUDE_CODE_(OAUTH|USE_)/.test(key)) delete env[key];
      env.ANTHROPIC_BASE_URL = provider.base_url;
      env.ANTHROPIC_API_KEY = provider.api_key;
      env.ANTHROPIC_MODEL = model;
    }
  } else {
    if (
      input.backend === "pi" &&
      model &&
      launch.model_provider &&
      !model.startsWith(`${launch.model_provider}/`)
    )
      model = `${launch.model_provider}/${model}`;
    if (
      launch.model_provider &&
      input.backend !== "pi" &&
      launch.model_provider !== "openai"
    )
      throw new ManagedSetupError(
        "Named provider override is not supported by this OAR runtime; supply a private endpoint instead",
      );
    if (provider) {
      const key =
        input.backend === "cc"
          ? "ANTHROPIC_API_KEY"
          : input.backend === "codex"
            ? "OPENAI_API_KEY"
            : (
                {
                  openai: "OPENAI_API_KEY",
                  anthropic: "ANTHROPIC_API_KEY",
                  deepseek: "DEEPSEEK_API_KEY",
                  google: "GEMINI_API_KEY",
                  openrouter: "OPENROUTER_API_KEY",
                } as Record<string, string>
              )[launch.model_provider ?? ""];
      if (!key)
        throw new ManagedSetupError("An API URL is required for this provider");
      env[key] = provider.api_key;
    }
  }
  return { profile, env, model };
}

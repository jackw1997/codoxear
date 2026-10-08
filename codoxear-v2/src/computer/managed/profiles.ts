import { resolveCatalogLaunch, configuredCatalogCredentials } from "../provider-catalog.js";
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
import { readLaunchDefaults } from "../native/launch-defaults.js";
import { ManagedSetupError, type ManagedOpen } from "./driver.js";

/** Credentials are Computer-local, never part of the Hub catalogue or receipts. */
export async function prepareProfile(input: ManagedOpen) {
  if (input.profile && !/^[a-f0-9]{32}$/.test(input.profile))
    throw new ManagedSetupError("Invalid managed profile identity");
  const profile = input.profile ?? randomUUID().replaceAll("-", "");
  const directory = join(input.stateHome, "managed-profiles", profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let launch = input.profile
    ? Launch.strict().parse(
        JSON.parse(await readFile(join(directory, "launch.json"), "utf8")),
      )
    : Launch.strict().parse(input.launch ?? {});
  const resolved = await resolveCatalogLaunch(input.home, input.backend, {
    ...launch,
    model: input.model ?? launch.model,
    reasoning_effort: input.effort ?? launch.reasoning_effort,
  });
  launch = resolved.launch;
  // Bind discovered sessions to the endpoint and caller key selected at launch.
  // A later Computer configuration edit must not change their provider identity.
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
  if (launch.service_tier || launch.command || launch.worktree_branch)
    throw new ManagedSetupError(
      "This OAR adapter cannot honor service tier, command, or worktree overrides yet",
    );
  const configured =
    input.backend === "pi"
      ? undefined
      : readLaunchDefaults(input.home, input.cwd, env).backends[input.backend];
  if (
    launch.preferred_auth_method &&
    (input.backend !== "codex" ||
      launch.preferred_auth_method !== configured?.preferred_auth_method)
  )
    throw new ManagedSetupError(
      "The selected authentication method must match the Codex configuration on this Computer",
    );
  let model =
    launch.model === "default" ? undefined : (launch.model ?? input.model);
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
      const savedModels = await readFile(join(agentDir, "models.json"), "utf8")
        .then((value) => JSON.parse(value)).catch((error) => {
          if (error.code === "ENOENT") return {};
          throw error;
        });
      const previousProvider = savedModels.providers?.codoxear_private ?? {};
      await atomicJson(join(agentDir, "models.json"), {
        ...savedModels,
        providers: {
          ...savedModels.providers,
          codoxear_private: {
            ...previousProvider,
            baseUrl: provider.base_url,
            apiKey: "$CODOXEAR_PROVIDER_API_KEY",
            api: provider.api ?? "openai-completions",
            models: [
              ...(previousProvider.models ?? []).filter((entry: any) => entry.id !== model),
              {
                ...(previousProvider.models ?? []).find((entry: any) => entry.id === model),
                id: model,
                name: model,
                reasoning:
                  resolved.catalogModel?.reasoning ??
                  (!!input.effort && input.effort !== "off"),
                ...(resolved.catalogModel
                  ? {
                      thinkingLevelMap: resolved.catalogModel.thinkingLevelMap,
                      compat: resolved.catalogModel.compat,
                    }
                  : {}),
                input: provider.image_support ? ["text", "image"] : ["text"],
                cost: (previousProvider.models ?? []).find((entry: any) => entry.id === model)?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: (previousProvider.models ?? []).find((entry: any) => entry.id === model)?.contextWindow ?? 128000,
                maxTokens: (previousProvider.models ?? []).find((entry: any) => entry.id === model)?.maxTokens ?? 16384,
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
    if (input.backend === "pi" && model) {
      if (launch.model_provider) {
        if (!model.startsWith(`${launch.model_provider}/`))
          model = `${launch.model_provider}/${model}`;
      } else {
        model = await configuredPiModel(
          model,
          env.OAR_PI_AGENT_DIR!,
          input.cwd,
        );
      }
    }
    if (
      launch.model_provider &&
      input.backend !== "pi" &&
      launch.model_provider !== configured?.model_provider
    )
      throw new ManagedSetupError(
        "The selected provider must match this runtime's configuration on the Computer, or use a private endpoint",
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
  if (!input.profile) {
    const choices = readLaunchDefaults(input.home, input.cwd, env).backends[input.backend];
    const selected = launch.provider_config?.base_url ? new URL(launch.provider_config.base_url).host
      : launch.model_provider ?? (input.backend === "pi" && model ? choices.provider_choices.find((provider) => model!.startsWith(provider + "/")) : undefined) ?? choices.model_provider;
    try {
      const credentials = launch.provider_config?.base_url
        ? { base: launch.provider_config.base_url, key: launch.provider_config.api_key, api: launch.provider_config.api }
        : selected ? configuredCatalogCredentials(input.home, { backend: input.backend, provider: selected }, env) : null;
      if (credentials) await atomicJson(join(directory, "catalog-source.json"), {
        provider: selected,
        request: { backend: input.backend, base_url: credentials.base, api_key: credentials.key, api: credentials.api },
      });
    } catch { /* OAuth or built-in providers may have no HTTP caller-key catalogue. */ }
  }
  return {
    profile,
    env,
    model,
    effort: launch.provider_catalog ? launch.reasoning_effort : input.effort,
  };
}

/** OAR accepts provider/model, while native Pi settings store them separately. */
async function configuredPiModel(model: string, agentDir: string, cwd: string) {
  async function config(path: string): Promise<Record<string, any>> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid configuration");
      return value as Record<string, any>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new ManagedSetupError(
        "Cannot read Pi configuration on the Computer",
      );
    }
  }
  const settings = {
    ...(await config(join(agentDir, "settings.json"))),
    ...(await config(join(cwd, ".pi", "settings.json"))),
  };
  const provider =
    typeof settings.defaultProvider === "string"
      ? settings.defaultProvider.trim()
      : "";
  if (!model.includes("/")) {
    if (!provider)
      throw new ManagedSetupError(
        "Choose a Pi provider for this model, or configure a default provider on the Computer",
      );
    return `${provider}/${model}`;
  }
  if (!provider || model.startsWith(`${provider}/`)) return model;
  // Private providers can themselves expose model IDs containing slashes.
  const models = (await config(join(agentDir, "models.json"))).providers?.[
    provider
  ]?.models;
  const isRawModel =
    settings.defaultModel === model ||
    (Array.isArray(models) &&
      models.some(
        (item: unknown) =>
          !!item &&
          typeof item === "object" &&
          "id" in item &&
          item.id === model,
      ));
  return isRawModel ? `${provider}/${model}` : model;
}

export type Backend = "pi" | "codex" | "cc";
export type LaunchOptions = {
  resume_session_id?: string;
  model?: string;
  model_provider?: string;
  preferred_auth_method?: string;
  reasoning_effort?: string;
  service_tier?: string;
  cwd?: string;
  provider_config?: {
    base_url?: string;
    api_key: string;
    api?: "openai-completions" | "openai-responses" | "anthropic-messages";
    image_support?: boolean;
  };
  env_vars?: Record<string, string>;
  command?: string;
};
export type BackendDefaults = {
  model?: string | null;
  model_provider?: string | null;
  provider_choice?: string | null;
  provider_choices?: string[];
  model_providers?: string[];
  models?: string[];
  provider_models?: Record<string, string[]>;
  reasoning_efforts?: string[];
  reasoning_efforts_by_model?: Record<string, string[]>;
  supports_fast?: boolean;
};
export type Catalog = {
  new_session_defaults?: {
    default_backend?: Backend;
    backends?: Partial<Record<Backend, BackendDefaults>>;
  };
};
const strings = (values: unknown): string[] =>
  Array.isArray(values)
    ? [
        ...new Set(
          values.filter(
            (v): v is string => typeof v === "string" && !!v.trim(),
          ),
        ),
      ]
    : [];
export function defaultsFor(
  catalog: Catalog,
  backend: Backend,
): BackendDefaults {
  return {
    reasoning_efforts:
      backend === "pi"
        ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        : backend === "cc"
          ? ["low", "medium", "high", "xhigh", "max", "auto"]
          : ["minimal", "low", "medium", "high", "xhigh", "max"],
    ...catalog.new_session_defaults?.backends?.[backend],
  };
}
export function providersFor(defaults: BackendDefaults, backend: Backend) {
  if (backend === "cc") return ["__custom_api__"];
  return [
    ...new Set([
      ...strings(
        defaults.provider_choices ??
          defaults.model_providers ??
          Object.keys(defaults.provider_models ?? {}),
      ),
      ...(backend === "pi" ? ["deepseek"] : ["chatgpt", "openai-api"]),
      "__custom_api__",
    ]),
  ];
}
export function modelsFor(defaults: BackendDefaults, provider: string) {
  if (provider === "__custom_api__") return [];
  if (provider === "deepseek")
    return strings(defaults.provider_models?.deepseek).length
      ? strings(defaults.provider_models?.deepseek)
      : ["deepseek-v4-pro", "deepseek-flash"];
  const effectiveProvider =
    provider || defaults.provider_choice || defaults.model_provider || "";
  if (effectiveProvider && defaults.provider_models) {
    if (Object.hasOwn(defaults.provider_models, effectiveProvider))
      return strings(defaults.provider_models[effectiveProvider]);
    if (
      provider &&
      provider !== (defaults.provider_choice ?? defaults.model_provider)
    )
      return [];
  }
  return strings(defaults.models).filter((m) => m !== "default");
}
export function effortsFor(
  defaults: BackendDefaults,
  provider: string,
  model: string,
) {
  if (provider === "__custom_api__") return backendEfforts(defaults);
  const selectedProvider =
    provider || defaults.provider_choice || defaults.model_provider || "";
  const selectedModel = model || defaults.model || "";
  const map = defaults.reasoning_efforts_by_model ?? {};
  const key = selectedProvider
    ? `${selectedProvider}/${selectedModel}`
    : selectedModel;
  return strings(map[key] ?? map[selectedModel] ?? defaults.reasoning_efforts);
}
const backendEfforts = (defaults: BackendDefaults) =>
  strings(defaults.reasoning_efforts).length
    ? strings(defaults.reasoning_efforts)
    : ["low", "medium", "high"];

/** Empty selections deliberately defer to the selected Computer's CLI config. */
export function launchOptions(
  backend: Backend,
  defaults: BackendDefaults,
  input: {
    provider: string;
    model: string;
    effort: string;
    fast: boolean;
    cwd: string;
    apiUrl?: string;
    apiKey?: string;
    api?: "openai-completions" | "openai-responses" | "anthropic-messages";
    imageSupport?: boolean;
    envVars?: Record<string, string>;
    command?: string;
  },
): LaunchOptions {
  const launch: LaunchOptions = {};
  const model = input.model.trim();
  if (model) launch.model = model;
  if (input.provider === "__custom_api__") {
    let url: URL;
    try {
      url = new URL(input.apiUrl?.trim() ?? "");
    } catch {
      throw new Error("Enter a valid HTTP or HTTPS API URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(
        "Enter a valid HTTP or HTTPS API URL without embedded credentials.",
      );
    if (!input.apiKey?.trim()) throw new Error("Enter an API key.");
    if (!model) throw new Error("Enter a model ID for your provider.");
    launch.provider_config = {
      base_url: url.href.replace(/\/$/, ""),
      api_key: input.apiKey.trim(),
      ...(backend === "pi"
        ? {
            api: input.api ?? "openai-completions",
            image_support: !!input.imageSupport,
          }
        : {}),
    };
  } else if (input.provider && backend !== "cc") {
    if (input.provider === "deepseek" && !input.apiKey?.trim())
      throw new Error("Enter a DeepSeek API key.");
    if (input.apiKey?.trim())
      launch.provider_config = { api_key: input.apiKey.trim() };
    if (!providersFor(defaults, backend).includes(input.provider))
      throw new Error("Choose a provider configured on this computer.");
    if (
      backend === "pi" &&
      !model &&
      input.provider !== (defaults.provider_choice ?? defaults.model_provider)
    )
      throw new Error("Choose a model for this provider.");
    if (
      backend === "codex" &&
      ["chatgpt", "openai-api"].includes(input.provider)
    ) {
      launch.model_provider = "openai";
      launch.preferred_auth_method =
        input.provider === "chatgpt" ? "chatgpt" : "apikey";
    } else {
      launch.model_provider = input.provider;
      if (backend === "codex") launch.preferred_auth_method = "apikey";
      if (backend === "pi" && !model) {
        if (defaults.model && defaults.model !== "default")
          launch.model = defaults.model;
        else delete launch.model_provider;
      }
    }
  }
  if (backend === "pi" && !input.provider && model) {
    const provider = defaults.provider_choice || defaults.model_provider;
    if (
      provider &&
      (!model.includes("/") ||
        strings(defaults.provider_models?.[provider]).includes(model))
    )
      launch.model_provider = provider;
  }
  if (input.effort) {
    if (!effortsFor(defaults, input.provider, model).includes(input.effort))
      throw new Error("Choose a supported reasoning level for this model.");
    launch.reasoning_effort = input.effort;
  }
  if (input.fast && (backend === "cc" || backend === "codex"))
    launch.service_tier = "fast";
  if (input.cwd.trim()) launch.cwd = input.cwd.trim();
  if (input.envVars && Object.keys(input.envVars).length)
    launch.env_vars = input.envVars;
  if (backend === "cc" && input.command?.trim())
    launch.command = input.command.trim();
  return launch;
}

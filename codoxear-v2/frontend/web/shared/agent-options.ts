export type Backend = "pi" | "codex" | "cc";
export type LaunchOptions = {
  provider_catalog?: boolean;
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
  reasoning_effort?: string | null;
  reasoning_efforts?: string[];
  reasoning_efforts_for_custom_model?: string[];
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
  return catalog.new_session_defaults?.backends?.[backend] ?? {};
}
export function providersFor(defaults: BackendDefaults, _backend: Backend) {
  return [
    ...new Set([
      ...strings(defaults.provider_choices),
      ...strings(defaults.model_providers),
      ...Object.keys(defaults.provider_models ?? {}),
      ...strings([defaults.provider_choice ?? defaults.model_provider]),
      "__custom_api__",
    ]),
  ].filter((provider) => provider !== "default");
}
export function modelsFor(defaults: BackendDefaults, provider: string) {
  if (!provider || provider === "__custom_api__") return [];
  const configuredProvider =
    defaults.provider_choice ?? defaults.model_provider;
  const scoped = defaults.provider_models?.[provider];
  if (scoped || defaults.provider_models)
    return strings([
      ...strings(scoped),
      ...(provider === configuredProvider ? [defaults.model] : []),
    ]).filter((model) => model !== "default");
  if (provider !== configuredProvider) return [];
  return strings([...strings(defaults.models), defaults.model]).filter(
    (model) => model !== "default",
  );
}
export function effortsFor(
  defaults: BackendDefaults,
  provider: string,
  model: string,
) {
  if (provider === "__custom_api__")
    return strings(defaults.reasoning_efforts_for_custom_model ?? defaults.reasoning_efforts);
  const selectedProvider =
    provider || defaults.provider_choice || defaults.model_provider || "";
  const selectedModel = model || defaults.model || "";
  const map = defaults.reasoning_efforts_by_model ?? {};
  const key = selectedProvider
    ? `${selectedProvider}/${selectedModel}`
    : selectedModel;
  return strings(map[key] ?? map[selectedModel] ?? defaults.reasoning_efforts);
}
/** Launch values are exactly the values selected in the form. */
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
  if (!input.provider) throw new Error("Choose a provider.");
  if (!model || model === "default") throw new Error("Choose a model.");
  launch.model = model;
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
  } else {
    if (input.apiKey?.trim())
      launch.provider_config = { api_key: input.apiKey.trim() };
    if (!providersFor(defaults, backend).includes(input.provider))
      throw new Error("Choose a provider configured on this computer.");
    if (
      backend === "codex" &&
      ["chatgpt", "openai-api"].includes(input.provider)
    ) {
      launch.model_provider = "openai";
      launch.preferred_auth_method =
        input.provider === "chatgpt" ? "chatgpt" : "apikey";
    } else {
      launch.model_provider = input.provider;
    }
  }
  const supportedEfforts = effortsFor(defaults, input.provider, model);
  if (supportedEfforts.length && !input.effort)
    throw new Error("Choose a reasoning level for this model.");
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

export type ProviderCatalogRequest = { backend: Backend; provider: string } | { backend: Backend; base_url: string; api_key: string; api?: "openai-completions" | "openai-responses" | "anthropic-messages" };
export type ProviderModel = { id: string; supports_reasoning: boolean | null; supported_reasoning_efforts: string[] | null; runtime_reasoning_efforts?: string[] };
export type ProviderCatalog = { models: ProviderModel[]; metadata_available: boolean };
export function discoveredEfforts(defaults: BackendDefaults, model: ProviderModel | undefined) {
  if (model?.supports_reasoning === false) return [];
  const runtime = model?.runtime_reasoning_efforts ?? defaults.reasoning_efforts_for_custom_model;
  const advertised = model?.supported_reasoning_efforts;
  // A configured model's selected/default effort is not a runtime vocabulary
  // for another model. Advertised values stay exact requests when compatibility
  // is unproven; initialization must honor or explicitly reject the request.
  if (runtime == null) return strings(advertised);
  const supported = strings(runtime);
  return advertised == null ? supported : supported.filter(effort => advertised.includes(effort));
}

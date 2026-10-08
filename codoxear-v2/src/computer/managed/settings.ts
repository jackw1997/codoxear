import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Launch, ProviderCatalog, ProviderCatalogRequest } from "../../contracts/tunnel.js";
import { piThinkingLevels } from "../native/launch-defaults.js";
import { catalogCredential, configuredCatalogCredentials } from "../provider-catalog.js";
import { backendHomes } from "../native/homes.js";
import type { ManagedBackend } from "./driver.js";

export async function savedLaunch(stateHome: string, profile: string | null, fallback?: ReturnType<typeof Launch.parse>) {
  if (!profile) return fallback;
  if (!/^[a-f0-9]{32}$/.test(profile)) throw Error("Invalid managed profile");
  return Launch.strict().parse(JSON.parse(await readFile(join(stateHome, "managed-profiles", profile, "launch.json"), "utf8")));
}

/** Never reads a different session's provider or falls back to global defaults. */
export async function savedSettings(stateHome: string, profile: string | null, backend: ManagedBackend, model: string | null, effort: string | null, launch?: ReturnType<typeof Launch.parse>, home?: string) {
  const directory = profile ? join(stateHome, "managed-profiles", profile) : null;
  let models: Record<string, any> = {};
  if (directory && backend === "pi") {
    try { models = JSON.parse(await readFile(join(directory, "pi", "models.json"), "utf8")); } catch {}
  }
  let provider = launch?.model_provider ?? null;
  let request: ReturnType<typeof ProviderCatalogRequest.parse> | null = null;
  if (launch?.provider_config?.base_url) {
    provider = new URL(launch.provider_config.base_url).host;
    request = ProviderCatalogRequest.parse({ backend, base_url: launch.provider_config.base_url, api_key: launch.provider_config.api_key, api: launch.provider_config.api });
  } else if (backend === "pi" && directory) {
    const configured = models.providers ?? {};
    if (!provider && model) provider = Object.keys(configured).find((key) => model.startsWith(key + "/")) ?? null;
    const entry = provider ? configured[provider] : undefined;
    if (provider && entry?.baseUrl) {
      let auth: any = {};
      try { auth = JSON.parse(await readFile(join(directory, "pi", "auth.json"), "utf8")); } catch {}
      const key = entry.apiKey ?? (auth[provider]?.type === "api_key" ? auth[provider].key : undefined);
      const resolved = catalogCredential(key, { ...process.env, ...launch?.env_vars });
      if (resolved) request = ProviderCatalogRequest.parse({ backend, base_url: entry.baseUrl, api_key: resolved, api: entry.api });
    }
  }
  if (directory) {
    try {
      const source = JSON.parse(await readFile(join(directory, "catalog-source.json"), "utf8"));
      request = ProviderCatalogRequest.parse(source.request);
      if (typeof source.provider === "string") provider = source.provider;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Cannot read this session's saved provider configuration");
    }
  }
  const privateActive = backend === "pi" && !!models.providers?.codoxear_private && (model?.startsWith("codoxear_private/") || !!launch?.provider_config?.base_url);
  if (!request && privateActive && launch?.model_provider && home) {
    // Older profiles materialized a private registry but retained the explicit
    // named launch selection. Cold resume resolves this same alias. Its current
    // key may rotate, but its endpoint and API must still match the saved model.
    try {
      const originalName = launch.model_provider;
      const credentials = configuredCatalogCredentials(home, { backend, provider: originalName }, { ...process.env, ...launch.env_vars });
      const named = JSON.parse(await readFile(join(backendHomes(home).pi, "models.json"), "utf8")).providers?.[originalName];
      const saved = models.providers.codoxear_private;
      const rawModel = model?.slice("codoxear_private/".length);
      const namedModel = named?.models?.find((entry: any) => entry.id === rawModel);
      const savedModel = saved.models?.find((entry: any) => entry.id === rawModel);
      const configuredApi = namedModel?.api ?? credentials.api ?? "openai-completions";
      const savedApi = savedModel?.api ?? saved.api ?? "openai-completions";
      if (new URL(credentials.base).href.replace(/\/+$/, "") === new URL(saved.baseUrl).href.replace(/\/+$/, "") && configuredApi === savedApi)
        request = ProviderCatalogRequest.parse({ backend, base_url: saved.baseUrl, api_key: credentials.key, api: savedApi });
    } catch { /* An absent or changed explicit provider needs configuration re-entry. */ }
  }
  const activeProvider = privateActive ? "codoxear_private" : provider;
  const entries = activeProvider ? models.providers?.[activeProvider]?.models : undefined;
  const current = canonicalModel(model, launch, privateActive ? "codoxear_private" : provider);
  const known = Array.isArray(entries) ? entries : [];
  const catalog = ProviderCatalog.parse({ metadata_available: false, models: known.map((entry: any) => ({
    id: entry.id, supports_reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : null,
    supported_reasoning_efforts: null, runtime_reasoning_efforts: piThinkingLevels(entry),
  })) });
  if (current && !catalog.models.some((entry) => entry.id === current)) catalog.models.push({ id: current, supports_reasoning: null, supported_reasoning_efforts: null, ...(effort ? { runtime_reasoning_efforts: [effort] } : {}) });
  return { provider, request, catalog, model: current, provenanceRequired: privateActive && !request };
}

export function canonicalModel(model: string | null, launch?: ReturnType<typeof Launch.parse>, provider?: string | null) {
  const qualifier = launch?.provider_config?.base_url || provider === "codoxear_private" ? "codoxear_private" : launch?.model_provider ?? provider;
  if (launch?.model && (model === launch.model || model === `${qualifier}/${launch.model}`)) return launch.model;
  return qualifier && model?.startsWith(qualifier + "/") ? model.slice(qualifier.length + 1) : model;
}

export function canonicalEffort(effort: string | null, model: string | null, catalog: ReturnType<typeof ProviderCatalog.parse>) {
  const entry = catalog.models.find((entry) => entry.id === model);
  if (entry?.supports_reasoning === false) return null;
  const levels = entry?.runtime_reasoning_efforts ?? entry?.supported_reasoning_efforts;
  return effort === "off" && levels?.includes("none") && !levels.includes("off") ? "none" : effort;
}

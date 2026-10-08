import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProviderCatalogRequest,
  ProviderCatalog,
  Launch,
} from "../contracts/tunnel.js";
import { backendHomes } from "./native/homes.js";
import { tomlScalars } from "./native/launch-defaults.js";
import type { z } from "zod";
const json = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
};
function credential(
  value: unknown,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (typeof value !== "string" || !value || value.startsWith("!")) return;
  if (value.startsWith("env:")) return env[value.slice(4)];
  const ref =
    /^\$([A-Za-z_][A-Za-z0-9_]*)$|^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (ref) return env[ref[1] ?? ref[2]!];
  if (value.startsWith("$")) return;
  if (/^[A-Z_][A-Z0-9_]*$/.test(value) && env[value]) return env[value];
  return value;
}
export function configuredCatalogCredentials(
  home: string,
  input: z.infer<typeof ProviderCatalogRequest>,
  env: NodeJS.ProcessEnv = process.env,
): {
  base: string;
  key: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
} {
  if (input.base_url && input.api_key)
    return { base: input.base_url, key: input.api_key };
  const h = backendHomes(home),
    provider = input.provider!;
  let base: unknown, key: unknown, api: any;
  if (input.backend === "pi") {
    const config = json(join(h.pi, "models.json")).providers?.[provider];
    base = config?.baseUrl;
    api = config?.api;
    key = config?.apiKey;
    const auth = json(join(h.pi, "auth.json"))[provider];
    if (!key && auth?.type === "api_key") key = auth.key;
  } else if (input.backend === "codex") {
    const tables = tomlScalars(join(h.codex, "config.toml"));
    const config = tables.get("model_providers." + provider);
    base = config?.base_url;
    key = config?.env_key
      ? env[config.env_key]
      : config?.experimental_bearer_token;
  } else {
    const config = json(join(h.claude, "settings.json"));
    const merged = { ...config.env, ...env };
    base = merged.ANTHROPIC_BASE_URL;
    try {
      if (new URL(String(base)).host !== provider) throw 0;
    } catch {
      throw new Error("Configured provider discovery is unavailable");
    }
    key = merged.ANTHROPIC_AUTH_TOKEN ?? merged.ANTHROPIC_API_KEY;
  }
  const resolved = credential(key, env);
  if (typeof base !== "string" || !resolved)
    throw new Error(
      "Configured provider discovery requires an endpoint and API key",
    );
  return { base, key: resolved, ...(api ? { api } : {}) };
}
export async function providerCatalog(
  home: string,
  raw: unknown,
  fetcher: typeof fetch = fetch,
) {
  const input = ProviderCatalogRequest.parse(raw),
    { base, key } = configuredCatalogCredentials(home, input);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid provider endpoint");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid provider endpoint");
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  const get = async (path: string) => {
    const target = new URL(url);
    target.pathname = prefix + path;
    const response = await fetcher(target, {
      headers: { Authorization: "Bearer " + key },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Provider catalogue request rejected");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Invalid provider catalogue");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024)
          throw new Error("Provider catalogue exceeds response limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  let listing: any;
  try {
    listing = await get("/v1/models");
  } catch {
    throw new Error("Provider model listing unavailable");
  }
  if (!Array.isArray(listing?.data) || listing.data.length > 1000)
    throw new Error("Invalid provider model listing");
  const ids = [
    ...new Set<string>(
      listing.data
        .map((x: any) => x?.id)
        .filter(
          (x: unknown): x is string =>
            typeof x === "string" &&
            !!x &&
            x.length <= 200 &&
            !/[\r\n\0]/.test(x),
        ),
    ),
  ];
  let metadata: any;
  try {
    metadata = await get("/model_group/info");
  } catch {}
  const valid = Array.isArray(metadata?.data) && metadata.data.length <= 1000;
  const byId = new Map<string, any>();
  if (valid)
    for (const item of metadata.data)
      if (typeof item?.model_group === "string")
        byId.set(item.model_group, item);
  const api =
    input.api ??
    configuredCatalogCredentials(home, input).api ??
    "openai-completions";
  const localModels =
    input.backend === "pi" && input.provider
      ? json(join(backendHomes(home).pi, "models.json")).providers?.[
          input.provider
        ]?.models
      : undefined;
  return ProviderCatalog.parse({
    metadata_available: valid,
    models: ids.map((id) => {
      const info = byId.get(id),
        efforts = info?.supported_reasoning_efforts;
      const localModel = Array.isArray(localModels)
        ? localModels.find((item: any) => item?.id === id)
        : undefined;
      const modelApi = localModel?.api ?? api;

      return {
        id,
        ...(input.backend === "pi" &&
        typeof info?.supports_reasoning === "boolean" &&
        Array.isArray(efforts) &&
        efforts.length <= 32
          ? {
              runtime_reasoning_efforts:
                info.supports_reasoning &&
                ["openai-completions", "openai-responses"].includes(modelApi)
                  ? efforts.filter(
                      (x: unknown) =>
                        typeof x === "string" &&
                        [
                          "none",
                          "minimal",
                          "low",
                          "medium",
                          "high",
                          "xhigh",
                          "max",
                        ].includes(x),
                    )
                  : [],
            }
          : {}),
        supports_reasoning:
          typeof info?.supports_reasoning === "boolean"
            ? info.supports_reasoning
            : null,
        supported_reasoning_efforts:
          Array.isArray(efforts) &&
          efforts.length <= 32 &&
          efforts.every(
            (x: unknown) =>
              typeof x === "string" &&
              !!x &&
              x.length <= 100 &&
              !/[\r\n\0]/.test(x),
          )
            ? efforts
            : null,
      };
    }),
  });
}

export async function resolveCatalogLaunch(
  home: string,
  backend: "pi" | "codex" | "cc",
  launch: z.infer<typeof Launch>,
  fetcher: typeof fetch = fetch,
) {
  if (!launch.provider_catalog) return { launch };
  const request = ProviderCatalogRequest.parse(
    launch.provider_config?.base_url
      ? {
          backend,
          base_url: launch.provider_config.base_url,
          api_key: launch.provider_config.api_key,
          api: launch.provider_config.api,
        }
      : { backend, provider: launch.model_provider },
  );
  const catalogue = await providerCatalog(home, request, fetcher);
  let id = launch.model;
  if (launch.model_provider && id?.startsWith(launch.model_provider + "/"))
    id = id.slice(launch.model_provider.length + 1);
  if (id?.startsWith("codoxear_private/"))
    id = id.slice("codoxear_private/".length);
  const model = catalogue.models.find((x) => x.id === id);
  if (!model)
    throw new Error("Selected model is no longer visible to this provider key");
  const effort = launch.reasoning_effort;
  const declared = model.supported_reasoning_efforts;
  if (
    effort &&
    ((model.supports_reasoning === false && effort !== "off") ||
      (declared !== null && !declared.includes(effort)))
  )
    throw new Error(
      "Requested effort is not advertised for this provider model",
    );
  const credentials = configuredCatalogCredentials(home, request);
  const localModel =
    backend === "pi" && request.provider
      ? json(join(backendHomes(home).pi, "models.json")).providers?.[
          request.provider
        ]?.models?.find((item: any) => item?.id === id)
      : undefined;

  const api =
    launch.provider_config?.api ??
    localModel?.api ??
    credentials.api ??
    "openai-completions";
  const piRequests = [
    "off",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (
    backend === "pi" &&
    effort &&
    (!piRequests.includes(effort) ||
      (effort !== "off" &&
        !["openai-completions", "openai-responses"].includes(api)))
  )
    throw new Error("This Pi adapter cannot send the advertised effort value");
  const map: Record<string, string | null> = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"])
    map[level] =
      declared?.includes(level) || (declared === null && effort === level)
        ? level
        : null;
  if (backend === "pi" && effort === "none") map.off = "none";
  if (backend === "pi" && effort === "off" && declared?.includes("off"))
    map.off = "off";
  return {
    launch: {
      ...launch,
      model: id,
      reasoning_effort: backend === "pi" && effort === "none" ? "off" : effort,
      model_provider: undefined,
      provider_config: {
        ...launch.provider_config,
        base_url: credentials.base,
        api_key: credentials.key,
        ...(backend === "pi"
          ? {
              api:
                launch.provider_config?.api ??
                localModel?.api ??
                credentials.api ??
                "openai-completions",
            }
          : {}),
      },
    },
    catalogModel: {
      reasoning:
        model.supports_reasoning === true ||
        (model.supports_reasoning !== false && !!effort && effort !== "off"),
      thinkingLevelMap: map,
    },
  };
}

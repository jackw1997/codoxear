import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backendHomes } from "./homes.js";

type JsonObject = Record<string, any>;
export type LaunchBackendDefaults = {
  model: string | null;
  model_provider: string | null;
  provider_choice: string | null;
  preferred_auth_method: string | null;
  reasoning_effort: string | null;
  provider_choices: string[];
  models: string[];
  provider_models: Record<string, string[]>;
  reasoning_efforts: string[];
  reasoning_efforts_by_model: Record<string, string[]>;
  /** Adapter request vocabulary for a user-supplied model; not verified model support. */
  reasoning_efforts_for_custom_model?: string[];
  supports_fast: boolean;
};
const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && !/[\r\n\0]/.test(value)
    ? value.trim() : null;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
function json(path: string): JsonObject {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
}
function empty(efforts: string[], fast: boolean): LaunchBackendDefaults {
  return {
    model: null, model_provider: null, provider_choice: null,
    preferred_auth_method: null, reasoning_effort: null, provider_choices: [],
    models: [], provider_models: {}, reasoning_efforts: efforts,
    reasoning_efforts_by_model: {}, supports_fast: fast,
  };
}

/** Read only scalar configuration keys. Track tables so nested model keys can
 * never masquerade as root settings. Unsupported TOML values remain unknown. */
export function tomlScalars(path: string) {
  const tables = new Map<string, JsonObject>([["", {}]]);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return tables; }
  let table = "", multiline: string | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    if (multiline) {
      if (raw.includes(multiline)) multiline = undefined;
      continue;
    }
    let line = "", quote = "", escaped = false;
    for (const char of raw) {
      if (!quote && char === "#") break;
      line += char;
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && char === "\\") { escaped = true; continue; }
      if (quote && char === quote) quote = "";
      else if (!quote && (char === '"' || char === "'")) quote = char;
    }
    line = line.trim();
    const header = /^\[([^\[\]]+)\]$/u.exec(line);
    if (header) {
      table = header[1]!.trim().replace(/"([^"\\]*)"|'([^']*)'/gu, "$1$2");
      if (!tables.has(table)) tables.set(table, {});
      continue;
    }
    if (line.startsWith("[")) { table = "__unsupported_table__"; continue; }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (!assignment) continue;
    const value = assignment[2]!.trim();
    const delimiter = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : undefined;
    if (delimiter) {
      if (!value.slice(3).includes(delimiter)) multiline = delimiter;
      continue;
    }
    let scalar: string | boolean | undefined;
    if (value === "true" || value === "false") scalar = value === "true";
    else if (/^'[^']*'$/u.test(value)) scalar = value.slice(1, -1);
    else if (value.startsWith('"')) {
      try { const parsed: unknown = JSON.parse(value); if (typeof parsed === "string") scalar = parsed; } catch {}
    }
    if (scalar !== undefined) {
      if (!tables.has(table)) tables.set(table, {});
      tables.get(table)![assignment[1]!] = scalar;
    }
  }
  return tables;
}
function selectedModel(backend: LaunchBackendDefaults) {
  if (!backend.model) return;
  if (!backend.models.includes(backend.model)) backend.models.unshift(backend.model);
  if (backend.provider_choice) {
    const models = backend.provider_models[backend.provider_choice] ?? [];
    if (!models.includes(backend.model)) models.unshift(backend.model);
    backend.provider_models[backend.provider_choice] = models;
  }
}

/** Pi 1.x getSupportedThinkingLevels contract: base levels for a declared
 * reasoning model, explicit null exclusions, opt-in extended levels. No
 * provider/model-name inference; absent reasoning metadata stays off-only. */
export function piThinkingLevels(model: JsonObject): string[] {
  if (model.reasoning !== true) return ["off"];
  const map = object(model.thinkingLevelMap);
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter(level =>
    map[level] !== null && (!(level === "xhigh" || level === "max") || map[level] !== undefined));
}

/** Configuration identities and model capabilities only; never credentials.
 * Callers must separately check what their runtime adapter can honor. */
export function readLaunchDefaults(
  home: string,
  workspace?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const homes = backendHomes(home);
  const codex = empty([], true);
  const tables = tomlScalars(join(homes.codex, "config.toml"));
  const root = tables.get("") ?? {};
  const profile = string(root.profile);
  const config = { ...root, ...(profile ? tables.get(`profiles.${profile}`) : {}) };
  const auth = json(join(homes.codex, "auth.json"));
  const method = string(config.preferred_auth_method) ??
    (auth.auth_mode === "chatgpt" ? "chatgpt" : auth.auth_mode === "apikey" || auth.OPENAI_API_KEY ? "apikey" : null);
  codex.preferred_auth_method = method === "chatgpt" || method === "apikey" ? method : null;
  codex.model = string(config.model);
  codex.model_provider = string(config.model_provider) ?? (codex.preferred_auth_method ? "openai" : null);
  codex.reasoning_effort = string(config.model_reasoning_effort);
  if (codex.reasoning_effort) codex.reasoning_efforts.push(codex.reasoning_effort);
  codex.provider_choice = codex.model_provider === "openai" && codex.preferred_auth_method
    ? codex.preferred_auth_method === "chatgpt" ? "chatgpt" : "openai-api"
    : codex.model_provider;
  if (codex.provider_choice) codex.provider_choices.push(codex.provider_choice);
  // Codex's own cache describes its OpenAI catalogue, not a custom provider's.
  if (codex.model_provider === "openai") {
    const cache = json(join(homes.codex, "models_cache.json"));
    for (const value of Array.isArray(cache.models) ? cache.models : []) {
      const model = object(value), id = string(model.slug);
      if (!id || model.visibility === "hide") continue;
      codex.models.push(id);
      const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .flatMap((level: unknown) => string(object(level).effort) ?? []);
      if (efforts.length) {
        codex.reasoning_efforts.push(...efforts);
        codex.reasoning_efforts_by_model[id] = efforts;
        if (codex.provider_choice) codex.reasoning_efforts_by_model[`${codex.provider_choice}/${id}`] = efforts;
      }
    }
    codex.models = [...new Set(codex.models)];
    if (codex.provider_choice) codex.provider_models[codex.provider_choice] = [...codex.models];
  }
  selectedModel(codex);
  codex.reasoning_efforts = [...new Set(codex.reasoning_efforts)];

  const pi = empty([], false);
  pi.reasoning_efforts_for_custom_model = piThinkingLevels({ reasoning: true });
  const settings = {
    ...json(join(homes.pi, "settings.json")),
    ...(workspace ? json(join(workspace, ".pi", "settings.json")) : {}),
  };
  pi.model = string(settings.defaultModel);
  pi.model_provider = pi.provider_choice = string(settings.defaultProvider);
  pi.reasoning_effort = string(object(settings.modelThinkingLevels)[`${pi.model_provider}/${pi.model}`]) ?? string(settings.defaultThinkingLevel);
  if (pi.reasoning_effort) pi.reasoning_efforts.push(pi.reasoning_effort);
  for (const [provider, value] of Object.entries(object(json(join(homes.pi, "models.json")).providers))) {
    if (!string(provider)) continue;
    const config = object(value);
    const models = Array.isArray(config.models) ? config.models : [];
    pi.provider_choices.push(provider);
    pi.provider_models[provider] = [];
    for (const value of models) {
      const model = object(value), id = string(model.id);
      if (!id) continue;
      if (!pi.provider_models[provider]!.includes(id)) pi.provider_models[provider]!.push(id);
      pi.reasoning_efforts_by_model[`${provider}/${id}`] = piThinkingLevels(model);
      pi.reasoning_efforts.push(...pi.reasoning_efforts_by_model[`${provider}/${id}`]!);
    }
  }
  for (const [provider, auth] of Object.entries(json(join(homes.pi, "auth.json")))) {
    if (string(provider) && ["api_key", "oauth"].includes(object(auth).type) && !pi.provider_choices.includes(provider))
      pi.provider_choices.push(provider);
  }
  if (pi.provider_choice && !pi.provider_choices.includes(pi.provider_choice)) pi.provider_choices.unshift(pi.provider_choice);
  selectedModel(pi);
  pi.reasoning_efforts = [...new Set(pi.reasoning_efforts)];

  const cc = empty([], true);
  const sources = [
    json(join(homes.claude, "settings.json")),
    ...(workspace ? [json(join(workspace, ".claude", "settings.json")), json(join(workspace, ".claude", "settings.local.json"))] : []),
  ];
  const claude = Object.assign({}, ...sources);
  const env = Object.assign({}, ...sources.map(source => object(source.env)), environment);
  cc.model = string(env.ANTHROPIC_MODEL) ?? string(claude.model);
  cc.reasoning_effort = string(env.CLAUDE_CODE_EFFORT_LEVEL) ?? string(claude.effortLevel);
  if (cc.reasoning_effort) cc.reasoning_efforts.push(cc.reasoning_effort);
  const enabled = (value: unknown) => value === "1" || value === "true";
  let provider: string | null = null;
  if (enabled(env.CLAUDE_CODE_USE_BEDROCK)) provider = "bedrock";
  else if (enabled(env.CLAUDE_CODE_USE_VERTEX)) provider = "vertex";
  else if (enabled(env.CLAUDE_CODE_USE_FOUNDRY)) provider = "foundry";
  else if (string(env.ANTHROPIC_BASE_URL)) {
    try {
      const url = new URL(env.ANTHROPIC_BASE_URL);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
        provider = url.host;
    } catch {}
  } else if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN ||
    json(homes.claudeConfigFile).oauthAccount || json(join(homes.claude, ".credentials.json")).claudeAiOauth)
    provider = "anthropic";
  cc.model_provider = cc.provider_choice = provider;
  if (provider) cc.provider_choices.push(provider);
  selectedModel(cc);
  return { provider_launch: true, backends: { codex, pi, cc } };
}

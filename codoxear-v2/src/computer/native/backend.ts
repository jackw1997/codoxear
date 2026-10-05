import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../../contracts/model.js";
import { backendHomes } from "./homes.js";
import { stateDirectory } from "./paths.js";
import type { BrokerLaunch } from "./types.js";
const reserved = new Set([
  "HOME",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_BIN",
  "PI_BIN",
  "CLAUDE_BIN",
]);
export function backendCommand(input: BrokerLaunch, preflight = true) {
  const { backend, launch, cwd, home } = input;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  env.HOME = home;
  env.TERM = "xterm-256color";
  env.COLUMNS = "120";
  env.LINES = "40";
  const homes = backendHomes(home);
  env.CODEX_HOME = homes.codex;
  env.PI_CODING_AGENT_DIR = homes.pi;
  if (homes.claudeConfigDir) env.CLAUDE_CONFIG_DIR = homes.claudeConfigDir;
  else delete env.CLAUDE_CONFIG_DIR;
  for (const [key, value] of Object.entries(launch.env_vars ?? {})) {
    if (
      reserved.has(key) ||
      /^(CODEX_WEB_|CODOXEAR_)/.test(key) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      value.includes("\0")
    )
      throw new DomainError(
        400,
        "not_dispatched",
        "Controller environment variables cannot be overridden",
      );
    env[key] = value;
  }
  if (launch.command && backend !== "cc")
    throw new DomainError(
      400,
      "not_dispatched",
      "Command override is only supported for Claude Code",
    );
  const command =
    launch.command ??
    (backend === "cc"
      ? (process.env.CLAUDE_BIN ?? "claude")
      : backend === "pi"
        ? (process.env.PI_BIN ?? "pi")
        : (process.env.CODEX_BIN ?? "codex"));
  if (/[\r\n\0]/.test(command))
    throw new DomainError(
      400,
      "not_dispatched",
      "Enter an executable name or path",
    );
  const args: string[] =
    backend === "codex"
      ? [
          "--no-alt-screen",
          "--dangerously-bypass-approvals-and-sandbox",
          "-C",
          cwd,
          "-c",
          "disable_paste_burst=true",
        ]
      : backend === "cc"
        ? ["--dangerously-skip-permissions"]
        : [];
  if (backend === "cc" && !launch.resume_session_id) {
    const hex = input.sessionId.replace(/^broker-/, "");
    if (/^[a-f0-9]{32}$/.test(hex))
      args.push(
        "--session-id",
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      );
  }
  if (launch.model && launch.model !== "default")
    args.push(backend === "pi" ? "--model" : "--model", launch.model);
  if (launch.model_provider) {
    if (backend === "cc")
      throw new DomainError(
        400,
        "not_dispatched",
        "Claude Code does not support model_provider",
      );
    if (backend === "pi") args.push("--provider", launch.model_provider);
    else
      args.push(
        "-c",
        `model_provider=${JSON.stringify(launch.model_provider)}`,
      );
  }
  if (launch.reasoning_effort) {
    if (backend === "pi") args.push("--thinking", launch.reasoning_effort);
    else if (backend === "cc") args.push("--effort", launch.reasoning_effort);
    else
      args.push(
        "-c",
        `model_reasoning_effort=${JSON.stringify(launch.reasoning_effort)}`,
      );
  }
  if (launch.service_tier === "fast") {
    if (backend === "codex") args.push("-c", 'service_tier="fast"');
  }
  if (launch.preferred_auth_method && backend === "codex")
    args.push(
      "-c",
      `preferred_auth_method=${JSON.stringify(launch.preferred_auth_method)}`,
    );
  if (backend === "pi") {
    const directory = dirname(fileURLToPath(import.meta.url));
    const bridge = [
      join(directory, "pi-active-session-bridge.ts"),
      join(directory, "pi-active-session-bridge.js"),
      join(directory, "computer/native/pi-active-session-bridge.js"),
    ].find(existsSync);
    if (!bridge)
      throw new DomainError(
        400,
        "not_dispatched",
        "Pi control bridge is missing from the Computer package",
      );
    args.push("--extension", bridge);
    env.CODOXEAR_NATIVE_PI_MARKER = join(
      stateDirectory(input.storageHome ?? home),
      input.sessionId + ".pi",
    );
  }
  const provider = launch.provider_config;
  if (provider) {
    if (!provider.api_key.trim() || /[\r\n\0]/.test(provider.api_key))
      throw new DomainError(400, "not_dispatched", "Enter a valid API key");
    if (provider.base_url) {
      const url = new URL(provider.base_url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        !launch.model ||
        launch.model === "default" ||
        launch.model_provider
      )
        throw new DomainError(
          400,
          "not_dispatched",
          "Custom API requires a model and HTTP endpoint without embedded credentials",
        );
      if (
        backend !== "pi" &&
        (provider.api !== undefined || provider.image_support !== undefined)
      )
        throw new DomainError(
          400,
          "not_dispatched",
          "API compatibility and image support are supported only by Pi",
        );
      if (backend === "cc") {
        for (const key of Object.keys(env))
          if (
            /^ANTHROPIC_|^CLAUDE_CODE_(OAUTH|USE_)/.test(key) &&
            !Object.hasOwn(launch.env_vars ?? {}, key)
          )
            delete env[key];
        env.ANTHROPIC_BASE_URL = provider.base_url.replace(/\/$/, "");
        env.ANTHROPIC_API_KEY = provider.api_key;
        env.ANTHROPIC_CUSTOM_MODEL_OPTION = launch.model;
        args.push("--setting-sources", "project,local");
      } else if (backend === "codex") {
        env.CODOXEAR_PROVIDER_API_KEY = provider.api_key;
        for (const [key, value] of Object.entries({
          model_provider: "codoxear_private",
          "model_providers.codoxear_private.name": "Private provider",
          "model_providers.codoxear_private.base_url":
            provider.base_url.replace(/\/$/, ""),
          "model_providers.codoxear_private.env_key":
            "CODOXEAR_PROVIDER_API_KEY",
          "model_providers.codoxear_private.wire_api": "responses",
          "model_providers.codoxear_private.requires_openai_auth": false,
          "model_providers.codoxear_private.supports_websockets": false,
        }))
          args.push("-c", `${key}=${JSON.stringify(value)}`);
      } else {
        env.CODOXEAR_PROVIDER_API_KEY = provider.api_key;
        env.CODOXEAR_PROVIDER_URL = provider.base_url;
        env.CODOXEAR_PROVIDER_MODEL = launch.model;
        env.CODOXEAR_PROVIDER_API = provider.api ?? "openai-completions";
        env.CODOXEAR_PROVIDER_REASONING =
          launch.reasoning_effort && launch.reasoning_effort !== "off"
            ? "1"
            : "0";
        env.CODOXEAR_PROVIDER_IMAGES = provider.image_support ? "1" : "0";
        const directory = dirname(fileURLToPath(import.meta.url));
        const extension = [
          join(directory, "pi-private-provider.ts"),
          join(directory, "pi-private-provider.js"),
          join(directory, "computer/native/pi-private-provider.js"),
        ].find(existsSync);
        if (!extension)
          throw new DomainError(
            400,
            "not_dispatched",
            "Private Pi provider extension is missing from the Computer package",
          );
        args.push("--extension", extension, "--provider", "codoxear_private");
      }
    } else {
      const key =
        backend === "codex" && launch.model_provider === "openai"
          ? "OPENAI_API_KEY"
          : backend === "pi"
            ? (
                {
                  deepseek: "DEEPSEEK_API_KEY",
                  openai: "OPENAI_API_KEY",
                  anthropic: "ANTHROPIC_API_KEY",
                  google: "GEMINI_API_KEY",
                  openrouter: "OPENROUTER_API_KEY",
                } as Record<string, string>
              )[launch.model_provider ?? ""]
            : undefined;
      if (!key)
        throw new DomainError(
          400,
          "not_dispatched",
          "An API URL is required for this provider",
        );
      env[key] = provider.api_key;
    }
  }
  if (launch.resume_session_id)
    args.push(
      ...(backend === "codex"
        ? ["resume", launch.resume_session_id]
        : backend === "cc"
          ? ["--resume", launch.resume_session_id]
          : ["--session", input.resumePath ?? launch.resume_session_id]),
    );
  if (backend === "cc") {
    // Current Claude migrates its accepted permissions disclaimer from
    // .claude.json into settings.json. Custom providers exclude user settings,
    // so carry that existing consent alone into the launch settings.
    const savedConsent = claudePermissionConsent(env, cwd);
    if (savedConsent || launch.service_tier === "fast")
      args.push(
        "--settings",
        JSON.stringify({
          ...(savedConsent ? { skipDangerousModePermissionPrompt: true } : {}),
          ...(launch.service_tier === "fast" ? { fastMode: true } : {}),
        }),
      );
    if (preflight) requireClaudeSetup(env, cwd, args);
  }
  return { command, args, env };
}
function claudePermissionConsent(env: Record<string, string>, cwd: string) {
  let consent: unknown;
  for (const path of [
    join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME!, ".claude"), "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]) {
    try {
      const settings = JSON.parse(readFileSync(path, "utf8"));
      if (Object.hasOwn(settings, "skipDangerousModePermissionPrompt"))
        consent = settings.skipDangerousModePermissionPrompt;
    } catch {}
  }
  return consent === true;
}
export function requireClaudeSetup(
  env: Record<string, string>,
  cwd: string,
  args: string[],
) {
  let config: any = {};
  try {
    config = JSON.parse(
      readFileSync(
        join(env.CLAUDE_CONFIG_DIR ?? env.HOME!, ".claude.json"),
        "utf8",
      ),
    );
  } catch {}
  if (
    !config.hasCompletedOnboarding &&
    existsSync(join(env.HOME!, ".claude.json"))
  )
    try {
      config = JSON.parse(
        readFileSync(join(env.HOME!, ".claude.json"), "utf8"),
      );
    } catch {}
  const fail = (reason: string) => {
    throw new DomainError(
      400,
      "not_dispatched",
      `Claude Code setup required: open Claude in a terminal on this Computer with the same configuration and workspace, ${reason}, then create the agent again. No prompt was sent.`,
    );
  };
  if (config.hasCompletedOnboarding !== true)
    fail("finish onboarding and authentication");
  let parent = cwd,
    trusted = false;
  while (true) {
    if (config.projects?.[parent]?.hasTrustDialogAccepted === true)
      trusted = true;
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (!trusted) fail("review its workspace trust dialog");
  const key = env.ANTHROPIC_API_KEY;
  if (key && !config.customApiKeyResponses?.approved?.includes(key.slice(-20)))
    fail("review its API key confirmation");
  if (
    args.includes("--dangerously-skip-permissions") &&
    config.bypassPermissionsModeAccepted !== true &&
    !claudePermissionConsent(env, cwd)
  )
    fail("review its permissions-mode confirmation");
}
export function stripTerminal(text: string) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ");
}
export function startupState(
  backend: string,
  text: string,
): { ready: boolean; message?: string } {
  const compact = stripTerminal(text).replace(/\s+/g, "").toLowerCase();
  if (backend === "cc") {
    if (
      compact.includes("shift+tabtocycle") ||
      compact.includes("?forshortcuts")
    )
      return { ready: true };
    if (
      /welcometoclaudecode|yes,itrustthisfolder|usethisapikey|yes,iaccept|choosethetextstyle/.test(
        compact,
      )
    )
      return {
        ready: false,
        message:
          "Claude Code setup required: review onboarding, authentication, workspace trust and provider confirmations in a local terminal. Your prompt was not sent.",
      };
  } else if (backend === "codex") {
    if (
      /\x1b\[(?:1;1H|2?J)/.test(text) &&
      compact.includes("folderaccess") &&
      compact.includes("trustthisfolder?") &&
      compact.includes("trustandcontinue") &&
      compact.includes("quit")
    )
      return {
        ready: false,
        message:
          "Codex setup required: review workspace trust in a local terminal on this Computer. Your prompt was not sent.",
      };
    if (compact.includes("resumingsession")) return { ready: false };
    const editorFooter =
      /(?:default|minimal|low|medium|high|xhigh|max|none|ultra)·/.test(compact);
    if (
      compact.includes("contextleft") ||
      (compact.includes("askcodextodoanything") &&
        compact.includes("permissions:yolomode") &&
        editorFooter) ||
      (compact.includes("?forshortcuts") &&
        !compact.includes("resumingsession"))
    )
      return { ready: true };
  } else if (
    /esc.*interrupt|ctrl\+c|pi.*v\d|context|tokens/.test(
      stripTerminal(text).toLowerCase(),
    )
  )
    return { ready: true };
  return { ready: false };
}

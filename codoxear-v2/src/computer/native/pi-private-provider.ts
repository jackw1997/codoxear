/** Per-launch private provider. No credential or global configuration writes. */
export default function (pi: {
  registerProvider: (name: string, config: unknown) => void;
}) {
  const env = process.env;
  const model = env.CODOXEAR_PROVIDER_MODEL;
  const endpoint = env.CODOXEAR_PROVIDER_URL;
  if (!model || !endpoint || !env.CODOXEAR_PROVIDER_API_KEY)
    throw new Error("Private provider configuration is incomplete");
  pi.registerProvider("codoxear_private", {
    baseUrl: endpoint,
    apiKey: "$CODOXEAR_PROVIDER_API_KEY",
    api: env.CODOXEAR_PROVIDER_API ?? "openai-completions",
    models: [
      {
        id: model,
        name: model,
        reasoning: env.CODOXEAR_PROVIDER_REASONING === "1",
        ...(env.CODOXEAR_PROVIDER_THINKING_MAP
          ? {
              thinkingLevelMap: JSON.parse(env.CODOXEAR_PROVIDER_THINKING_MAP),
              compat: JSON.parse(
                env.CODOXEAR_PROVIDER_COMPAT ??
                  '{"supportsReasoningEffort":true}',
              ),
            }
          : {}),
        input:
          env.CODOXEAR_PROVIDER_IMAGES === "1" ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
}

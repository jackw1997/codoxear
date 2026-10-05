import { DomainError } from "../contracts/model.js";
export class AuthorityClient {
  constructor(
    readonly origin: string,
    readonly hubId: string,
    private credential: string,
    private transport: typeof fetch = fetch,
  ) {}
  async request<T>(path: string, body: unknown, token?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codoxear-Hub": this.hubId,
          "X-Hub-Credential": this.credential,
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DomainError(
        503,
        "policy_unavailable",
        "Identity policy service is unavailable; remote access is paused",
      );
    }
    const value = (await response.json()) as { code?: string; error?: string };
    if (!response.ok)
      throw new DomainError(
        response.status,
        value.code ?? "policy_denied",
        value.error ?? "Authority rejected request",
      );
    return value as T;
  }
  call<T>(token: string, op: string, args: Record<string, unknown> = {}) {
    return this.request<T>("/internal/call", { op, args }, token);
  }
  device(computerId: string, credential: string) {
    return this.request<{ hubId: string; computerId: string; binding: number }>(
      "/internal/device",
      { hubId: this.hubId, computerId, credential },
    );
  }
  agentResult(agentId: string, state: string, localId: string | null) {
    return this.request("/internal/agent-result", {
      hubId: this.hubId,
      agentId,
      state,
      localId,
    });
  }
}

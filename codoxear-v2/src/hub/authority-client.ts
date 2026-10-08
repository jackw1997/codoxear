import { DomainError } from "../contracts/model.js";
import type { Agent } from "../contracts/model.js";
import type {
  DelegationAuthorization,
  DelegationContext,
  DelegationSpawn,
  DelegationGrant,
  DelegationParentContext,
} from "../contracts/delegation.js";
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
  delegationContext(token: string, parentId: string, targetComputerId: string) {
    return this.call<DelegationContext>(token, "delegation-context", {
      parentId,
      targetComputerId,
    });
  }
  delegationParent(token: string, parentId: string) {
    return this.call<DelegationParentContext>(token, "delegation-parent", {
      parentId,
    });
  }
  childDelegationContext(
    grant: DelegationGrant,
    childId: string,
    targetComputerId: string,
  ) {
    return this.request<DelegationContext>(
      "/internal/delegation-child-context",
      {
        hubId: this.hubId,
        actorId: grant.actorId,
        identitySessionId: grant.identitySessionId,
        parentId: grant.parentId,
        sourceComputerId: grant.sourceComputerId,
        sourceBinding: grant.sourceBinding,
        childId,
        targetComputerId,
      },
    );
  }
  authorizeDelegation(input: DelegationAuthorization) {
    return this.request<DelegationContext>("/internal/delegation-authorize", {
      hubId: this.hubId,
      ...input,
    });
  }
  reserveDelegation(
    input: DelegationAuthorization,
    args: DelegationSpawn & { agentId: string },
  ) {
    return this.request<Agent>("/internal/delegation-reserve", {
      hubId: this.hubId,
      ...input,
      agentId: args.agentId,
      name: args.name,
      backend: args.backend,
      ...(args.launch ? { launch: args.launch } : {}),
    });
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

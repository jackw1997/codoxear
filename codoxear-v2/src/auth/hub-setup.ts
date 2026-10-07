import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../persistence/store.js";
import type { IdentitySession } from "../contracts/identity.js";
import { DomainError, requireValue, type State } from "../contracts/model.js";
import { audit, createHub, digest, id } from "../domain/commands.js";
import { checkHubOrganization } from "./hub-organization.js";

export const HubInitialization = z.object({
  token: z.string().min(32).max(256), expiresAt: z.number().int().positive(),
}).strict();
export type HubInitialization = z.infer<typeof HubInitialization>;
const pendingEmail = (hubId: string) => `${hubId}@setup.invalid`;
const pendingInState = (state: State, hubId: string) => {
  const hub = requireValue(state.hubs.find((hub) => hub.id === hubId));
  return state.users.some((user) => user.id === hub.ownerId && user.disabled && user.email === pendingEmail(hubId));
};

/** Reserve deployment-owned resources until an authorized initialization login. */
export function initializeHub(state: State, hubId: string, name: string) {
  if (state.hubs.length) throw new Error("Hub initialization requires an empty catalog");
  const ownerId = id();
  state.users.push({ id: ownerId, name: "Awaiting Hub initialization", email: pendingEmail(hubId), passwordHash: "", disabled: false });
  const hub = createHub(state, ownerId, name);
  hub.id = hubId;
  requireValue(state.users.find((user) => user.id === ownerId)).disabled = true;
  return hub;
}

/** The private token enters only through /initialize. Provider flows retain a
 * server-side reference and complete in Accounts.finish's account transaction. */
export function hubSetup(store: Store, hubId: string, initialization: HubInitialization | undefined, now = Date.now) {
  const pending = () => pendingInState(store.read(), hubId);
  if (pending() && !initialization) throw new Error("New Hub requires a private expiring initialization link");
  if (initialization) {
    const input = HubInitialization.parse(initialization);
    if (pending()) store.change((state) => {
      const existing = state.identity.initializations.find((value) => value.hubId === hubId);
      const tokenHash = digest(input.token);
      if (existing?.tokenHash === tokenHash) return;
      state.identity.initializations = state.identity.initializations.filter((value) => value.hubId !== hubId);
      state.identity.initializations.push({ id: id(), hubId, tokenHash, expiresAt: input.expiresAt, consumedAt: null });
    });
  }
  return {
    pending,
    prepare(token: string) {
      const state = store.read(), actual = Buffer.from(digest(token), "hex");
      const value = state.identity.initializations.find((value) => value.hubId === hubId);
      if (!value || value.consumedAt !== null || value.expiresAt <= now() || !pendingInState(state, hubId) ||
        !timingSafeEqual(actual, Buffer.from(value.tokenHash, "hex")))
        throw new DomainError(403, "initialization_rejected", "Initialization link is invalid, expired or already used");
      return { id: value.id, expiresAt: value.expiresAt };
    },
    complete(state: State, session: IdentitySession, initializationId: string) {
      const value = state.identity.initializations.find((value) => value.id === initializationId && value.hubId === hubId);
      if (!value || value.consumedAt !== null || value.expiresAt <= now() || !pendingInState(state, hubId))
        throw new DomainError(403, "initialization_rejected", "Initialization link is invalid, expired or already used");
      const identity = state.identity.identities.find((identity) => identity.id === session.context.identityId && identity.userId === session.userId);
      if (!identity || identity.verifiedAt <= 0 || identity.method !== session.context.method || identity.tenant !== session.context.tenant ||
        !["google", "feishu"].includes(identity.method) || session.revoked || session.expiresAt <= now() ||
        session.context.authenticatedAt > now() || now() - session.context.authenticatedAt > 300_000 ||
        !state.users.some((user) => user.id === session.userId && !user.disabled))
        throw new DomainError(403, "provider_required", "Initialization requires a fresh verified provider sign-in");
      const organization = state.identity.hubOrganizations.find((value) => value.hubId === hubId);
      if (identity.method === "feishu" && organization?.feishuConnection && !organization.feishuTenant) {
        if (!identity.tenant || identity.connection !== organization.feishuConnection)
          throw new DomainError(403, "wrong_organization", "Use this Hub's configured Feishu app");
        organization.feishuTenant = identity.tenant;
      }
      // Google may initialize this Hub even when its Feishu tenant is unbound.
      checkHubOrganization(state, hubId, identity.method, identity.tenant, identity.method === "feishu");
      const hub = requireValue(state.hubs.find((hub) => hub.id === hubId)), reservedOwnerId = hub.ownerId;
      hub.ownerId = session.userId;
      hub.revision++;
      for (const computer of state.computers)
        if (computer.hubId === hubId && computer.ownerId === reservedOwnerId) {
          computer.ownerId = session.userId;
          computer.revision++;
        }
      value.consumedAt = now();
      audit(state, session.userId, "hub.initialize", hub.id);
    },
  };
}

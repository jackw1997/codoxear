import { timingSafeEqual } from "node:crypto";
import type { Store } from "../persistence/store.js";
import type { IdentitySession } from "../contracts/identity.js";
import { DomainError, Name, requireValue, type State } from "../contracts/model.js";
import { audit, createHub, digest, id } from "../domain/commands.js";
import { checkHubOrganization } from "./hub-organization.js";

const pendingEmail = (hubId: string) => `${hubId}@setup.invalid`;

/** A reserved, disabled owner lets Computers be provisioned before interactive setup. */
export function initializeHub(state: State, hubId: string, name: string) {
  if (state.hubs.length) throw new Error("Hub initialization requires an empty catalog");
  const ownerId = id();
  state.users.push({ id: ownerId, name: "Awaiting Hub setup", email: pendingEmail(hubId), passwordHash: "", disabled: false });
  const hub = createHub(state, ownerId, name);
  hub.id = hubId;
  requireValue(state.users.find((u) => u.id === ownerId)).disabled = true;
  return hub;
}

export function hubSetup(store: Store, hubId: string, setupToken: string | undefined, now = Date.now) {
  const pending = () => {
    const state = store.read(), hub = requireValue(state.hubs.find((h) => h.id === hubId));
    return state.users.some((u) => u.id === hub.ownerId && u.disabled && u.email === pendingEmail(hubId));
  };
  if (pending() && (!setupToken || setupToken.length < 32))
    throw new Error("New Hub requires a private setupToken of at least 32 characters");
  const expected = setupToken ? Buffer.from(digest(setupToken), "hex") : null;
  return {
    pending,
    claim(session: IdentitySession, token: string, hubName?: string) {
      const name = hubName === undefined ? undefined : Name.parse(hubName);
      if (!expected || !timingSafeEqual(expected, Buffer.from(digest(token), "hex")))
        throw new DomainError(403, "setup_rejected", "Incorrect setup code");
      store.change((state) => {
        const hub = requireValue(state.hubs.find((h) => h.id === hubId));
        const reserved = requireValue(state.users.find((u) => u.id === hub.ownerId));
        if (!reserved.disabled || reserved.email !== pendingEmail(hubId))
          throw new DomainError(409, "setup_complete", "Hub setup is already complete");
        const identity = state.identity.identities.find((i) => i.id === session.context.identityId && i.userId === session.userId);
        if (!identity || identity.verifiedAt <= 0 || identity.method !== session.context.method || identity.tenant !== session.context.tenant ||
            !["google", "feishu"].includes(identity.method) || session.deviceKeyId ||
            session.context.authenticatedAt > now() || now() - session.context.authenticatedAt > 300_000 ||
            !state.users.some((u) => u.id === session.userId && !u.disabled))
          throw new DomainError(403, "provider_required", "Sign in with Google or Feishu again before setting up this Hub");
        const organization = state.identity.hubOrganizations.find((value) => value.hubId === hubId);
        if (organization?.feishuConnection && !organization.feishuTenant) {
          if (identity.method !== "feishu" || !identity.tenant || identity.connection !== organization.feishuConnection)
            throw new DomainError(403, "feishu_setup_required", "Use this Hub's Feishu app and the private setup code to bind its organization");
          organization.feishuTenant = identity.tenant;
        }
        checkHubOrganization(state, hubId, identity.method, identity.tenant, identity.method === "feishu");
        hub.ownerId = session.userId;
        if (name !== undefined) hub.name = name;
        hub.revision++;
        // These Computers were explicitly pre-provisioned for the pending owner.
        for (const computer of state.computers)
          if (computer.hubId === hubId && computer.ownerId === reserved.id) {
            computer.ownerId = session.userId;
            computer.revision++;
          }
        audit(state, session.userId, "hub.setup", hub.id);
      });
    },
  };
}

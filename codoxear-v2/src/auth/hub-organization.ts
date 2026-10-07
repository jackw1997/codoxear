import { DomainError, requireValue, type State } from "../contracts/model.js";
import type { Store } from "../persistence/store.js";
import type { Provider } from "./providers.js";

/** Only an independent Hub records this policy. Shared-authority compatibility
 * keeps its existing per-Hub authentication rules and account boundaries. */
export function configureHubOrganization(store: Store, hubId: string, providers: Provider[]) {
  const feishu = providers.filter((provider) => provider.method === "feishu");
  if (feishu.length > 1) throw new Error("A Hub supports at most one Feishu app");
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
    throw new Error("Provider connection IDs must be unique");
  const selected = feishu[0];
  store.change((state) => {
    const hub = requireValue(state.hubs.find((hub) => hub.id === hubId));
    let organization = state.identity.hubOrganizations.find((value) => value.hubId === hubId);
    if (!organization) {
      const configuredMethods = [...new Set(providers.map((provider) => provider.method))].sort();
      organization = { hubId, feishuConnection: null, feishuTenant: null,
        allowedMethods: configuredMethods.length ? configuredMethods : null };
      state.identity.hubOrganizations.push(organization);
    }
    if (organization.allowedMethods === null && providers.length)
      organization.allowedMethods = [...new Set(providers.map((provider) => provider.method))].sort();
    if (selected?.tenant && organization.feishuTenant && organization.feishuTenant !== selected.tenant)
      throw new Error("A Hub's bound Feishu organization cannot be changed; create a separate Hub");
    if (selected?.tenant) organization.feishuTenant = selected.tenant;
    organization.feishuConnection = selected?.id ?? null;
    const pending = state.users.some((user) => user.id === hub.ownerId && user.disabled && user.email === `${hubId}@setup.invalid`);
    if (selected && !organization.feishuTenant && !pending)
      throw new Error("Configure the Feishu tenant before enabling it on an already configured Hub");
  });
}
export function hubLoginMethods(store: Store, hubId: string | undefined, providers: Provider[]) {
  const availableMethods = [...new Set(providers.map((provider) => provider.method))].sort();
  const organization = store.read().identity.hubOrganizations.find((value) => value.hubId === hubId);
  return { availableMethods, allowedMethods: organization?.allowedMethods ?? availableMethods };
}
export function checkHubLoginMethod(state: State, hubId: string, method: string) {
  const organization = state.identity.hubOrganizations.find((value) => value.hubId === hubId);
  if (organization?.allowedMethods && !organization.allowedMethods.includes(method))
    throw new DomainError(403, "login_method_not_allowed", "This account type is not allowed on this Hub");
}
export function checkHubOrganization(state: State, hubId: string, method: string, tenant: string | null, requireBound = false) {
  checkHubLoginMethod(state, hubId, method);
  const organization = state.identity.hubOrganizations.find((value) => value.hubId === hubId);
  if (method === "feishu" && organization && (!tenant ||
    (organization.feishuTenant !== null && organization.feishuTenant !== tenant) ||
    (requireBound && organization.feishuTenant === null)))
    throw new DomainError(403, "wrong_organization", "Sign in to the Feishu organization configured for this Hub");
}

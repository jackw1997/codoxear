import { canonicalOrigin } from "../../shared/context.js";
export type PublicHub = { name: string; origin: string };
export type ClientConfig = { hubs?: PublicHub[] };
let loading: Promise<ClientConfig> | undefined;
export function clientConfig(): Promise<ClientConfig> {
  return (loading ??= fetch("/client-config.json", { cache: "no-store" }).then(
    async (response) => {
      if (!response.ok) return {};
      const input = await response.json();
      return {
        hubs: (input.hubs ?? []).map((hub: PublicHub) => ({
          name: String(hub.name),
          origin: canonicalOrigin(hub.origin),
        })),
      };
    },
  ));
}

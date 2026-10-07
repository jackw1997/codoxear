import {
  appearance,
  stylesheet,
  shell,
  placementDialog,
  agentUrl,
  escapeHtml,
} from "./ui.js";
const api = async (path, body) => {
  const r = await fetch(path, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error ?? "Unable to connect");
  return value;
};
export async function startHub(root, user, options) {
  document.body.classList.add("account-ui");
  stylesheet("/appearance/app.css");
  stylesheet("/appearance/shell.css");
  await appearance();
  const directory = await api("/api/agent-directory");
  const query = new URLSearchParams(location.search);
  const selected = directory.agents.find(
    (a) => a.id === query.get("agent") && a.origin === location.origin,
  );
  if (selected?.localId && selected.state === "ready") {
    location.replace(agentUrl(selected, true));
    return;
  }
  const create = () =>
    placementDialog(
      directory.placements,
      async (placement, values) => {
        if (placement.origin !== location.origin) {
          if (values.launch)
            throw new Error(
              "Open this computer’s hub to choose its runtime settings.",
            );
          const target = new URL("/auth/start", placement.origin);
          target.search = new URLSearchParams({
            new: "1",
            computer: placement.computerId,
            name: values.name,
            backend: values.backend,
          }).toString();
          location.assign(target.href);
          return;
        }
        const agent = await api(
          `/api/computers/${placement.computerId}/agents`,
          values,
        );
        if (agent.state !== "ready" || !agent.localId)
          throw new Error(
            "Launch outcome is " +
              agent.state +
              ". Check Agent settings before launching again.",
          );
        location.assign(agentUrl({ ...agent, origin: location.origin }, true));
      },
      {
        initialComputerId: query.get("computer") ?? undefined,
        initialName: query.get("name") ?? "",
        initialBackend: query.get("backend") || "pi",
      },
    );
  shell(root, {
    ...user,
    issuer: options.identityUrl,
    agents: directory.agents,
    currentHub: true,
    onNew: create,
  });
  if (selected && !selected.localId)
    root.querySelector(".account-empty").innerHTML =
      `<h1>${escapeHtml(selected.name)}</h1><p>Launch status: ${escapeHtml(selected.state)}</p><a href="/?settings=${encodeURIComponent(selected.id)}">Agent settings</a>`;
  if (query.has("new")) create();
}

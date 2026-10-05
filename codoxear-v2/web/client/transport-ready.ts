import { transportVersion } from "./transport-version.js";
/** Upgrade the transport before rendering a client that uses its API routes. */
export async function ensureClientTransport() {
  if (!("serviceWorker" in navigator))
    throw new Error(
      "This browser cannot connect to hubs. Open Codoxear in a browser with service-worker support.",
    );
  const registration = await navigator.serviceWorker.register(
    "/client-worker.js",
    { type: "module", scope: "/", updateViaCache: "none" },
  );
  await registration.update();
  await navigator.serviceWorker.ready;
  // Worker installation activates immediately; existing fetches finish in their original worker.
  const ready = () =>
    new Promise<boolean>((resolve) => {
      const worker = navigator.serviceWorker.controller;
      if (!worker) {
        resolve(false);
        return;
      }
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        resolve(false);
      }, 1000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(
          event.data?.type === "codoxear-transport-ready" &&
            event.data?.version === transportVersion,
        );
      };
      worker.postMessage({ type: "codoxear-transport-check" }, [channel.port2]);
    });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    registration.waiting?.postMessage({ type: "codoxear-transport-activate" });
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "The hub connection could not start. Reload this page to reconnect.",
  );
}

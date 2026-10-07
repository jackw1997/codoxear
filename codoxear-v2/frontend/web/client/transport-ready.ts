import { transportVersion } from "./transport-version.js";
/** Upgrade the transport before rendering a client that uses its API routes. */
export async function ensureClientTransport() {
  if (!isSecureContext)
    throw new Error(
      "Codoxear needs trusted HTTPS to connect to hubs. Open this site with a valid certificate trusted by your browser, then reload.",
    );
  if (!("serviceWorker" in navigator))
    throw new Error(
      "This browser cannot connect to hubs because service workers are unavailable. Open Codoxear over trusted HTTPS in a browser with service-worker support.",
    );
  const deadline = Date.now() + 15000;
  const bounded = async <T>(work: Promise<T>, phase: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `The hub connection timed out while ${phase}. Check your connection and this site's HTTPS certificate, then reload.`,
                ),
              ),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  function explain(phase: "register" | "update", error: unknown): never {
    if (
      error instanceof Error &&
      error.message.startsWith("The hub connection timed out")
    )
      throw error;
    const rejected =
      error instanceof DOMException && error.name === "SecurityError";
    throw new Error(
      rejected
        ? "The browser rejected the hub connection. This site needs a valid HTTPS certificate trusted by your browser. Accepting a certificate warning can still block connections."
        : `The browser could not ${phase} the hub connection's service worker. Check your connection and this site's HTTPS certificate, then reload. Use a current browser with module service-worker support.`,
    );
  }
  let registration: ServiceWorkerRegistration;
  try {
    registration = await bounded(
      navigator.serviceWorker.register("/client-worker.js", {
        type: "module",
        scope: "/",
        updateViaCache: "none",
      }),
      "registering its service worker",
    );
  } catch (error) {
    explain("register", error);
  }
  try {
    await bounded(registration.update(), "updating its service worker");
  } catch (error) {
    explain("update", error);
  }
  await bounded(navigator.serviceWorker.ready, "activating its service worker");
  // Worker installation activates immediately; existing fetches finish in their original worker.
  const ready = () =>
    new Promise<boolean>((resolve) => {
      const worker = navigator.serviceWorker.controller;
      if (!worker) {
        resolve(false);
        return;
      }
      const channel = new MessageChannel();
      const timer = setTimeout(
        () => {
          channel.port1.close();
          resolve(false);
        },
        Math.min(1000, Math.max(0, deadline - Date.now())),
      );
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
  while (Date.now() < deadline) {
    registration.waiting?.postMessage({ type: "codoxear-transport-activate" });
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "The browser did not activate the hub connection within 15 seconds. Reload this page to reconnect; if it persists, use a current browser with module service-worker support.",
  );
}

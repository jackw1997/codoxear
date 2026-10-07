import { vault, hubScope } from "./vault.js";

/** The normal Download control prepares a one-use Hub handoff and posts it to
 * the browser's download manager. Bytes never accumulate in the mounted app. */
export function createFileDownloadRuntime(options: {
  resolveAppUrl: (path: string) => string;
  document: Document;
}) {
  let disposed = false;
  const pending = new Set<AbortController>();
  const frames = new Map<HTMLIFrameElement, ReturnType<typeof setTimeout>>();
  return {
    download(path: string) {
      if (!path || disposed) return false;
      const controller = new AbortController();
      pending.add(controller);
      void (async () => {
        const source = new URL(options.resolveAppUrl(path), location.href);
        const match = /^\/api\/sessions\/([^/]+)\/file\/download$/.exec(
          source.pathname,
        );
        const selected = match ? decodeURIComponent(match[1]!) : "";
        const split = selected.indexOf("~");
        if (source.origin !== location.origin || split < 1)
          throw new Error("Select a file in an authenticated Hub workspace");
        const resourcePrefix = selected.slice(0, split),
          agentId = selected.slice(split + 1);
        source.searchParams.delete("__agent");
        const logins = (await vault.list()).filter(
          (login) => hubScope(login) === resourcePrefix || login.accountKey === resourcePrefix,
        );
        let prepared: { action: string; ticket: string } | undefined;
        let failure: Error | undefined;
        for (const login of logins) {
          const response = await fetch(
            `/api/client/hubs/${encodeURIComponent(login.id)}/api/v1/downloads/prepare`,
            {
              method: "POST",
              signal: controller.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                query: source.searchParams.toString(),
              }),
            },
          );
          if (!response.ok) {
            failure = new Error(
              "Download rejected by the Hub (" + response.status + ")",
            );
            continue;
          }
          const value = (await response.json()) as typeof prepared;
          if (
            !value ||
            value.action !== login.origin + "/api/v1/downloads/consume" ||
            typeof value.ticket !== "string" ||
            !/^[A-Za-z0-9_-]{32,200}$/.test(value.ticket)
          )
            throw new Error("Invalid download handoff");
          prepared = value;
          break;
        }
        if (!prepared)
          throw (
            failure ?? new Error("Sign in to this Hub to download the file")
          );
        if (disposed) return;
        const document = options.document;
        const frame = document.createElement("iframe");
        frame.name = "codoxear-download-" + crypto.randomUUID();
        frame.hidden = true;
        frame.title = "File download";
        const form = document.createElement("form");
        form.method = "POST";
        form.action = prepared.action;
        form.target = frame.name;
        form.hidden = true;
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = "ticket";
        field.value = prepared.ticket;
        form.append(field);
        document.body.append(frame, form);
        form.submit();
        form.remove();
        // Keep the initiated download target alive; never navigate the app tab.
        frames.set(frame, setTimeout(() => { frames.delete(frame); frame.remove(); }, 24 * 60 * 60 * 1000));
      })().catch((error) => {
        if (disposed) return;
        const status =
          options.document.getElementById("fileStatus") ??
          options.document.getElementById("toast");
        if (status) status.textContent = String(error);
      }).finally(() => pending.delete(controller));
      return true;
    },
    dispose() {
      disposed = true;
      for (const controller of pending) controller.abort();
      pending.clear();
      for (const [frame, timer] of frames) { clearTimeout(timer); frame.remove(); }
      frames.clear();
    },
  };
}

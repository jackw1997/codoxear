/** Keep the original Download control. Browser download-manager requests may
 * bypass a service worker, so acquire the authenticated bytes before handing
 * a local blob to that manager. No credential appears in a download URL. */
export function createFileDownloadRuntime(options: {
  resolveAppUrl: (path: string) => string;
  document: Document;
}) {
  return {
    download(path: string) {
      if (!path) return false;
      void (async () => {
        const response = await fetch(options.resolveAppUrl(path));
        if (!response.ok)
          throw new Error(
            "Download rejected by the hub (" + response.status + ")",
          );
        const limit = 256 * 1024 * 1024;
        if (Number(response.headers.get("content-length")) > limit) {
          await response.body?.cancel();
          throw new Error("Browser downloads are limited to 256 MiB");
        }
        const reader = response.body!.getReader(),
          chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit)
              throw new Error("Browser downloads are limited to 256 MiB");
            chunks.push(new Uint8Array(value));
          }
        } catch (error) {
          await reader.cancel();
          throw error;
        }
        const disposition = response.headers.get("content-disposition") ?? "";
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
        let filename =
          /filename="([^"]+)"/i.exec(disposition)?.[1] ??
          new URL(path, location.href).searchParams
            .get("path")
            ?.split("/")
            .pop() ??
          "download";
        if (encoded)
          try {
            filename = decodeURIComponent(encoded);
          } catch {}
        const url = URL.createObjectURL(
          new Blob(chunks, {
            type:
              response.headers.get("content-type") ??
              "application/octet-stream",
          }),
        );
        const a = options.document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        a.hidden = true;
        options.document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })().catch((error) => {
        const status =
          options.document.getElementById("fileStatus") ??
          options.document.getElementById("toast");
        if (status) status.textContent = String(error);
      });
      return true;
    },
  };
}

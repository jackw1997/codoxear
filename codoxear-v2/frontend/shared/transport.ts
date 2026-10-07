import {
  apiAddress,
  credentialKey,
  ConnectionContext,
  type CredentialVault,
} from "./context.js";
export class ClientFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** No automatic retry of requests. Tokens are refreshed before invocation by the login coordinator. */
export class ClientTransport {
  constructor(
    readonly context: ConnectionContext,
    private vault: CredentialVault,
    private transport: typeof fetch = fetch,
  ) {}
  async request(path: string, options: RequestInit = {}) {
    const captured = this.context.capture();
    try {
      const credential = await this.vault.read(credentialKey(captured.profile));
      captured.assertCurrent();
      const headers = new Headers(options.headers);
      headers.delete("authorization");
      headers.delete("cookie");
      if (captured.profile.mode === "relay") {
        if (!credential)
          throw new ClientFailure(401, "login_required", "Sign in to this hub");
        headers.set("authorization", "Bearer " + credential);
      } else if (credential) headers.set("cookie", credential);
      const method = (options.method ?? "GET").toUpperCase();
      let response: Response;
      try {
        response = await this.transport(apiAddress(captured.profile, path), {
          ...options,
          headers,
          signal: captured.signal,
          credentials: "omit",
          redirect: "error",
        });
      } catch (e) {
        captured.assertCurrent();
        if (!["GET", "HEAD"].includes(method))
          throw new ClientFailure(
            0,
            "outcome_unknown",
            "The operation may have completed. Inspect its state before retrying.",
          );
        throw e;
      }
      captured.assertCurrent();
      if (!response.ok) {
        const value = (await response.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
        };
        captured.assertCurrent();
        throw new ClientFailure(
          response.status,
          value.code ?? "request_failed",
          value.error ?? `Request failed (${response.status})`,
        );
      }
      // Keep the generation alive through streaming, including cancellation after headers.
      const source = response.body?.getReader();
      if (!source) {
        captured.release();
        return response;
      }
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            captured.assertCurrent();
            const next = await source.read();
            captured.assertCurrent();
            if (next.done) {
              captured.release();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (e) {
            captured.release();
            await source.cancel(e).catch(() => {});
            controller.error(e);
          }
        },
        cancel: async (reason) => {
          captured.release();
          await source.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      captured.release();
      throw e;
    }
  }
}

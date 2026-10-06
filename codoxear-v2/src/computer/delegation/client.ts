import { z } from "zod";
import { Attachment } from "../config.js";
import { DomainError, Id } from "../../contracts/model.js";
import {
  DelegationSpawn,
  DelegationReceipt,
  DelegationSend,
} from "../../contracts/delegation.js";

/** Constructed by a trusted controller. Credentials stay private to this transport;
 * neither the attachment nor the grant is an argument to a model tool.
 */
export class DelegationClient {
  #origin: string;
  #base: string;
  #credential: string;
  #grant: string;
  #transport: typeof fetch;
  constructor(
    attachment: z.infer<typeof Attachment>,
    parentId: string,
    grant: string,
    transport: typeof fetch = fetch,
  ) {
    const config = Attachment.parse(attachment);
    const url = new URL(config.hubUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new DomainError(
        400,
        "invalid_attachment",
        "Delegation requires an exact Hub origin",
      );
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new DomainError(
        400,
        "invalid_attachment",
        "Delegation requires HTTPS or loopback HTTP",
      );
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(grant))
      throw new DomainError(400, "invalid_grant", "Invalid delegation grant");
    this.#origin = url.origin;
    this.#base = `/connect/v1/computers/${Id.parse(config.computerId)}/agents/${Id.parse(parentId)}/delegations`;
    this.#credential = config.credential;
    this.#grant = grant;
    this.#transport = transport;
  }
  async spawn(input: z.infer<typeof DelegationSpawn>, signal?: AbortSignal) {
    return DelegationReceipt.parse(
      await this.request("POST", "", DelegationSpawn.parse(input), signal),
    );
  }
  async list(signal?: AbortSignal) {
    return z
      .object({ children: z.array(DelegationReceipt).max(128) })
      .parse(await this.request("GET", "", undefined, signal));
  }
  async targets(signal?: AbortSignal) {
    return z
      .object({
        computers: z
          .array(z.object({ id: Id, name: z.string().max(120).optional() }))
          .max(32),
      })
      .parse(await this.request("GET", "/targets", undefined, signal));
  }
  async status(childId: string, signal?: AbortSignal) {
    return DelegationReceipt.parse(
      await this.request("GET", `/${Id.parse(childId)}`, undefined, signal),
    );
  }
  async messages(childId: string, signal?: AbortSignal) {
    return z
      .object({
        messages: z
          .array(
            z.object({
              id: z.string().max(200),
              role: z.enum(["user", "assistant", "system"]),
              text: z.string().max(256 * 1024),
              at: z.number(),
            }),
          )
          .max(512),
        truncated: z.boolean(),
      })
      .parse(
        await this.request(
          "GET",
          `/${Id.parse(childId)}/messages`,
          undefined,
          signal,
        ),
      );
  }
  async send(childId: string, text: string, signal?: AbortSignal) {
    await this.request(
      "POST",
      `/${Id.parse(childId)}/send`,
      DelegationSend.parse({ text }),
      signal,
    );
    return { accepted: true as const };
  }
  async interrupt(childId: string, signal?: AbortSignal) {
    await this.request("POST", `/${Id.parse(childId)}/interrupt`, {}, signal);
    return { accepted: true as const };
  }
  private scrub(value: unknown): unknown {
    if (typeof value === "string")
      return value
        .split(this.#credential)
        .join("[redacted]")
        .split(this.#grant)
        .join("[redacted]");
    if (Array.isArray(value)) return value.map((item) => this.scrub(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.scrub(item)]),
      );
    return value;
  }
  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(35_000);
    let response: Response;
    try {
      response = await this.#transport(
        new URL(this.#base + path, this.#origin),
        {
          method,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            Authorization: `Bearer ${this.#credential}`,
            "X-Codoxear-Delegation-Grant": this.#grant,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      // Bound bytes while streaming, including error responses; never buffer an
      // untrusted response with response.json()/text() before checking its size.
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new DomainError(
          502,
          "delegation_redirect",
          "Hub redirect rejected",
        );
      const reader = response.body?.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 256 * 1024) {
              await reader.cancel();
              throw new DomainError(
                502,
                "delegation_response_limit",
                "Hub response exceeds the delegation limit",
              );
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      let value: unknown;
      try {
        value = this.scrub(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        throw new DomainError(
          502,
          "delegation_response_invalid",
          "Hub returned an invalid delegation response",
        );
      }
      if (!response.ok) {
        const error = z
          .object({
            code: z.string().max(100),
            error: z.string().max(1000).optional(),
          })
          .safeParse(value);
        throw new DomainError(
          response.status,
          error.success ? error.data.code : "delegation_rejected",
          error.success
            ? (error.data.error ?? "Hub rejected delegation")
            : "Hub rejected delegation",
        );
      }
      return value;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // Fetch exceptions can include headers or URLs. Return a fixed safe error,
      // preserving uncertainty for mutation callers without retrying anything.
      throw new DomainError(
        503,
        "delegation_transport",
        method === "POST"
          ? "Delegation response unavailable; outcome may be unknown. Inspect the same request or child before retrying."
          : "Delegation Hub is unavailable",
      );
    }
  }
}

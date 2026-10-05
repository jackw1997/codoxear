import { z } from "zod";
import { SqliteDocument } from "../persistence/document.js";
import { DomainError } from "../contracts/model.js";
import {
  type HttpRequest,
  type HttpResponse,
} from "../protocol/http-frames.js";
type Draft = {
  actorId: string;
  localId: string;
  text: string;
  updated_ts: number;
};
/** Personal unsent text is never forwarded to the legacy shared session draft. */
export class ComputerDrafts {
  private document: SqliteDocument<{ drafts: Draft[] }>;
  constructor(path: string, scope: string) {
    this.document = new SqliteDocument(path, scope, () => ({ drafts: [] }));
  }
  read(actorId: string, localId: string) {
    const item = this.document
      .read()
      .drafts.find((d) => d.actorId === actorId && d.localId === localId);
    return {
      ok: true,
      text: item?.text ?? "",
      updated_ts: item?.updated_ts ?? 0,
    };
  }
  timestamps(actorId: string) {
    return new Map(
      this.document
        .read()
        .drafts.filter((d) => d.actorId === actorId)
        .map((d) => [d.localId, d.updated_ts]),
    );
  }
  write(actorId: string, localId: string, text: string) {
    z.string().max(200000).parse(text);
    if (!actorId)
      throw new DomainError(
        403,
        "actor_required",
        "Verified draft owner required",
      );
    return this.document.change((s) => {
      const old = s.drafts.find(
          (d) => d.actorId === actorId && d.localId === localId,
        ),
        updated_ts = Math.max(
          Date.now() / 1000,
          (old?.updated_ts ?? 0) + 0.001,
        );
      s.drafts = s.drafts.filter((d) => d !== old);
      s.drafts.push({ actorId, localId, text, updated_ts });
      if (
        s.drafts.length > 10000 ||
        s.drafts.reduce((n, d) => n + Buffer.byteLength(d.text), 0) >
          16 * 1024 * 1024
      )
        throw new DomainError(
          413,
          "draft_storage_full",
          "Computer draft storage is full",
        );
      return { ok: true, updated_ts };
    });
  }
  async handle(request: HttpRequest): Promise<HttpResponse | undefined> {
    const match = /^\/api\/sessions\/([A-Za-z0-9_.:-]+)\/draft$/.exec(
      request.path.split("?")[0]!,
    );
    if (!match) return;
    let status = 200,
      value: unknown;
    try {
      if (!request.actorId)
        throw new DomainError(
          403,
          "actor_required",
          "Verified draft owner required",
        );
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request.body) {
          length += chunk.byteLength;
          if (length > 1024 * 1024)
            throw new DomainError(
              413,
              "draft_too_large",
              "Draft exceeds limit",
            );
          chunks.push(Buffer.from(chunk));
        }
        value = this.write(
          request.actorId,
          match[1]!,
          z
            .object({ text: z.string() })
            .parse(JSON.parse(Buffer.concat(chunks).toString())).text,
        );
      } else if (["GET", "HEAD"].includes(request.method))
        value = this.read(request.actorId, match[1]!);
      else
        throw new DomainError(
          405,
          "invalid_method",
          "Unsupported draft operation",
        );
    } catch (e) {
      status = e instanceof DomainError ? e.status : 400;
      value = { error: e instanceof Error ? e.message : "Invalid draft" };
    }
    const body = Buffer.from(JSON.stringify(value));
    return {
      status,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      },
    };
  }
  close() {
    this.document.close();
  }
}

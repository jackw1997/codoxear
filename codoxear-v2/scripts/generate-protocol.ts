/** Pure serialization. Docker conformance compares this inventory and schemas
 * with the actual registered routers; ordinary builds start no authority. */
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  HttpFrame,
  CHUNK_BYTES,
  STREAM_WINDOW,
  COMPUTER_WINDOW,
  MAX_STREAMS,
} from "../src/protocol/http-frames.js";
import {
  RequestFrame,
  ResultFrame,
  WelcomeFrame,
  Operation,
  MAX_FRAME_BYTES,
} from "../src/contracts/tunnel.js";
import {
  NotificationFrame,
  NotificationAck,
  NOTIFICATION_TTL,
} from "../src/protocol/notifications.js";
import { BrowserSubscription, PushHint } from "../src/contracts/web-push.js";
import {
  WorkspaceContext,
  WorkspaceOptions,
  WorkspaceEdit,
} from "../src/contracts/workspaces.js";
import { PAIRING_LIFETIME_SECONDS } from "../src/contracts/pairing.js";
import { Id, Hub, Agent } from "../src/contracts/model.js";
import {
  ErrorResponse,
  HUB_PROTOCOL,
  HUB_CAPABILITIES,
  publicContract,
  registeredContract,
  registeredInventory,
  relayContract,
  type Endpoint,
} from "../src/protocol/inventory.js";
import { nativeSchemas } from "../src/protocol/native-contracts.js";
import {
  adminSchemas,
  adminOperationSchemas,
} from "../src/protocol/admin-contracts.js";
const json = (schema: z.ZodType, io: "input" | "output" = "output") =>
  z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io,
  });
const schemaForParameter = (name: string) =>
  name === "file"
    ? z.string().regex(/^[a-zA-Z0-9_-]+\.(js|css)$/)
    : name === "localId"
      ? z.string().min(1).max(200)
      : name === "kind"
        ? z.enum(["hub", "computer"])
        : name === "filename"
          ? z.string().regex(/^[A-Za-z0-9_.-]+$/)
          : Id;
const pathName = (path: string) =>
  path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
const security = {
  Bearer: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "Exact configured authority issuer and Hub audience; no global account service is required.",
  },
  BrowserCookie: {
    type: "apiKey",
    in: "cookie",
    name: "codoxear_hub_{hubId}",
    description:
      "Optional Hub-hosted browser BFF cookie. Independent static clients keep rotating OAuth credentials in this installation's IndexedDB.",
  },
  IdentityCookie: {
    type: "apiKey",
    in: "cookie",
    name: "codoxear_identity_{hubId}",
    description:
      "Independent authority cookie uses its Hub ID; explicit shared-authority compatibility uses codoxear_identity.",
  },
  ComputerCredential: {
    type: "http",
    scheme: "bearer",
    description:
      "Current Computer attachment credential, fenced by the Hub/Computer binding.",
  },
  HubCredential: {
    type: "apiKey",
    in: "header",
    name: "X-Hub-Credential",
    description:
      "Private Hub service credential; X-Codoxear-Hub identifies the exact Hub.",
  },
};
function auth(endpoint: Endpoint, component: string) {
  if (endpoint.auth === "public" || endpoint.auth === "download-ticket")
    return [];
  if (endpoint.auth === "computer") return [{ ComputerCredential: [] }];
  if (endpoint.auth === "hub-service") return [{ HubCredential: [] }];
  if (endpoint.auth === "hub-user") return [{ HubCredential: [], Bearer: [] }];
  return [
    { Bearer: [] },
    { [component === "identity" ? "IdentityCookie" : "BrowserCookie"]: [] },
  ];
}
function document(
  title: string,
  description: string,
  endpoints: Endpoint[],
  component: string,
) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    const path = pathName(endpoint.path),
      method = endpoint.method.toLowerCase();
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: json(schemaForParameter(match[1]!)),
    }));
    if (endpoint.query) {
      const schema = json(endpoint.query, "input") as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, value] of Object.entries(schema.properties ?? {}))
        parameters.push({
          name,
          in: "query",
          required: !!schema.required?.includes(name),
          schema: value as ReturnType<typeof json>,
        });
    }
    if (endpoint.responseHeaders?.ETag) {
      for (const [name, description] of Object.entries({
        Range:
          "One byte range: bytes=start-end, bytes=start-, or bytes=-suffix. Invalid syntax yields JSON 416; unsatisfiable bounds yield empty 416.",
        "If-None-Match": "Exact current ETag yields 304 with no body.",
        "If-Range":
          "Only a matching ETag permits Range; a mismatch returns the full 200 body.",
      }))
        parameters.push({
          name,
          in: "header",
          required: false,
          schema: json(z.string().describe(description)),
        });
    }
    if (["hub-service", "hub-user"].includes(endpoint.auth))
      parameters.push({
        name: "X-Codoxear-Hub",
        in: "header",
        required: true,
        schema: json(Id),
      });
    if (endpoint.websocket)
      parameters.push(
        ...[
          {
            name: "X-Codoxear-Hub",
            in: "header",
            required: true,
            schema: json(Id),
          },
          {
            name: "X-Codoxear-Protocol",
            in: "header",
            required: false,
            schema: json(z.literal("1")),
          },
        ],
      );
    const responses = Object.fromEntries(
      endpoint.statuses.map((code) => {
        const response: Record<string, unknown> = {
          description:
            code >= 400
              ? "Structured router, Hub/authority or native error; inspect code when present"
              : code === 101
                ? "Authenticated WebSocket upgrade"
                : code === 302
                  ? "Redirect"
                  : code === 206
                    ? "Partial streamed body"
                    : "Success",
        };
        if (endpoint.responseHeaders && [200, 206, 304, 416].includes(code))
          response.headers = endpoint.responseHeaders;
        if (code === 416 && endpoint.responseHeaders)
          response.description =
            "Unsatisfiable ranges may return an empty body with Content-Range; malformed range syntax returns a JSON error";
        if (code >= 400)
          response.content = {
            "application/json": { schema: json(ErrorResponse) },
          };
        else if (code === 302)
          response.headers = {
            Location: {
              schema: { type: "string" },
              description: "Validated redirect target",
            },
          };
        else if (code !== 101 && code !== 304 && endpoint.method !== "HEAD") {
          const contentType = endpoint.contentType ?? "application/json";
          response.content = endpoint.responseContents
            ? Object.fromEntries(
                Object.entries(endpoint.responseContents).map(
                  ([type, schema]) => [type, { schema: json(schema) }],
                ),
              )
            : {
                [contentType]: {
                  schema: endpoint.response
                    ? json(endpoint.response)
                    : contentType === "application/json"
                      ? {}
                      : {
                          type: "string",
                          ...([
                            "application/octet-stream",
                            "*/*",
                            "video/mp2t",
                          ].includes(contentType)
                            ? { format: "binary" }
                            : {}),
                        },
                },
              };
          if (endpoint.events)
            response["x-sse-event-schemas"] = Object.fromEntries(
              Object.entries(endpoint.events).map(([name, schema]) => [
                name,
                json(schema),
              ]),
            );
        }
        if (endpoint.method === "HEAD") delete response.content;
        return [String(code), response];
      }),
    );
    paths[path] ??= {};
    const requestContent = endpoint.requestContents
      ? Object.fromEntries(
          Object.entries(endpoint.requestContents).map(([type, schema]) => [
            type,
            { schema: json(schema, "input") },
          ]),
        )
      : endpoint.body
        ? {
            [endpoint.requestContentType ?? "application/json"]: {
              schema: json(endpoint.body, "input"),
            },
          }
        : undefined;
    paths[path][method] = {
      summary: endpoint.summary,
      security: auth(endpoint, component),
      "x-schema-status": endpoint.websocket
        ? "typed-websocket-upgrade"
        : endpoint.responseContents
          ? "typed-content-variants"
          : endpoint.events
            ? "typed-sse-events"
            : endpoint.response
              ? "typed-producer-response"
              : endpoint.contentType &&
                  endpoint.contentType !== "application/json"
                ? "typed-stream-or-document"
                : "producer-specific response; no invented field schema",
      ...(endpoint.action
        ? { "x-required-route-capability": endpoint.action }
        : {}),
      ...(endpoint.conditional ? { "x-condition": endpoint.conditional } : {}),
      ...(endpoint.path === "/internal/call"
        ? {
            "x-dispatch-operation-schemas": Object.fromEntries(
              Object.entries(adminOperationSchemas).map(([op, schema]) => [
                op,
                {
                  args: json(schema.request, "input"),
                  response: json(schema.response),
                },
              ]),
            ),
            "x-dispatch-schema-description":
              "Each args schema describes the parsed args object. The request op selects the corresponding unwrapped successful response schema.",
          }
        : {}),
      ...(endpoint.websocket
        ? {
            "x-websocket": true,
            "x-websocket-frame-schemas": [
              "rpc-frame.schema.json",
              "http-frame.schema.json",
            ],
          }
        : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(requestContent
        ? {
            requestBody: {
              required: endpoint.body ? !endpoint.body.isOptional() : true,
              content: requestContent,
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title, version: "1.0.0", description },
    paths,
    components: {
      securitySchemes: security,
      schemas: {
        Hub: json(Hub),
        Agent: json(Agent),
        Error: json(ErrorResponse),
        Operation: json(Operation),
        WorkspaceContext: json(WorkspaceContext),
        WorkspaceOptions: json(WorkspaceOptions, "input"),
        WorkspaceEdit: json(WorkspaceEdit, "input"),
        BrowserSubscription: json(BrowserSubscription, "input"),
        PushHint: json(PushHint),
        ...Object.fromEntries(
          Object.entries({ ...nativeSchemas, ...adminSchemas }).map(
            ([name, schema]) => [name, json(schema)],
          ),
        ),
      },
    },
  };
}
const hub = document(
  "Codoxear independent Hub API",
  "A Computer connects outbound to its chosen Hub. Each independent Hub owns accounts, signing keys and policy. Static browser clients connect directly using OAuth and a scoped service worker; Hub-hosted BFF cookies and a separate shared authority remain optional compatibility. No automatic direct fallback and no automatic mutation replay. JSON Schema describes structural validation; current membership, identity, binding, canonical paths and custom refinements remain server checks.",
  publicContract("hub"),
  "hub",
);
const identity = document(
  "Codoxear authority API",
  "These routes execute inside each independent Hub. An explicitly configured shared authority can expose the same compatibility API; it is not an independent-Hub prerequisite. OAuth uses exact registered redirect URIs, issuer checking and S256 PKCE. Internal service routes are documented separately.",
  publicContract("identity"),
  "identity",
);
const internal = document(
  "Codoxear internal Hub authority API",
  "Private service boundary only. A valid X-Hub-Credential and exact X-Codoxear-Hub are required; /internal/call additionally requires the authenticated user's exact-Hub-audience bearer credential. Credentials are never returned by this document.",
  registeredContract("identity").filter((endpoint) =>
    endpoint.path.startsWith("/internal/"),
  ),
  "internal",
);
const relayEndpoints = relayContract().map((endpoint) => ({
  ...endpoint,
  path: "/api/v1/computers/:computerId" + endpoint.path,
}));
const relay = document(
  "Codoxear Computer HTTP relay allowlist",
  "The namespace preserves Computer-local session IDs. Browser /workspace/api routes instead use published agent IDs and map them after account authorization. Only the listed method/path combinations are relayed. Files require a separate current workspace grant; optional Git, uploads and transcoding require explicit capability flags. Policy, identity, binding and grant revision are rechecked during streams.",
  relayEndpoints,
  "hub",
);
const hello = z.object({
  type: z.literal("hello"),
  protocol: z.literal(1),
  capabilities: z.array(z.string().max(80)).max(32),
});
const limits = {
  version: HUB_PROTOCOL,
  hubCapabilities: HUB_CAPABILITIES,
  chunkBytes: CHUNK_BYTES,
  streamQueuedBytes: STREAM_WINDOW,
  computerQueuedBytes: COMPUTER_WINDOW,
  maxConcurrentStreams: MAX_STREAMS,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxUploadBytes: 256 * 1024 * 1024,
  native: {
    maxUploadFileBytes: 64 * 1024 * 1024,
    maxJsonBodyBytes: 8 * 1024 * 1024,
    maxFileViewerBytes: 2 * 1024 * 1024,
    maxFileWriteUtf8Bytes: 2 * 1024 * 1024,
    maxFileInspectBatchPaths: 50,
    maxQueueOrDraftBodyBytes: 1024 * 1024,
    maxQueueDraftAndAgentPromptCharacters: 200000,
    audioListenerLeaseSeconds: 45,
    usageFields: "normalized optional counters with backend-owned extensions",
    compatibility:
      "Producer schemas describe updated native Computers. Historical brokers remain preserved and may require a capability update for some operations.",
  },
  mutationRetry: false,
  pairingLifetimeSeconds: PAIRING_LIFETIME_SECONDS,
  downloadTicketLifetimeSeconds: 120,
  notifications: {
    ttlSeconds: NOTIFICATION_TTL / 1000,
    acknowledgement: "after durable Hub acceptance",
    maxOutboxEvents: 10000,
    maxHubEvents: 10000,
    maxDeliveries: 100000,
    providerSemantics:
      "at-least-once generic hint; provider/browser delivery is not guaranteed",
    webPush: {
      contentEncoding: "aes128gcm",
      authentication: "VAPID",
      showAndClick:
        "fresh account/session/binding/subscription-generation authorization",
    },
  },
  maxPolicyLeaseSeconds: 30,
  registeredMethods:
    "HEAD is implicit for GET where Fastify installs it; OPTIONS is the independent Hub's origin-checking preflight hook, not a permission bypass",
};
await mkdir("protocol", { recursive: true });
for (const [file, value] of Object.entries({
  "hub.openapi.json": hub,
  "identity.openapi.json": identity,
  "internal.openapi.json": internal,
  "relay.openapi.json": relay,
  "registered-routes.json": registeredInventory,
  "http-frame.schema.json": json(HttpFrame, "input"),
  "rpc-frame.schema.json": json(
    z.union([
      hello,
      RequestFrame,
      ResultFrame,
      WelcomeFrame,
      NotificationFrame,
      NotificationAck,
    ]),
    "input",
  ),
  "limits.json": limits,
}))
  await writeFile("protocol/" + file, JSON.stringify(value, null, 2) + "\n");

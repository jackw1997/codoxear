import { connect } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// TypeBox's public schema discriminator allows a self-contained extension
// without resolving another package from the user's private agent directory.
const Kind = Symbol.for("TypeBox.Kind");
const string = (description: string) => ({
  [Kind]: "String",
  type: "string",
  description,
});
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  [Kind]: "Object",
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
type Pi = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      callId: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>;
  }): void;
};
export type DelegationTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    callId: string,
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { code?: string; result?: unknown };
    isError?: boolean;
  }>;
};
type DelegationClient = {
  spawn(input: any): Promise<unknown>;
  list(): Promise<unknown>;
  status(childId: string): Promise<unknown>;
  send(childId: string, text: string): Promise<unknown>;
  interrupt(childId: string): Promise<unknown>;
  targets?: () => Promise<unknown>;
  messages?: (childId: string) => Promise<unknown>;
};
/** Computer-side injectable registration retained for the bounded HTTP client.
 * The production worker below uses only the private local socket bridge. */
export function registerDelegationTool(
  pi: { registerTool(tool: DelegationTool): void },
  client: DelegationClient,
) {
  pi.registerTool({
    name: "codoxear_delegate",
    label: "Codoxear delegation",
    description:
      "Control owner-approved same-Hub child agents. Use targets to discover Computers, spawn with explicit runtime/model/effort/cwd, status to reconcile uncertain outcomes before retrying, and messages to read child answers (bounded history may be explicitly truncated).",
    parameters: object(
      {
        action: {
          ...string("Delegation action"),
          enum: [
            "targets",
            "spawn",
            "list",
            "status",
            "messages",
            "send",
            "interrupt",
          ],
        },
        targetComputerId: string("Allowed Computer ID"),
        childId: string("Child ID"),
        requestId: string("Stable request ID"),
        backend: { ...string("Runtime"), enum: ["pi", "codex", "cc"] },
        name: string("Child name"),
        text: string("Follow-up input"),
        launch: object({
          model: string("Model"),
          model_provider: string("Native provider"),
          reasoning_effort: string("Native effort"),
          cwd: string("Target working directory"),
        }),
      },
      ["action"],
    ),
    async execute(callId, args) {
      const allowed = new Set([
        "action",
        "targetComputerId",
        "childId",
        "requestId",
        "backend",
        "name",
        "text",
        "launch",
      ]);
      if (Object.keys(args).some((key) => !allowed.has(key)))
        return {
          content: [{ type: "text", text: "Invalid delegation arguments" }],
          details: { code: "invalid_request" },
          isError: true,
        };
      if (
        args.launch &&
        (typeof args.launch !== "object" ||
          Array.isArray(args.launch) ||
          Object.keys(args.launch).some(
            (key) =>
              !["model", "model_provider", "reasoning_effort", "cwd"].includes(
                key,
              ),
          ))
      )
        return {
          content: [{ type: "text", text: "Invalid launch arguments" }],
          details: { code: "invalid_request" },
          isError: true,
        };
      try {
        let value: unknown;
        if (args.action === "spawn")
          value = await client.spawn({
            requestId:
              args.requestId ??
              createHash("sha256").update(callId).digest("hex"),
            targetComputerId: args.targetComputerId,
            backend: args.backend,
            name: args.name ?? "Subagent",
            ...(args.launch ? { launch: args.launch } : {}),
          });
        else if (args.action === "targets" && client.targets)
          value = await client.targets();
        else if (args.action === "list") value = await client.list();
        else if (args.action === "status" && typeof args.childId === "string")
          value = await client.status(args.childId);
        else if (
          args.action === "messages" &&
          typeof args.childId === "string" &&
          client.messages
        )
          value = await client.messages(args.childId);
        else if (
          args.action === "send" &&
          typeof args.childId === "string" &&
          typeof args.text === "string"
        )
          value = await client.send(args.childId, args.text);
        else if (
          args.action === "interrupt" &&
          typeof args.childId === "string"
        )
          value = await client.interrupt(args.childId);
        else
          return {
            content: [{ type: "text", text: "Invalid delegation arguments" }],
            details: { code: "invalid_request" },
            isError: true,
          };
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          details: { result: value },
        };
      } catch (error) {
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "delegation_unknown";
        return {
          content: [
            {
              type: "text",
              text: "Delegation failed. Inspect authorized child receipts before retrying an effectful request.",
            },
          ],
          details: { code },
          isError: true,
        };
      }
    },
  });
}

/** Loaded only into an explicitly controlled Pi session. The model never
 * receives Computer bearer credentials or the owner-approved Hub grant. */
export default function delegationTool(pi: Pi) {
  const path = process.env.CODOXEAR_DELEGATION_DESCRIPTOR;
  if (!path) return;
  const descriptor = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    socket: string;
    capability: string;
    localId: string;
  };
  if (
    descriptor.version !== 1 ||
    !/^managed-[a-f0-9]{32}$/.test(descriptor.localId) ||
    !/^[a-f0-9]{64}$/.test(descriptor.capability)
  )
    throw Error("Invalid local delegation descriptor");
  pi.registerTool({
    name: "codoxear_delegate",
    label: "Codoxear delegation",
    description:
      "Manage owner-approved subagents on Computers in this Hub. Use targets first to discover authorized Computer IDs. Spawn selects runtime backend and model/effort/cwd through launch, for example backend codex and launch.model gpt-6-astra. Use status to reconcile an unknown launch before trying again. Tools/provider accounts execute on the target Computer; no cross-Hub delegation. Use list for child receipts, messages to read child answers (bounded history may be explicitly truncated), send for follow-up input, interrupt to stop active work.",
    parameters: object(
      {
        action: {
          ...string(
            "targets, spawn, list, status, messages, send or interrupt",
          ),
          enum: [
            "targets",
            "spawn",
            "list",
            "status",
            "messages",
            "send",
            "interrupt",
          ],
        },
        targetComputerId: string("Approved target Computer ID from targets"),
        childId: string("Child agent ID from spawn/list"),
        backend: { ...string("Native runtime"), enum: ["pi", "codex", "cc"] },
        name: string("Child display name"),
        text: string("Follow-up child input"),
        requestId: string(
          "Optional stable request ID for explicit reconciliation of a spawn",
        ),
        launch: object({
          model: string("Target runtime model identifier"),
          model_provider: string("Named provider already configured on target"),
          reasoning_effort: string("Runtime-native reasoning effort"),
          cwd: string("Absolute working directory on target Computer"),
        }),
      },
      ["action"],
    ),
    async execute(callId, args, signal) {
      const request = {
        ...args,
        ...(args.action === "spawn" && !args.requestId
          ? {
              requestId: createHash("sha256")
                .update(descriptor.localId + ":" + callId)
                .digest("hex"),
            }
          : {}),
      };
      const value = await new Promise<unknown>((resolve, reject) => {
        const socket = connect(descriptor.socket);
        let buffer = "",
          settled = false;
        const abort = () =>
          finish(
            Error(
              "Delegation tool cancelled; inspect receipts before retrying an effectful request",
            ),
          );
        const finish = (error?: Error, result?: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          socket.destroy();
          if (error) reject(error);
          else resolve(result);
        };
        socket.setTimeout(45000, () =>
          finish(
            Error(
              "Delegation response timed out; inspect child receipts before retrying",
            ),
          ),
        );
        socket.setEncoding("utf8");
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        socket.on("connect", () => {
          const line =
            JSON.stringify({
              localId: descriptor.localId,
              capability: descriptor.capability,
              request,
            }) + "\n";
          if (Buffer.byteLength(line) > 256 * 1024) {
            finish(Error("Delegation request exceeds local channel limit"));
            return;
          }
          socket.write(line);
        });
        socket.on("error", () =>
          finish(
            Error(
              "Computer delegation bridge unavailable; complete local setup or request a fresh owner grant",
            ),
          ),
        );
        socket.on("end", () => {
          if (!settled)
            finish(
              Error(
                "Delegation bridge ended before acknowledgement; inspect receipts before retrying",
              ),
            );
        });
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 1024 * 1024) {
            finish(Error("Delegation response exceeds local channel limit"));
            return;
          }
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          try {
            const answer = JSON.parse(buffer.slice(0, end));
            if (answer.ok) finish(undefined, answer.value);
            else
              finish(
                Error(
                  typeof answer.error === "string"
                    ? answer.error
                    : "Delegation refused",
                ),
              );
          } catch {
            finish(Error("Invalid delegation bridge reply"));
          }
        });
      });
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: { result: value },
      };
    },
  });
  // Capability-bound confirmation proves this exact extension loaded before
  // accepting a grant install. PID alone is never an adoption identity.
  writeFileSync(
    path + ".loaded.json",
    JSON.stringify({
      version: 1,
      localId: descriptor.localId,
      capability: descriptor.capability,
    }),
    { mode: 0o600 },
  );
}

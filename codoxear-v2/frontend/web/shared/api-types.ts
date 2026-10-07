/** Browser-owned JSON wire types. No server implementation is part of this package. */
export type Policy = "retain" | "read_only" | "none";
export type Role = "viewer" | "operator";
export type Action = "read" | "send" | "interrupt";
export type Hub = { id: string; ownerId: string; name: string; policy: Policy | null; revision: number };
export type Agent = { id: string; computerId: string; hubId: string; creatorId: string; name: string; backend: "codex" | "pi" | "cc" | "fixture"; localId: string | null; state: "starting" | "ready" | "unknown" | "failed"; createdAt: number };
export type Decision = { actions: Action[]; mode: "member" | "shared" | "retained" | "read_only" | "denied"; source: "hub" | "computer" | "default" | "membership" | "agent"; reason: string };
export type Message = { id: string; role: "user" | "assistant" | "system"; text: string; at: number };

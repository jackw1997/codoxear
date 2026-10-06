/** Structural boundary pinned to @botiverse/oar 0.13.3. No production fake. */
export type ManagedBackend = "codex" | "pi" | "cc";
export type ManagedRecord = {
  seq: number;
  sessionId: string;
  receivedAt: number;
  agentPath: readonly string[];
  kind: "frame" | "request" | "response";
  id?: string;
  requestId?: string;
  direction?: string;
  body: {
    events?: readonly Record<string, unknown>[];
    kind?: string;
    action?: string;
    [key: string]: unknown;
  };
};
export type ManagedOutcome = {
  kind: "accepted" | "rejected";
  code?: string;
  reason?: string;
};
export interface ManagedSession {
  readonly id: string;
  readonly profile?: string;
  /** Worker death is a host lifecycle fact, not a fabricated native OAR record. */
  onExit?(observer: () => void): () => void;
  rawEvents(
    observer: (record: ManagedRecord) => void,
    cursor?: { sessionId: string; afterSeq: number },
  ): () => void;
  prompt(text: string, options: { inputId: string }): Promise<ManagedOutcome>;
  abort(): Promise<ManagedOutcome>;
  dispose(): Promise<void>;
}
export interface ManagedOpen {
  delegation?: import("../delegation/bridge.js").DelegationEndpoint;
  home: string;
  stateHome: string;
  launch?: import("../native/types.js").LaunchOptions;
  profile?: string;
  backend: ManagedBackend;
  cwd: string;
  model?: string;
  effort?: string;
  resume?: string;
  env?: Readonly<Record<string, string>>;
  permissionPolicy?: "locally-trusted";
}
export interface ManagedFactory {
  open(options: ManagedOpen): Promise<ManagedSession>;
}

export class ManagedSetupError extends Error {
  readonly code = "setup_required";
}

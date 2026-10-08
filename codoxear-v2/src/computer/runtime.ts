import { type Notification } from "../protocol/notifications.js";
import { type Operation } from "../contracts/tunnel.js";

export interface Runtime {
  readonly kind: "native" | "fixture" | "oar";
  execute(operation: Operation): Promise<unknown>;
  executeWithReceipt?(
    operation: Operation,
    requestId: string,
  ): Promise<unknown>;
  sendQueued?(localId: string, text: string, actorId?: string): Promise<unknown>;
  setQueueScope?(scope: string): void;
  setUnattendedBlocker?(blocker: (localId: string) => boolean): void;
  queueControl?(
    localId: string,
    operation: string,
    body?: Record<string, unknown>,
  ): Promise<any>;
  close(): void | Promise<void>;
  supportsProviderLaunch?(): Promise<boolean>;
  completions?(since: number): Promise<Notification[]>;
}
/** Files, voice and HTTP presentation depend on this surface, not a PTY driver. */
export interface WorkspaceRuntime extends Runtime {
  readonly home: string;
  readonly stateHome: string;
  request(path: string, method?: string, body?: unknown): Promise<any>;
  completions(since: number): Promise<Notification[]>;
}

export const brand: string;
export function escapeHtml(value: unknown): string;
export function stylesheet(path: string): void;
export function appearance(): Promise<unknown>;
export function showAppearance(): Promise<void>;
export function shell(
  root: HTMLElement,
  options: {
    name: string;
    email: string;
    issuer: string;
    agents: unknown[];
    currentHub?: boolean | "workspace";
    onNew: () => void;
  },
): void;
export function placementDialog(
  placements: unknown[],
  proceed: (placement: any, values: any) => Promise<void>,
  options?: import("./agent-creation.js").CreationOptions,
): HTMLDialogElement;

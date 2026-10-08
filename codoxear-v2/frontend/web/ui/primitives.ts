import { installUIStyles } from "./theme.js";

export interface ButtonOptions {
  text: string;
  type?: "button" | "submit" | "reset";
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  label?: string;
  className?: string;
  document?: Document;
  onClick?: (event: MouseEvent) => void;
}
export function createButton(options: ButtonOptions): HTMLButtonElement {
  const document = options.document ?? globalThis.document;
  installUIStyles(document);
  const button = document.createElement("button");
  button.type = options.type ?? "button";
  button.className = `ui-button ui-button--${options.variant ?? "secondary"}${options.className ? ` ${options.className}` : ""}`;
  button.textContent = options.text;
  button.disabled = options.disabled ?? false;
  if (options.label) button.setAttribute("aria-label", options.label);
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export interface InputOptions {
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  document?: Document;
}
export function createInput(options: InputOptions = {}): HTMLInputElement {
  const document = options.document ?? globalThis.document;
  installUIStyles(document);
  const input = document.createElement("input");
  input.className = `ui-input${options.className ? ` ${options.className}` : ""}`;
  input.type = options.type ?? "text";
  input.name = options.name ?? "";
  input.value = options.value ?? "";
  input.placeholder = options.placeholder ?? "";
  input.required = options.required ?? false;
  input.disabled = options.disabled ?? false;
  if (options.label) input.setAttribute("aria-label", options.label);
  return input;
}

export interface DialogOptions {
  title: string;
  className?: string;
  document?: Document;
  onClose?: (returnValue: string) => void;
  closeOnBackdrop?: boolean;
}
export interface Dialog {
  element: HTMLDialogElement;
  body: HTMLElement;
  show(): void;
  close(returnValue?: string): void;
  destroy(): void;
}
let nextDialogId = 0;
/** Native dialog supplies modal focus containment; content, dismissal, and controls are owned here. */
export function createDialog(options: DialogOptions): Dialog {
  const document = options.document ?? globalThis.document;
  installUIStyles(document);
  const element = document.createElement("dialog");
  element.className = `ui-dialog${options.className ? ` ${options.className}` : ""}`;
  const title = document.createElement("h2");
  title.id = `ui-dialog-title-${++nextDialogId}`;
  title.textContent = options.title;
  element.setAttribute("aria-labelledby", title.id);
  const body = document.createElement("div");
  body.className = "ui-dialog-body";
  element.append(title, body);
  let previousFocus: HTMLElement | null = null;
  let destroyed = false;
  const cancel = (event: Event) => event.preventDefault();
  const close = () => {
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    options.onClose?.(element.returnValue);
  };
  const backdrop = (event: MouseEvent) => {
    if (options.closeOnBackdrop === false || event.target !== element) return;
    const rect = element.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) element.close();
  };
  element.addEventListener("cancel", cancel);
  element.addEventListener("close", close);
  element.addEventListener("click", backdrop);
  return { element, body,
    show() {
      if (destroyed || element.open) return;
      previousFocus = document.activeElement instanceof document.defaultView!.HTMLElement ? document.activeElement as HTMLElement : null;
      if (!element.isConnected) document.body.append(element);
      element.showModal();
    },
    close(returnValue = "") { if (element.open) element.close(returnValue); },
    destroy() {
      if (destroyed) return;
      if (element.open) element.close();
      destroyed = true;
      element.removeEventListener("cancel", cancel); element.removeEventListener("close", close); element.removeEventListener("click", backdrop);
      element.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    },
  };
}

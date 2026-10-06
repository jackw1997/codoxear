import { brand } from "../shared/ui.js";

export const loginHeading = (title: string, hint: string) =>
  `<div class="connectionBrand">${brand}</div><div class="connectionLoginHeading"><h1>${esc(title)}</h1><p class="connectionHint">${esc(hint)}</p></div>`;

export const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const paths: Record<string, string> = {
  back: '<path d="m14 6-6 6 6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  hub: '<rect x="4" y="3" width="16" height="7" rx="1"/><rect x="4" y="14" width="16" height="7" rx="1"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/>',
  computer:
    '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8M12 17v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
export const icon = (name: string, extra = "") =>
  `<svg class="connectionIcon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.chevron}</svg>`;
export const field = (label: string, input: string) =>
  `<label class="connectionField"><span>${esc(label)}</span>${input}</label>`;
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Separate in-app pages preserve the mounted conversation and its draft. */
export class ConnectionPages {
  readonly element = document.createElement("dialog");
  private priorFocus = document.activeElement as HTMLElement | null;
  private app = document.querySelector<HTMLElement>("#root");
  private previousInert = this.app?.inert ?? false;
  version = 0;
  constructor() {
    this.element.className = "connectionPage";
    this.element.role = "dialog";
    this.element.setAttribute("aria-modal", "true");
    this.element.tabIndex = -1;
    if (this.app) this.app.inert = true;
    document.body.append(this.element);
    this.element.showModal();
    this.element.addEventListener("cancel", (event) => event.preventDefault());
    this.render(
      "Hubs & computers",
      '<p class="connectionHint" role="status">Loading…</p>',
      this.close,
    );
    this.element.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = [
        ...this.element.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]",
        ),
      ].filter((n) => n.getClientRects().length);
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    });
  }
  render(title: string, body: string, back: () => void, action = "") {
    this.version++;
    this.element.setAttribute("aria-label", title);
    this.element.innerHTML = `<div class="connectionPanel"><header class="connectionHeader"><div class="connectionHeaderInner"><button class="connectionIconButton" data-back aria-label="Back">${icon("back")}</button><h1 tabindex="-1">${esc(title)}</h1>${action}</div></header><div class="connectionBody"><div class="connectionStack">${body}<p role="alert" class="connectionError"></p></div></div></div>`;
    this.element.querySelector<HTMLButtonElement>("[data-back]")!.onclick =
      back;
    this.element.querySelector<HTMLElement>("h1")!.focus();
    return this.element;
  }
  error = (error: unknown) => {
    const el = this.element.querySelector<HTMLElement>("[role=alert]");
    if (el) el.textContent = message(error);
  };
  close = () => {
    this.version++;
    this.element.close();
    this.element.remove();
    if (this.app) this.app.inert = this.previousInert;
    this.priorFocus?.focus();
  };
}
export function submit(
  form: HTMLFormElement,
  action: (data: FormData) => Promise<void>,
  error: (e: unknown) => void,
) {
  form.onsubmit = (e) => {
    e.preventDefault();
    const button = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    if (button.disabled) return;
    button.disabled = true;
    const alert = form
      .closest(".connectionPage, .connectionLogin")
      ?.querySelector("[role=alert]");
    if (alert) alert.textContent = "";
    form.setAttribute("aria-busy", "true");
    void action(new FormData(form))
      .catch(error)
      .finally(() => {
        button.disabled = false;
        form.removeAttribute("aria-busy");
      });
  };
}

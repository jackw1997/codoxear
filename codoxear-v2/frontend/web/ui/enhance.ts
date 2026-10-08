import { getDropdown, mountDropdown, type Dropdown } from "./dropdown.js";
import { installUIStyles } from "./theme.js";

export interface UIEnhancement {
  refresh(): void;
  destroy(): void;
}

/** Adopt ordinary page controls while retaining their DOM identity and existing handlers. */
export function enhanceUI(root: ParentNode = document): UIEnhancement {
  const document = root.nodeType === 9 ? root as Document : (root as Node).ownerDocument!;
  const window = document.defaultView!;
  installUIStyles(document);
  const dropdowns = new Map<HTMLSelectElement, Dropdown>();
  const classes = new Map<Element, string>();
  const dialogs = new Map<HTMLDialogElement, EventListener>();
  let destroyed = false;
  function collect<T extends Element>(selector: string): T[] {
    const nodes = Array.from(root.querySelectorAll<T>(selector));
    if (root instanceof window.Element && root.matches(selector)) nodes.unshift(root as T);
    return nodes;
  }
  // Embedded editors own their hidden text/input surfaces and their geometry.
  function editorControl(node: Element): boolean {
    return !!node.closest(".monaco-editor,.monaco-diff-editor,.monaco-component,.edit-context,[editcontext],edit-context");
  }
  function scan(refreshDropdowns = false) {
    if (destroyed) return;
    for (const [select, dropdown] of dropdowns) {
      if (!(root as Node).contains(select) || select.parentElement !== dropdown.element) {
        dropdown.destroy(); dropdowns.delete(select);
      } else if (refreshDropdowns) dropdown.refresh();
    }
    for (const select of collect<HTMLSelectElement>("select")) {
      if (editorControl(select) || select.dataset.uiNative === "true" || getDropdown(select)) continue;
      dropdowns.set(select, mountDropdown(select));
    }
    for (const [selector, className] of [["button", "ui-button"], ["input,textarea", "ui-input"], ["dialog", "ui-dialog"]] as const) {
      for (const node of collect<Element>(selector)) {
        if (editorControl(node)) continue;
        if (node.classList.contains(className)) continue;
        node.classList.add(className); classes.set(node, className);
      }
    }
    for (const dialog of collect<HTMLDialogElement>("dialog")) {
      if (dialogs.has(dialog)) continue;
      const cancel: EventListener = (event) => event.preventDefault();
      dialog.addEventListener("cancel", cancel); dialogs.set(dialog, cancel);
    }
    for (const [node] of classes) if (!(root as Node).contains(node)) classes.delete(node);
    for (const [dialog, cancel] of dialogs) if (!(root as Node).contains(dialog)) {
      dialog.removeEventListener("cancel", cancel); dialogs.delete(dialog);
    }
  }
  scan();
  const observer = new window.MutationObserver((records) => {
    // Rendering an owned listbox must never retrigger whole-page enhancement.
    if (records.some((record) => {
      const target = record.target instanceof window.Element ? record.target : record.target.parentElement;
      if (target && editorControl(target)) return false;
      if (target?.closest(".ui-dropdown")) return false;
      return record.type === "childList" || (record.type === "attributes" && target?.tagName === "FIELDSET");
    })) scan(records.some((record) => record.type === "attributes"));
  });
  observer.observe(root as Node, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  return {
    refresh() { scan(true); },
    destroy() {
      if (destroyed) return;
      destroyed = true; observer.disconnect();
      dropdowns.forEach((dropdown) => dropdown.destroy()); dropdowns.clear();
      classes.forEach((className, node) => node.classList.remove(className)); classes.clear();
      dialogs.forEach((cancel, dialog) => dialog.removeEventListener("cancel", cancel)); dialogs.clear();
    },
  };
}

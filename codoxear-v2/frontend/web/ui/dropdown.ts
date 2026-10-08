import { installUIStyles } from "./theme.js";

export interface DropdownOptions {
  placeholder?: string;
  label?: string;
  variant?: "field" | "inline";
  className?: string;
}
export interface Dropdown {
  element: HTMLElement;
  trigger: HTMLButtonElement;
  refresh(): void;
  open(): void;
  close(): void;
  destroy(): void;
}
const mounted = new WeakMap<HTMLSelectElement, Dropdown>();
let nextId = 0;

export function getDropdown(select: HTMLSelectElement): Dropdown | undefined {
  return mounted.get(select);
}

/** Keep the native select as the form and legacy-controller value authority. */
export function mountDropdown(select: HTMLSelectElement, options: DropdownOptions = {}): Dropdown {
  const existing = mounted.get(select);
  if (existing) return existing;
  const document = select.ownerDocument;
  const window = document.defaultView!;
  installUIStyles(document);
  const element = document.createElement("span");
  element.className = `ui-dropdown ui-dropdown--${options.variant ?? "field"}${options.className ? ` ${options.className}` : ""}`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ui-button ui-dropdown-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "ui-dropdown-label";
  const arrow = document.createElement("span");
  arrow.className = "ui-dropdown-arrow";
  arrow.setAttribute("aria-hidden", "true");
  trigger.append(label, arrow);
  const popup = document.createElement("div");
  popup.id = `ui-listbox-${++nextId}`;
  popup.className = "ui-listbox";
  popup.setAttribute("role", "listbox");
  trigger.setAttribute("aria-controls", popup.id);
  let usesPopover = typeof popup.showPopover === "function";
  if (usesPopover) popup.setAttribute("popover", "manual");
  const originalTabIndex = select.getAttribute("tabindex");
  const originalAriaHidden = select.getAttribute("aria-hidden");
  const hadNativeClass = select.classList.contains("ui-native-select");
  select.before(element);
  element.append(trigger, select, popup);
  select.classList.add("ui-native-select");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  let opened = false;
  let destroyed = false;
  let active = -1;
  let typed = "";
  let typedAt = 0;
  let nodes: HTMLElement[] = [];
  let observedOptions = new Set<HTMLOptionElement>();
  const restoreProperties: (() => void)[] = [];
  const optionRestores = new Map<HTMLOptionElement, (() => void)[]>();
  const removers: (() => void)[] = [];
  function listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture);
    removers.push(() => target.removeEventListener(type, listener, capture));
  }
  function mirrorProperty(target: object, property: string, after: () => void): () => void {
    const original = Object.getOwnPropertyDescriptor(target, property);
    let prototype: object | null = target;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    if (!descriptor?.get || !descriptor.set || original?.configurable === false) return () => {};
    const get = descriptor.get, set = descriptor.set;
    Object.defineProperty(target, property, { configurable: true, enumerable: descriptor.enumerable ?? true,
      get() { return get.call(this); },
      set(value: unknown) { set.call(this, value); after(); },
    });
    return () => { if (original) Object.defineProperty(target, property, original); else Reflect.deleteProperty(target, property); };
  }
  function isDisabled(option: HTMLOptionElement): boolean {
    return option.disabled || (option.parentElement?.tagName === "OPTGROUP" && (option.parentElement as HTMLOptGroupElement).disabled);
  }
  function enabledIndices(): number[] {
    return Array.from(select.options).flatMap((option, index) => isDisabled(option) || option.hidden ? [] : [index]);
  }
  function setActive(index: number, scroll = true) {
    active = index;
    nodes.forEach((node, nodeIndex) => node.toggleAttribute("data-active", nodeIndex === active));
    const node = nodes[active];
    if (node && opened) {
      trigger.setAttribute("aria-activedescendant", node.id);
      if (scroll) node.scrollIntoView({ block: "nearest" });
    } else trigger.removeAttribute("aria-activedescendant");
  }
  function position() {
    if (!opened) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const height = viewport?.height ?? window.innerHeight;
    const width = viewport?.width ?? window.innerWidth;
    const lower = viewportTop + height - rect.bottom - 8;
    const upper = rect.top - viewportTop - 8;
    const below = lower >= Math.min(popup.scrollHeight, 220) || lower >= upper;
    const maxHeight = Math.max(44, Math.min(360, below ? lower : upper));
    const popupWidth = Math.min(Math.max(rect.width, 180), width - 16);
    popup.style.width = `${popupWidth}px`;
    popup.style.maxHeight = `${maxHeight}px`;
    popup.style.left = `${Math.max(viewportLeft + 8, Math.min(rect.left, viewportLeft + width - popupWidth - 8))}px`;
    popup.style.top = `${below ? rect.bottom + 4 : Math.max(viewportTop + 8, rect.top - Math.min(popup.scrollHeight, maxHeight) - 4)}px`;
  }
  function close(restoreFocus = false) {
    if (!opened) return;
    opened = false;
    typed = "";
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (usesPopover) { try { popup.hidePopover(); } catch { /* A detached control has no active top layer. */ } }
    popup.removeAttribute("data-open");
    if (restoreFocus && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
  }
  function refresh() {
    if (destroyed) return;
    const all = Array.from(select.options);
    const selected = all.filter((option) => option.selected);
    label.textContent = selected.map((option) => option.label).join(", ") || options.placeholder || "Choose…";
    const disabled = select.matches(":disabled");
    trigger.disabled = disabled;
    trigger.title = select.title;
    element.classList.toggle("ui-dropdown-data", /model/i.test(select.name + " " + select.id));
    trigger.tabIndex = originalTabIndex === null ? 0 : Number(originalTabIndex);
    trigger.setAttribute("aria-required", String(select.required));
    if (select.getAttribute("aria-invalid")) trigger.setAttribute("aria-invalid", select.getAttribute("aria-invalid")!);
    else if (select.validity.valid) trigger.removeAttribute("aria-invalid");
    for (const attribute of ["aria-label", "aria-labelledby", "aria-describedby"]) {
      const value = attribute === "aria-label" && options.label ? options.label : select.getAttribute(attribute);
      if (value) trigger.setAttribute(attribute, value); else trigger.removeAttribute(attribute);
    }
    if (!trigger.hasAttribute("aria-label") && !trigger.hasAttribute("aria-labelledby")) {
      const labels = Array.from(select.labels ?? []);
      if (labels.length) {
        const names = labels.map((nativeLabel) => {
          const clone = nativeLabel.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("select,.ui-dropdown,button,input").forEach((node) => node.remove());
          return clone.textContent?.trim() ?? "";
        }).filter(Boolean);
        if (names.length) trigger.setAttribute("aria-label", names.join(" "));
      }
    }
    element.hidden = select.hidden || select.style.display === "none";
    for (const property of ["width", "min-width", "max-width", "flex", "flex-grow", "flex-shrink", "flex-basis", "grid-column", "margin", "margin-left", "margin-right"]) {
      element.style.setProperty(property, select.style.getPropertyValue(property));
    }
    popup.setAttribute("aria-label", options.label ?? trigger.getAttribute("aria-label") ?? "Choices");
    if (select.multiple) popup.setAttribute("aria-multiselectable", "true"); else popup.removeAttribute("aria-multiselectable");
    for (const option of observedOptions) if (!all.includes(option)) {
      optionRestores.get(option)?.forEach((restore) => restore());
      optionRestores.delete(option);
    }
    for (const option of all) if (!observedOptions.has(option)) {
      optionRestores.set(option, [mirrorProperty(option, "selected", refresh)]);
    }
    observedOptions = new Set(all);
    nodes = [];
    popup.replaceChildren();
    let group: HTMLElement | null = null;
    all.forEach((option, index) => {
      const parent = option.parentElement;
      if (parent?.tagName === "OPTGROUP" && parent !== group) {
        const heading = document.createElement("div");
        heading.className = "ui-option-group";
        heading.textContent = (parent as HTMLOptGroupElement).label;
        popup.append(heading);
      }
      group = parent;
      const node = document.createElement("div");
      node.id = `${popup.id}-option-${index}`;
      node.className = "ui-option";
      node.setAttribute("role", "option");
      node.setAttribute("aria-selected", String(option.selected));
      node.setAttribute("aria-disabled", String(isDisabled(option)));
      node.hidden = option.hidden;
      node.dataset.index = String(index);
      node.textContent = option.label;
      nodes.push(node);
      popup.append(node);
    });
    if (!all.length) {
      const empty = document.createElement("div"); empty.className = "ui-option-empty";
      empty.textContent = "No choices available"; popup.append(empty);
    }
    if (disabled || element.hidden) close();
    const enabled = enabledIndices();
    setActive(enabled.includes(active) ? active : enabled.includes(select.selectedIndex) ? select.selectedIndex : (enabled[0] ?? -1), false);
    position();
  }
  function open() {
    refresh();
    if (destroyed || trigger.disabled || element.hidden || !element.isConnected || opened) return;
    opened = true;
    popup.setAttribute("data-open", "");
    trigger.setAttribute("aria-expanded", "true");
    if (usesPopover) {
      try { popup.showPopover(); } catch { usesPopover = false; popup.removeAttribute("popover"); }
    }
    position();
    setActive(active);
    trigger.focus({ preventScroll: true });
  }
  function choose(index: number) {
    const option = select.options[index];
    if (!option || isDisabled(option) || option.hidden || trigger.disabled || select.matches(":disabled")) return;
    const old = Array.from(select.selectedOptions).map((item) => item.index).join(",");
    if (select.multiple) option.selected = !option.selected;
    else select.selectedIndex = index;
    refresh();
    if (!select.multiple) close(true);
    const current = Array.from(select.selectedOptions).map((item) => item.index).join(",");
    if (old !== current) {
      select.dispatchEvent(new window.Event("input", { bubbles: true }));
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      refresh();
    }
  }
  function keydown(event: KeyboardEvent) {
    if (document.activeElement !== trigger || event.ctrlKey || event.metaKey || event.altKey) return;
    const keys = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"];
    if (event.key === "Tab") { close(); return; }
    if (!keys.includes(event.key) && event.key.length !== 1) return;
    if (event.key === "Escape" && !opened) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    if (event.key === "Escape") { close(true); return; }
    if (event.key === "Enter" || (event.key === " " && (!typed || Date.now() - typedAt > 700))) {
      if (opened) choose(active); else open(); return;
    }
    const wasOpen = opened;
    open();
    const enabled = enabledIndices();
    const current = enabled.indexOf(active);
    if (event.key === "ArrowDown") setActive(enabled[Math.min(enabled.length - 1, current + (wasOpen ? 1 : 0))] ?? -1);
    else if (event.key === "ArrowUp") setActive(enabled[Math.max(0, current - (wasOpen ? 1 : 0))] ?? -1);
    else if (event.key === "Home") setActive(enabled[0] ?? -1);
    else if (event.key === "End") setActive(enabled.at(-1) ?? -1);
    else if (event.key.length === 1) {
      const now = Date.now();
      typed = now - typedAt > 700 ? event.key : typed + event.key;
      typedAt = now;
      const query = (new Set(typed.toLowerCase()).size === 1 ? typed[0]! : typed).toLocaleLowerCase();
      const start = query.length === 1 ? current + 1 : Math.max(0, current);
      const indices = [...enabled.slice(start), ...enabled.slice(0, start)];
      const match = indices.find((index) => select.options[index]!.label.trim().toLocaleLowerCase().startsWith(query));
      if (match !== undefined) setActive(match);
    }
  }
  listen(trigger, "click", () => { if (opened) close(true); else open(); });
  listen(popup, "pointerdown", (event) => event.preventDefault());
  listen(popup, "click", (event) => {
    // A popup inside a wrapping label must not forward activation to its trigger.
    event.preventDefault();
    event.stopPropagation();
    const node = (event.target as Element).closest<HTMLElement>(".ui-option");
    if (node?.dataset.index !== undefined) choose(Number(node.dataset.index));
  });
  listen(popup, "pointermove", (event) => {
    const node = (event.target as Element).closest<HTMLElement>(".ui-option");
    if (node?.dataset.index !== undefined && node.getAttribute("aria-disabled") !== "true") setActive(Number(node.dataset.index), false);
  });
  listen(document, "keydown", (event) => keydown(event as KeyboardEvent), true);
  listen(document, "pointerdown", (event) => { if (!element.contains(event.target as Node)) close(); }, true);
  listen(document, "focusin", (event) => { if (opened && !element.contains(event.target as Node)) close(); });
  listen(window, "resize", position);
  listen(document, "scroll", (event) => { if (!popup.contains(event.target as Node)) position(); }, true);
  if (window.visualViewport) { listen(window.visualViewport, "resize", position); listen(window.visualViewport, "scroll", position); }
  listen(select, "input", refresh); listen(select, "change", refresh);
  // Label activation must reach our trigger, including labels linked by `for`.
  for (const nativeLabel of Array.from(select.labels ?? [])) listen(nativeLabel, "click", (event) => {
    const target = event.target as Node;
    if (trigger.contains(target) || popup.contains(target) || (target instanceof window.Element && target.closest("button,a,input,textarea"))) return;
    event.preventDefault();
    if (!trigger.disabled) trigger.focus({ preventScroll: true });
  });
  listen(select, "focus", () => trigger.focus({ preventScroll: true }));
  listen(select, "invalid", (event) => {
    event.preventDefault(); trigger.setAttribute("aria-invalid", "true"); trigger.focus();
  });
  if (select.form) listen(select.form, "reset", () => queueMicrotask(refresh));
  for (const property of ["value", "selectedIndex", "disabled", "required", "multiple"]) restoreProperties.push(mirrorProperty(select, property, refresh));
  const focusDescriptor = Object.getOwnPropertyDescriptor(select, "focus");
  Object.defineProperty(select, "focus", { configurable: true, value: (focusOptions?: FocusOptions) => trigger.focus(focusOptions) });
  restoreProperties.push(() => { if (focusDescriptor) Object.defineProperty(select, "focus", focusDescriptor); else Reflect.deleteProperty(select, "focus"); });
  const observer = new window.MutationObserver(refresh);
  observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true });
  const dropdown: Dropdown = { element, trigger, refresh, open, close: () => close(), destroy() {
    if (destroyed) return;
    close(); destroyed = true; observer.disconnect(); removers.forEach((remove) => remove());
    restoreProperties.forEach((restore) => restore()); optionRestores.forEach((restores) => restores.forEach((restore) => restore()));
    if (!hadNativeClass) select.classList.remove("ui-native-select");
    if (originalTabIndex === null) select.removeAttribute("tabindex"); else select.setAttribute("tabindex", originalTabIndex);
    if (originalAriaHidden === null) select.removeAttribute("aria-hidden"); else select.setAttribute("aria-hidden", originalAriaHidden);
    if (select.parentNode === element) { if (element.parentNode) element.replaceWith(select); else select.remove(); }
    else element.remove();
    mounted.delete(select);
  } };
  mounted.set(select, dropdown);
  refresh();
  return dropdown;
}

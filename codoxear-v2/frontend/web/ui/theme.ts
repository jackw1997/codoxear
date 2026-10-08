/** Shared control structure. Page appearance tokens remain the color/geometry authority. */
export const sharedThemeCSS = `
.ui-button,.ui-input,.ui-dropdown,.ui-dialog {box-sizing:border-box;font-family:var(--font-ui);}
:where(.ui-button) {min-height:var(--ctl-chrome,32px);background:var(--paper);border:1px solid var(--border);border-radius:var(--radius-control);padding:var(--space-4) var(--space-5);}
.ui-button {position:relative;cursor:pointer;touch-action:manipulation;color:var(--text);font:var(--font-md)/1.4 var(--font-ui);}
/* Compact icon/chip controls retain their existing 44px hit areas. */
.ui-button:where(:not(.icon-btn,.agentBackendTab,.choiceChip,.ui-dropdown-trigger)) {min-height:44px;}
.ui-button:disabled {cursor:default;color:var(--text-soft);}
.ui-button:focus-visible,.ui-input:focus-visible {outline:2px solid var(--focus-ring);outline-offset:2px;}
.ui-button--primary {background:var(--accent);color:var(--on-accent);border:1px solid var(--accent);border-radius:var(--radius-control);padding:var(--space-3) var(--space-5);}
.ui-button--secondary {background:var(--paper);border:1px solid var(--hairline);border-radius:var(--radius-control);padding:var(--space-3) var(--space-5);}
.ui-button--ghost {background:transparent;border:1px solid transparent;border-radius:var(--radius-control);padding:var(--space-3);}
.ui-button--ghost:hover {background:var(--wash);}
.ui-input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden]) {color:var(--text);background:var(--paper);border:1px solid var(--hairline);border-radius:var(--radius-control);font:inherit;min-width:0;max-width:100%;padding:var(--space-4) var(--space-5);}
.ui-input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]) {min-height:var(--dialog-control-h,32px);}
.ui-dropdown {position:relative;display:inline-flex;vertical-align:middle;min-width:0;max-width:100%;}
.ui-dropdown[hidden] {display:none!important;}
.ui-dropdown--field {width:100%;}
.ui-dropdown-trigger {display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);width:100%;min-width:0;min-height:44px;text-align:left;background:var(--paper);border:1px solid var(--hairline);border-radius:var(--radius-control);padding:var(--space-3) var(--space-4);font:var(--font-md)/1.4 var(--font-ui);}
.ui-dropdown--inline .ui-dropdown-trigger {width:auto;background:transparent;border-color:transparent;padding:var(--space-1) var(--space-2);font:inherit;}
.ui-dropdown--inline .ui-dropdown-trigger:hover {background:var(--wash);}
.ui-dropdown-label {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.ui-dropdown-data .ui-dropdown-label,.ui-dropdown-data .ui-option {font-family:var(--font-mono);}
.ui-dropdown-arrow {width:8px;height:8px;flex:none;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:translateY(-2px) rotate(45deg);pointer-events:none;}
.ui-dropdown-trigger[aria-expanded=true] .ui-dropdown-arrow {transform:translateY(2px) rotate(225deg);}
.ui-dropdown-trigger[aria-invalid=true] {border-color:var(--danger);}
/* Backing form controls cannot paint or open an OS menu, even under mobile select rules. */
:root .ui-dropdown > select.ui-native-select {display:none!important;position:absolute!important;width:1px!important;min-width:0!important;max-width:1px!important;height:1px!important;min-height:0!important;max-height:1px!important;padding:0!important;border:0!important;margin:0!important;overflow:hidden!important;clip-path:inset(50%)!important;opacity:0!important;pointer-events:none!important;}
.ui-listbox {position:fixed;inset:auto;margin:0;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:3px;background:var(--paper);color:var(--text);border:1px solid var(--hairline);border-radius:var(--radius-card);box-shadow:var(--shadow-pop);font:var(--font-md)/1.4 var(--font-ui);z-index:2147483000;}
.ui-listbox:not([data-open]) {display:none!important;}
.ui-listbox::backdrop,.ui-dialog::backdrop {background:transparent;}
.ui-option {position:relative;display:flex;align-items:center;gap:var(--space-3);box-sizing:border-box;min-height:44px;padding:var(--space-3) var(--space-4);cursor:pointer;border-radius:var(--radius-control);overflow-wrap:anywhere;}
.ui-option[aria-selected=true] {font-weight:600;background:var(--accent-weak);}
.ui-option[data-active] {outline:2px solid var(--focus-ring);outline-offset:-2px;}
.ui-option:hover:not([aria-disabled=true]) {background:var(--wash);}
.ui-option[aria-disabled=true] {color:var(--text-soft);cursor:default;}
.ui-option[hidden] {display:none!important;}
.ui-option-group {padding:var(--space-3) var(--space-4);color:var(--text-soft);font-size:var(--font-sm);font-weight:600;}
.ui-option-empty {padding:var(--space-4);color:var(--text-soft);}
.ui-dialog {max-width:min(640px,calc(100vw - 2 * var(--space-7)));max-height:calc(100dvh - 2 * var(--space-7));overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;color:var(--text);background:var(--paper);border:1px solid var(--hairline);border-radius:var(--radius-card);box-shadow:var(--shadow-pop);padding:var(--space-7);}
.ui-dialog-body {overflow:auto;min-height:0;padding:3px;padding-right:var(--space-3);scrollbar-gutter:stable;}
@media(max-width:880px),(pointer:coarse) {
  .ui-dropdown-trigger,.ui-input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]) {min-height:44px;font-size:var(--font-xl);}
  .ui-dropdown--inline .ui-dropdown-trigger {font-size:inherit;}
  .ui-listbox {font-size:var(--font-xl);}
}
`;

export function installUIStyles(document: Document = globalThis.document): void {
  if (document.getElementById("codoxear-ui-components")) return;
  const style = document.createElement("style");
  style.id = "codoxear-ui-components";
  style.textContent = sharedThemeCSS;
  (document.head ?? document.documentElement).append(style);
}

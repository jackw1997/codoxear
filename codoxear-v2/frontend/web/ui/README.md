# Codoxear UI

Owned TypeScript browser controls shared by the client, workspace, account and Hub sign-in pages. This library has no Hub, Computer, runtime, provider or account imports. Pages supply labels, values, events and existing appearance tokens; controls never fetch catalogs, choose model defaults or save agent settings.

`mountDropdown(select, options)` provides a visible combobox and a Codoxear listbox. The native select is a hidden form backing value, not the visible menu. `variant: "inline"` makes the current value itself the control; the field variant fits ordinary forms. Options, disabled states, optgroups, FormData, programmatic page updates and required validation are preserved. Keyboard navigation, focus restoration and viewport positioning live here once.

`createButton`, `createInput` and `createDialog` own control creation and presentation. `enhanceUI(root)` adopts existing page controls and later-rendered forms without replacing their handlers. Dispose the returned controller when the page/root is removed. New settings controls use the primitives directly.

`theme.ts` is the single shared presentation source. It consumes existing appearance tokens and installs one stylesheet per document. The stylesheet is bundled with page code, so immutable asset hashes change when controls change. Pages should compose layout, not duplicate menu/control skins.

Docker browser verification: `node --import tsx scripts/browser-ui-components.ts`. These controlled component fixtures test interaction contracts; customer acceptance is separately exercised through the production frontend and Hub/Computer transport.

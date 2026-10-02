# Theme-aware controls

Use app-owned controls here for reusable form behavior and appearance. Pass the current `Palette` from the page; do not derive colors from the OS theme. `model/Theme.ets` supplies Paper, Clay, and Slate in light and dark modes from the shared web theme tokens.

## ThemeDropdown

The trigger, chevron, scrollable option list, selection mark, focus border, and option backgrounds are rendered by this component. `bindPopup` supplies placement and outside/Back dismissal only; no native Select or Menu is used.

```ts
ThemeDropdown({
  colors: this.colors,
  controlId: 'reasoning-effort',
  label: 'Reasoning effort',
  options: ['low', 'medium', 'high'],
  value: this.effort,
  onSelect: (_index: number, value: string) => { this.effort = value; }
})
```

- `value` is controlled by the caller. Opening or dismissing never commits a change.
- Supply `selectedIndex` when labels can repeat; the callback preserves the option index.
- Empty options and `disabled` disable the trigger. `placeholder` handles unset values.
- Palette tokens govern text, muted icon, surface, selected foreground/background, focus, hover, borders and corner radius; Paper stays square, Clay and Slate retain their own geometry.
- Options scroll after six rows. Long labels truncate without widening the viewport.
- Touch/pointer selection, focus, Enter/Space, arrow-key movement, Escape, and outside dismissal share the same state.

Keep domain-specific API calls outside the component. New controls should use the same Palette contract, and actual device interaction should verify theme and behavior together.

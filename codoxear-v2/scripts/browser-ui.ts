import assert from 'node:assert/strict';
import type { Locator } from '@playwright/test';

/** Read the form backing value; all selections below go through the visible owned menu. */
export const nativeSelect = (control: Locator): Locator => control.locator('xpath=self::select').first();
export async function chooseDropdown(control: Locator, value: string | { label: string }): Promise<void> {
  const select = nativeSelect(control);
  await select.waitFor({ state: 'attached' });
  const findOption = () => select.evaluate((node, requested) => {
    const options = Array.from((node as HTMLSelectElement).options);
    const row = options.find(option => typeof requested === 'string' ? option.value === requested : option.label === requested.label);
    return row ? { index: row.index, disabled: row.disabled || (row.parentElement?.tagName === 'OPTGROUP' && (row.parentElement as HTMLOptGroupElement).disabled), value: row.value } : null;
  }, value);
  let option = await findOption();
  const deadline = Date.now() + 10000;
  while (!option && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 30)); option = await findOption(); }
  assert.ok(option, `Expected option ${JSON.stringify(value)} exists`);
  assert.equal(option.disabled, false, 'Customer can only select an enabled option');
  const wrapper = select.locator('..');
  const trigger = wrapper.getByRole('combobox');
  await trigger.waitFor({ state: 'visible' });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const choice = wrapper.locator(`.ui-listbox .ui-option[data-index="${option.index}"]`);
  await choice.scrollIntoViewIfNeeded();
  await choice.click();
  assert.equal(await select.inputValue(), option.value, 'Owned menu updates the actual form value');
}

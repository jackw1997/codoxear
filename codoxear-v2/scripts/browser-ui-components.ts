// @ts-nocheck -- Controlled browser fixtures use their dynamic Playwright contracts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import Fastify from "fastify";

assert.ok(existsSync("/.dockerenv"), "UI component browser verification must run in Docker");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const temporary = await mkdtemp(join(tmpdir(), "codoxear-ui-components-"));
const artifacts = join(process.cwd(), "artifacts", "ui-components");
await mkdir(artifacts, { recursive: true });
const checks = [], errors = [];
let browser, context, page, passed = false;
const app = Fastify();
const fixture = `
import { enhanceUI, getDropdown, mountDropdown, createButton, createInput, createDialog } from './frontend/web/ui/index.ts';
const root = document.querySelector('#fixture');
const select = document.querySelector('#choice');
let inputs = 0, changes = 0, submissions = 0, invalid = 0;
const events = document.querySelector('#events');
const status = () => events.textContent = JSON.stringify({inputs, changes, value:select.value});
select.addEventListener('input', () => { inputs++; status(); });
select.addEventListener('change', () => { changes++; status(); });
const form = document.querySelector('#values');
form.addEventListener('submit', event => { event.preventDefault(); document.querySelector('#form-data').textContent = JSON.stringify(Object.fromEntries(new FormData(form))); });
const required = document.querySelector('#required-form');
const requiredStatus = () => document.querySelector('#validation').textContent = JSON.stringify({submissions, invalid});
required.addEventListener('submit', event => { event.preventDefault(); submissions++; requiredStatus(); });
required.addEventListener('invalid', () => { invalid++; requiredStatus(); }, true);
document.querySelector('#long-choice').append(...Array.from({length:60}, (_,index) => new Option('Model '+String(index+1).padStart(2,'0'), 'model-'+(index+1))));
const enhancer = enhanceUI(document);
const primitiveInput = createInput({name:'primitive', label:'Owned text field', value:'Owned input'});
primitiveInput.id = 'primitive-input';
root.append(primitiveInput, createButton({text:'Owned action', onClick:()=>document.querySelector('#primitive-result').textContent='clicked'}));
const dialog = createDialog({title:'Owned dialog'});
dialog.body.innerHTML = '<label>Dialog choice<select id="dialog-choice" aria-label="Dialog choice"><option>One</option><option>Two</option></select></label>';
dialog.body.append(createButton({text:'Close dialog', onClick:()=>dialog.close()}));
root.append(createButton({text:'Open dialog', onClick:()=>dialog.show()}));
const action = (id, fn) => document.getElementById(id).onclick = fn;
action('set-value', ()=>{ select.value='beta'; status(); });
action('set-index', ()=>{ select.selectedIndex=3; status(); });
action('set-option', ()=>{ select.options[0].selected=true; status(); });
action('replace-options', ()=>{ select.replaceChildren(); select.add(new Option('Replacement one','replacement-one')); select.add(new Option('Replacement two','replacement-two')); select.value='replacement-two'; status(); });
action('toggle-disabled', ()=>{ const fieldset=document.querySelector('#choices-fieldset'); fieldset.disabled=!fieldset.disabled; });
action('disable-option', ()=>{ select.options[1].disabled=true; });
action('light-theme', ()=>document.documentElement.dataset.mode='light');
action('dark-theme', ()=>document.documentElement.dataset.mode='dark');
let removedSelect, removedDropdown;
action('render-dynamic', ()=>{ const target=document.querySelector('#dynamic'); target.innerHTML='<label>Dynamic choice<select aria-label="Dynamic choice"><option value="first">First dynamic</option><option value="second">Second dynamic</option></select></label>'; });
action('remove-dynamic', ()=>{ removedSelect=document.querySelector('#dynamic select'); removedDropdown=removedSelect&&getDropdown(removedSelect); removedDropdown?.close(); document.querySelector('#dynamic').replaceChildren(); });
action('probe-dynamic', ()=>{ removedSelect.value='second'; removedDropdown.trigger.click(); document.querySelector('#dynamic-result').textContent=JSON.stringify({disposed:!getDropdown(removedSelect), value:removedSelect.value, expanded:removedDropdown.trigger.getAttribute('aria-expanded'), ownedValue:Object.hasOwn(removedSelect,'value')}); });
action('repeat-enhance', ()=>{ enhancer.refresh(); mountDropdown(select); document.querySelector('#enhance-result').textContent='refreshed'; });
status(); requiredStatus();
document.body.dataset.ready='true';
`;
const html = `<!doctype html><html lang="en" data-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owned UI controlled fixture</title><style>
:root {--paper:#fff;--bg:#f6f5f1;--wash:#efeee9;--hairline:#dcdad4;--border:#2f2b26;--text:#2f2b26;--text-soft:#6b6862;--accent:#2f2b26;--accent-weak:#efeee9;--on-accent:#fff;--focus-ring:#2f2b26;--danger:#b91c1c;--radius-control:0;--radius-card:0;--font-ui:sans-serif;--font-mono:monospace;--shadow-pop:none;--space-1:4px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--font-sm:12px;--font-md:13px;--font-lg:14px;--font-xl:16px;--ctl-chrome:32px;--dialog-control-h:32px;}
:root[data-mode=dark] {--paper:#212121;--bg:#171717;--wash:#333;--hairline:#555;--border:#aaa;--text:#eee;--text-soft:#bbb;--accent:#eee;--accent-weak:#333;--on-accent:#212121;--focus-ring:#ddd;--radius-control:8px;--radius-card:12px;}
body{margin:0;padding:16px;color:var(--text);background:var(--bg);font:14px/1.4 var(--font-ui);box-sizing:border-box;} main{max-width:680px;} label{display:block;margin:12px 0;} fieldset{min-width:0;margin:0;padding:8px;border:1px solid var(--hairline);} button{margin:6px 4px 6px 0;} output{display:block;overflow-wrap:anywhere;} .fixture-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;} #long-region{margin-top:16px;max-height:90px;overflow:auto;} #long-region label{margin:0;}
</style></head><body><main id="fixture"><h1>Owned controls</h1><p>Controlled fixture: no accounts or credentials.</p>
<form id="values"><fieldset id="choices-fieldset"><label>Choice<select id="choice" name="choice" aria-label="Choice"><option value="alpha">Alpha</option><option value="beta">Beta</option><option value="blocked" disabled>Disabled option</option><option value="gamma">Gamma</option><optgroup label="Disabled group" disabled><option value="group-blocked">Disabled group option</option></optgroup><option value="delta">Delta</option></select></label></fieldset><button type="submit">Read form data</button><button type="reset">Reset choice</button></form><output id="form-data"></output><output id="events"></output>
<div class="fixture-actions"><button id="set-value">Set value</button><button id="set-index">Set index</button><button id="set-option">Set option selected</button><button id="replace-options">Replace options</button><button id="toggle-disabled">Toggle fieldset disabled</button><button id="disable-option">Disable Beta</button><button id="light-theme">Light theme</button><button id="dark-theme">Dark theme</button><button id="repeat-enhance">Repeat enhancement</button></div><output id="enhance-result"></output>
<form id="required-form"><label>Required choice<select required name="required" id="required-choice" aria-label="Required choice"><option value="">Choose a required value</option><option value="valid">Valid</option></select></label><button type="submit">Submit required form</button></form><output id="validation"></output>
<div id="long-region"><label>Long model catalog<select id="long-choice" name="model" aria-label="Long model catalog"></select></label></div>
<div class="fixture-actions"><button id="render-dynamic">Render dynamic control</button><button id="remove-dynamic">Remove dynamic control</button><button id="probe-dynamic">Probe removed control</button></div><div id="dynamic"></div><output id="dynamic-result"></output><output id="primitive-result"></output>
</main><script type="module" src="/fixture.js"></script></body></html>`;

await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: "ui-components-fixture.ts", loader: "ts" }, bundle: true, format: "esm", platform: "browser", target: "es2023", outfile: join(temporary, "fixture.js") });
app.get("/", async (_request, reply) => reply.type("text/html").send(html));
app.get("/fixture.js", async (_request, reply) => reply.type("text/javascript").send(await readFile(join(temporary, "fixture.js"), "utf8")));
const address = await app.listen({ host: "127.0.0.1", port: 0 });
async function load() {
  await page.goto(address);
  await page.locator('body[data-ready="true"]').waitFor();
}
async function check(name, body) {
  try { await load(); await body(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: String(error) }); throw error; }
}
const choice = () => page.getByRole("combobox", { name: "Choice", exact: true });
const selected = async (expected) => assert.equal(await choice().innerText(), expected);
const eventState = async () => JSON.parse(await page.locator("#events").innerText());
const formValue = async () => { await page.getByRole("button", { name: "Read form data" }).click(); return JSON.parse(await page.locator("#form-data").innerText()).choice; };
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  await check("native backing is hidden while owned controls remain accessible", async () => {
    await selected("Alpha");
    assert.equal(await page.getByRole("combobox").count(), 3);
    const backing = await page.locator("#choice").evaluate(select => { const style = getComputedStyle(select), rect = select.getBoundingClientRect(); return { width: rect.width, height: rect.height, opacity: style.opacity, clip: style.clipPath, aria: select.getAttribute("aria-hidden"), tab: select.tabIndex }; });
    assert.ok(backing.width <= 1 && backing.height <= 1);
    assert.equal(backing.opacity, "0"); assert.notEqual(backing.clip, "none"); assert.equal(backing.aria, "true"); assert.equal(backing.tab, -1);
    await choice().click();
    assert.equal(await page.locator(".ui-listbox[data-open] .ui-option").count(), 6);
    assert.equal(await page.getByRole("listbox").count(), 1);
  });
  await check("pointer selection emits one native input/change pair and submits its value", async () => {
    await choice().click(); await page.getByRole("option", { name: "Beta", exact: true }).click();
    await selected("Beta"); assert.deepEqual(await eventState(), { inputs: 1, changes: 1, value: "beta" }); assert.equal(await formValue(), "beta");
    await choice().click(); await page.getByRole("option", { name: "Beta", exact: true }).click(); assert.equal((await eventState()).changes, 1);
  });
  await check("Arrow keys skip disabled options and keyboard Enter commits", async () => {
    await choice().focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await selected("Gamma"); assert.equal((await eventState()).value, "gamma");
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter"); await selected("Beta");
  });
  await check("Home and End navigate enabled choices", async () => {
    await choice().focus(); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await selected("Delta");
    await page.keyboard.press("Home"); await page.keyboard.press("Enter"); await selected("Alpha");
  });
  await check("typeahead selects the matching option", async () => {
    await choice().focus(); await page.keyboard.type("ga"); await page.keyboard.press("Enter"); await selected("Gamma");
  });
  await check("disabled options and disabled groups remain visible and reject clicks", async () => {
    await choice().click();
    for (const name of ["Disabled option", "Disabled group option"]) {
      const item = page.getByRole("option", { name, exact: true }); assert.equal(await item.getAttribute("aria-disabled"), "true");
      await item.click(); await selected("Alpha"); assert.equal((await eventState()).changes, 0); assert.equal(await choice().getAttribute("aria-expanded"), "true");
    }
    await page.keyboard.press("Escape");
  });
  await check("programmatic value, index, and selected-option changes sync without fake change events", async () => {
    await page.getByRole("button", { name: "Set value", exact: true }).click(); await selected("Beta"); assert.equal(await formValue(), "beta");
    await page.getByRole("button", { name: "Set index", exact: true }).click(); await selected("Gamma"); assert.equal(await formValue(), "gamma");
    await page.getByRole("button", { name: "Set option selected" }).click(); await selected("Alpha"); assert.equal(await formValue(), "alpha");
    assert.deepEqual(await eventState(), { inputs: 0, changes: 0, value: "alpha" });
  });
  await check("option replacement and add retain native controller contracts", async () => {
    await page.getByRole("button", { name: "Replace options" }).click(); await selected("Replacement two"); assert.equal(await formValue(), "replacement-two");
    await choice().click(); assert.equal(await page.getByRole("option").count(), 2); await page.getByRole("option", { name: "Replacement one" }).click(); await selected("Replacement one");
  });
  await check("mutating an option's disabled state updates the owned popup", async () => {
    await page.getByRole("button", { name: "Disable Beta" }).click(); await choice().click();
    const beta = page.getByRole("option", { name: "Beta", exact: true }); assert.equal(await beta.getAttribute("aria-disabled"), "true");
    await beta.click(); await selected("Alpha");
  });
  await check("native form reset restores displayed selection without new change events", async () => {
    await page.getByRole("button", { name: "Set value", exact: true }).click(); await selected("Beta");
    await page.getByRole("button", { name: "Reset choice" }).click(); await selected("Alpha"); assert.equal(await formValue(), "alpha"); assert.equal((await eventState()).changes, 0);
  });
  await check("native required validation prevents submission and focuses the owned trigger", async () => {
    await page.getByRole("button", { name: "Submit required form" }).click();
    const requiredChoice = page.getByRole("combobox", { name: "Required choice", exact: true });
    assert.equal(await requiredChoice.evaluate(node => document.activeElement === node), true); assert.equal(await requiredChoice.getAttribute("aria-invalid"), "true");
    assert.deepEqual(JSON.parse(await page.locator("#validation").innerText()), { submissions: 0, invalid: 1 });
    await requiredChoice.click(); await page.getByRole("option", { name: "Valid", exact: true }).click();
    await page.getByRole("button", { name: "Submit required form" }).click(); assert.equal(JSON.parse(await page.locator("#validation").innerText()).submissions, 1);
  });
  await check("disabled fieldset disables the owned control and restores it", async () => {
    await page.getByRole("button", { name: "Toggle fieldset disabled" }).click();
    await page.waitForFunction(() => document.querySelector('#choice').parentElement.querySelector('button').disabled);
    assert.equal(await choice().isDisabled(), true);
    await page.getByRole("button", { name: "Toggle fieldset disabled" }).click(); await choice().click(); assert.equal(await choice().getAttribute("aria-expanded"), "true");
  });
  await check("Escape closes only the dialog's dropdown and restores trigger focus", async () => {
    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Owned dialog" }); const trigger = dialog.getByRole("combobox", { name: "Dialog choice" });
    await trigger.click(); assert.equal(await page.getByRole("listbox").count(), 1); await page.keyboard.press("Escape");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false"); assert.equal(await trigger.evaluate(node => document.activeElement === node), true); assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press("Escape"); assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Close dialog" }).click(); assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Open dialog" }).evaluate(node => document.activeElement === node), true);
  });
  await check("outside click and Tab close transient popups", async () => {
    await choice().click(); await page.getByRole("heading", { name: "Owned controls" }).click(); assert.equal(await choice().getAttribute("aria-expanded"), "false");
    await choice().click(); await page.keyboard.press("Tab"); assert.equal(await choice().getAttribute("aria-expanded"), "false"); assert.equal(await page.getByRole("listbox").count(), 0);
  });
  await check("dynamic controls dispose their adapter and do not retain activation handlers", async () => {
    await page.getByRole("button", { name: "Render dynamic control" }).click();
    const dynamic = page.getByRole("combobox", { name: "Dynamic choice" }); await dynamic.click(); await page.getByRole("option", { name: "Second dynamic" }).click();
    await page.getByRole("button", { name: "Remove dynamic control" }).click(); await page.getByRole("button", { name: "Probe removed control" }).click();
    assert.deepEqual(JSON.parse(await page.locator("#dynamic-result").innerText()), { disposed: true, value: "second", expanded: "false", ownedValue: false });
    assert.equal(await page.getByRole("listbox").count(), 0);
    await page.getByRole("button", { name: "Render dynamic control" }).click(); await page.getByRole("combobox", { name: "Dynamic choice" }).click(); assert.equal(await page.getByRole("option").count(), 2);
  });
  await check("repeated enhancement shares one stylesheet and primitives own actual controls", async () => {
    await page.getByRole("button", { name: "Repeat enhancement" }).click();
    assert.equal(await page.locator('style#codoxear-ui-components').count(), 1); assert.equal(await page.locator('#choice').locator('..').locator('button').count(), 1);
    const input = page.getByRole("textbox", { name: "Owned text field" }); await input.fill("Edited input"); assert.equal(await input.inputValue(), "Edited input");
    await page.getByRole("button", { name: "Owned action" }).click(); assert.equal(await page.locator("#primitive-result").innerText(), "clicked");
    assert.equal(await input.evaluate(node => node.classList.contains('ui-input')), true);
  });
  await check("60-option phone popup remains bounded, scrolls, and uses live theme tokens", async () => {
    const trigger = page.getByRole("combobox", { name: "Long model catalog" }); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
    const popup = page.getByRole("listbox"); const light = await popup.evaluate(node => getComputedStyle(node).backgroundColor);
    const geometry = await popup.evaluate(node => { const rect=node.getBoundingClientRect(); return {x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,scroll:node.scrollHeight,client:node.clientHeight}; });
    assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= 390 && geometry.bottom <= 844, JSON.stringify(geometry)); assert.ok(geometry.scroll > geometry.client);
    await page.keyboard.press("End"); const last = page.getByRole("option", { name: "Model 60", exact: true }); assert.equal(await last.evaluate(node => { const item=node.getBoundingClientRect(),box=node.parentElement.getBoundingClientRect();return item.top >= box.top && item.bottom <= box.bottom; }), true);
    await page.keyboard.press("Enter"); assert.equal(await trigger.innerText(), "Model 60");
    await page.getByRole("button", { name: "Dark theme" }).click(); await trigger.click(); assert.notEqual(await popup.evaluate(node => getComputedStyle(node).backgroundColor), light);
    const touch = await trigger.boundingBox(); assert.ok(touch.height >= 44); assert.equal(await trigger.evaluate(node => getComputedStyle(node.querySelector('.ui-dropdown-label')).fontFamily), "monospace");
    await page.screenshot({ path: join(artifacts, "masked-phone-popup.png"), fullPage: false, mask: [page.locator('input[type="password"]')] });
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Light theme" }).click(); await trigger.click(); assert.equal(await popup.evaluate(node => getComputedStyle(node).backgroundColor), light);
  });
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, checks: checks.length, artifacts }));
} finally {
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ passed, checks, errors, fixture: "Actual source-owned frontend UI library; controlled local fixture; Chromium phone viewport; no provider/customer acceptance claimed." }, null, 2));
  await context?.close(); await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true });
}

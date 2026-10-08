// @ts-nocheck -- Docker-only browser acceptance, controlled OAuth and managed-driver boundary.
import './testing/frontend-artifact.js';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { initializeHub, hubSetup } from '../src/auth/hub-setup.js';
import { independentAuthority } from '../src/hub/independent.js';
import { createHubApp } from '../src/hub/app.js';
import { HubSessions } from '../src/hub/sessions.js';
import { Tunnels } from '../src/protocol/tunnels.js';
import { createComputerApi } from '../src/computer/api.js';
import { ManagedRuntime } from '../src/computer/managed/runtime.js';
import { prepareProfile } from '../src/computer/managed/profiles.js';
import { createStaticServer } from '../frontend/serve.mjs';
process.env.DAILY_EXERCISE ??= '1';
assert.ok(existsSync('/.dockerenv'), 'Customer journey must run in Docker');
const artifacts = process.env.CUSTOMER_JOURNEY_ARTIFACTS ?? '/opt/codoxear/artifacts/customer-journey';
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'customer-journey-'));
const origin = 'http://127.0.0.1:19964', clientOrigin = process.env.CODOXEAR_CUSTOMER_CLIENT_ORIGIN ?? 'http://127.0.0.1:19965';
const store = new Store(':memory:'), sessions = new HubSessions(':memory:'), tunnels = new Tunnels();
// Infrastructure initialization only: no humans, Computers, grants or agents are seeded.
const hubRecord = store.change(state => initializeHub(state, 'customer-hub', 'Customer Hub'));
const initialization = { token: randomUUID() + randomUUID(), expiresAt: Date.now() + 3600000 };
const codes = new Map();
const people = {
  owner: { method: 'google', connection: 'google-controlled', subject: 'owner-verified', tenant: null, email: 'owner@controlled.test', name: 'Journey Owner' },
  member: { method: 'feishu', connection: 'feishu-controlled', subject: 'member-verified', tenant: 'journey-company', email: null, name: 'Journey Member' },
};
const providers = ['google', 'feishu'].map(method => ({
  id: method + '-controlled', method, ...(method === 'feishu' ? { tenant: 'journey-company' } : {}),
  async authorize(state) { return origin + '/controlled-provider?' + new URLSearchParams({ state, method }); },
  async exchange(code) { const identity = codes.get(code); assert.ok(identity && identity.method === method, 'Provider code is single-use and provider-scoped'); codes.delete(code); return identity; },
}));
const authority = await independentAuthority({ origin, hubId: hubRecord.id, store, secureCookies: false,
  setup: hubSetup(store, hubRecord.id, initialization), providers,
  clients: [{ id: 'codoxear-web', redirectUris: [clientOrigin + '/auth-callback'] }] });
const hub = await createHubApp({ origin, authority: authority.client, localIdentity: authority.identity,
  sessions, tunnels, secureCookies: false, clientOrigins: [clientOrigin] });
hub.get('/controlled-provider', async (request, reply) => {
  const { state, method } = request.query;
  const identity = method === 'google' ? 'owner' : 'member';
  return reply.type('text/html').send(`<!doctype html><title>Controlled ${method} provider</title><h1>Controlled ${method} provider</h1><p>Browser fixture; no live provider credentials.</p><form action="/controlled-provider/choose" method="get"><input type="hidden" name="state" value="${state}"><input type="hidden" name="identity" value="${identity}"><button>Sign in as ${people[identity].name}</button></form>`);
});
// Controlled-provider selection is a browser navigation. No token or credential injection.
hub.get('/controlled-provider/choose', async (request, reply) => {
  const identity = people[request.query.identity]; assert.ok(identity);
  const code = randomUUID(); codes.set(code, identity);
  return reply.redirect('/auth/' + identity.connection + '/callback?' + new URLSearchParams({ state: request.query.state, code }));
});
// Controlled provider HTTP boundary only; discovery still traverses the actual authenticated Hub tunnel and Computer fetch.
for (const route of ['/controlled-models/v1/models', '/controlled-models/model_group/info']) {
  hub.get(route, async (request, reply) => {
    if (request.headers.authorization !== 'Bearer controlled-no-live-secret') return reply.code(403).send({ error: 'Controlled caller key required' });
    return route.endsWith('/models')
      ? { data: [{ id: 'journey-model' }, { id: 'journey-model-next' }, { id: 'journey-unknown' }] }
      : { data: [
          { model_group: 'journey-model', supports_reasoning: true, supported_reasoning_efforts: ['low', 'high', 'max'] },
          { model_group: 'journey-model-next', supports_reasoning: true, supported_reasoning_efforts: ['low', 'high', 'max'] },
          { model_group: 'journey-unknown', supports_reasoning: null, supported_reasoning_efforts: null },
        ] };
  });
}
await hub.listen({ host: '127.0.0.1', port: 19964 });
const staticClient = process.env.CODOXEAR_CUSTOMER_CLIENT_ORIGIN ? undefined : createStaticServer();
if (staticClient) await new Promise(resolve => staticClient.listen(19965, '127.0.0.1', resolve));
// Thin deterministic managed transport only; production private-profile preparation runs unchanged. Runtime persistence, queue, authorization,
// files, HTTP relay, Computer service and Hub endpoints remain the production implementations.
const managedInputs = [];
class ControlledManagedSession {
  id; profile; observer; sequence = 0; pendingPrompt;
  capabilities = { images: true, steer: true };
  constructor(id, profile) { this.id = id; this.profile = profile; }
  rawEvents(observer) { this.observer = observer; return () => { this.observer = undefined; }; }
  async prompt(text, options) {
    managedInputs.push({ text, images: (options?.images ?? []).map(image => ({ mediaType: image.mediaType, filename: image.path.split('/').at(-1) })) });
    this.pendingPrompt = setTimeout(() => this.observer?.({ kind: 'frame', seq: this.sequence++, sessionId: this.id,
      receivedAt: Date.now(), agentPath: [], body: { events: [
        { kind: 'text_delta', text: 'Managed response: ' + text },
        { kind: 'turn_ended', outcome: { kind: 'completed' } },
      ] } }), text.startsWith('DAILY_LONG') ? 15000 : 20);
    return { kind: 'accepted' };
  }
  async abort() { clearTimeout(this.pendingPrompt); this.observer?.({ kind: 'frame', seq: this.sequence++, sessionId: this.id, receivedAt: Date.now(), agentPath: [], body: { events: [{ kind: 'turn_ended', outcome: { kind: 'aborted' } }] } }); return { kind: 'accepted' }; }
  async dispose() { clearTimeout(this.pendingPrompt); this.observer = undefined; }
}
const factory = { async open(options) { const profile = await prepareProfile(options); return new ControlledManagedSession(options.resume ?? randomUUID(), profile.profile); } };
const services = [];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
const memberContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
for (const context of [ownerContext, memberContext]) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: clientOrigin });
  if (process.env.CODOXEAR_CUSTOMER_CLIENT_ORIGIN) await context.grantPermissions(['local-network-access'], { origin: clientOrigin }).catch(() => {});
}
const ownerPage = await ownerContext.newPage(), memberPage = await memberContext.newPage();
const checks = [], screenshots = [], failures = [], externalBootstrap = [], unavailable = [], browserDiagnostics = [];
const redactDiagnostic = text => String(text).replace(/https?:\/\/[^\s"'<>]+/g, address => { try { const parsed = new URL(address); return parsed.origin + parsed.pathname; } catch { return '[URL]'; } }).slice(0, 1000);
if (process.env.DAILY_GIT_DIAGNOSTIC_ONLY === '1') ownerPage.on('response', async response => {
  const path = new URL(response.url()).pathname;
  if (!/\/(?:git\/changed_files|file\/read|file\/write)(?:$|\/)/.test(path)) return;
  const value = await response.json().catch(() => null);
  const entries = Array.isArray(value) ? value : value?.files ?? value?.changed_files ?? value?.entries;
  browserDiagnostics.push('File/Git response: ' + JSON.stringify({
    path, status: response.status(), keys: value && !Array.isArray(value) ? Object.keys(value) : [],
    error: value?.error, message: value?.message,
    entries: Array.isArray(entries) ? entries.slice(0, 20).map(file => typeof file === 'string' ? file : ({ path: file.path, changed: file.changed, status: file.status, additions: file.additions, deletions: file.deletions })) : undefined,
  }));
});
let stage = 'initialize owner', passed = false;
for (const page of [ownerPage, memberPage]) { page.setDefaultTimeout(30000); page.on('pageerror', () => failures.push('Browser runtime exception')); page.on('console', message => { if (message.type() === 'error' && browserDiagnostics.length < 30) browserDiagnostics.push(redactDiagnostic(message.text())); }); }
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const pass = text => { checks.push(text); console.log('PASS', text); };
async function shot(page, name) {
  const path = join(artifacts, name + '.png');
  if (name.includes('failure') || name === 'daily-settings-slate-dark' || name === 'daily-renamed-priority-persisted') {
    const appearance = await page.evaluate(() => ({
      htmlClass: document.documentElement.className,
      htmlTheme: document.documentElement.getAttribute('data-theme'),
      htmlMode: document.documentElement.getAttribute('data-mode'),
      bodyClass: document.body.className,
      background: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
    })).catch(() => undefined);
    browserDiagnostics.push('Appearance ' + name + ': ' + JSON.stringify(appearance));
  }
  await page.screenshot({ path, fullPage: true, mask: [page.locator('[data-code], [data-command], [data-private], output, input[name="token"], input[type="password"], input[aria-label="Invitation link"], textarea[aria-label="Invitation link"]')] });
  screenshots.push(name + '.png');
}
async function home(page) {
  if (!(await dialog(page, 'Hubs & computers').isVisible().catch(() => false))) {
    if (await page.locator('.connectionPage').count())
      await dialog(page, 'Hubs & computers').waitFor({ state: 'visible' });
    else
      await page.locator('.sidebar footer').getByRole('button', { name: 'Hubs & computers', exact: true }).click();
  }
  const summary = dialog(page, 'Hubs & computers').locator('.connectionHub summary');
  await summary.first().waitFor();
  if (!(await summary.first().evaluate(node => node.parentElement.open))) await summary.first().click();
  // Hub settings is installed only after identity and Computer discovery settles.
  await dialog(page, 'Hubs & computers').getByRole('button', { name: 'Hub settings', exact: true }).waitFor();
}
async function settings(page) { await home(page); await dialog(page, 'Hubs & computers').getByRole('button', { name: 'Hub settings', exact: true }).click(); }
async function hubMembers(page) {
  await settings(page);
  await dialog(page, 'Hub settings').getByRole('button', { name: 'Manage Hub members', exact: true }).click();
  await dialog(page, 'Hub members').waitFor({ state: 'visible' });
}
async function createInvitationLink(page, screenshot, hours = '1') {
  const members = dialog(page, 'Hub members');
  await members.getByLabel('Invitation expiry', { exact: true }).selectOption(hours);
  const previous = await members.getByLabel('Invitation link', { exact: true }).inputValue().catch(() => '');
  await members.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  const field = members.getByLabel('Invitation link', { exact: true });
  await field.waitFor();
  await page.waitForFunction(old => {
    const field = document.querySelector('[aria-label="Invitation link"]');
    return field?.value && field.value !== old;
  }, previous);
  const expected = await field.inputValue();
  await members.getByRole('button', { name: 'Copy invitation link', exact: true }).click();
  await page.waitForFunction(async value => await navigator.clipboard.readText() === value, expected);
  const invitation = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(invitation, await field.inputValue());
  const url = new URL(invitation);
  assert.equal(url.origin, clientOrigin);
  assert.equal(url.searchParams.get('hub'), origin);
  assert.ok(new URLSearchParams(url.hash.slice(1)).get('invite'));
  await shot(page, screenshot);
  return invitation;
}
async function rejectInvitationLink(invitation, reason, screenshot) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  if (process.env.CODOXEAR_CUSTOMER_CLIENT_ORIGIN) await context.grantPermissions(['local-network-access'], { origin: clientOrigin });
  const recipient = await context.newPage();
  try {
    await recipient.goto(invitation);
    const preview = dialog(recipient, 'Hub invitation');
    await preview.getByText('This invitation is ' + reason + '.', { exact: true }).waitFor();
    assert.equal(new URLSearchParams(new URL(recipient.url()).hash.slice(1)).has('invite'), false);
    assert.equal(await preview.getByRole('button', { name: 'Join Hub', exact: true }).count(), 0);
    await shot(recipient, screenshot);
  } catch (error) {
    await shot(recipient, screenshot + '-failure').catch(() => {});
    throw error;
  } finally { await context.close(); }
}
async function backHome(page) {
  for (let index = 0; index < 5 && !(await dialog(page, 'Hubs & computers').isVisible().catch(() => false)); index++) {
    const heading = await page.locator('.connectionHeader h1').innerText();
    await page.locator('.connectionPage').getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForFunction(previous => document.querySelector('.connectionHeader h1')?.textContent !== previous, heading);
  }
  await home(page);
}
async function signIn(page, method, identity) {
  stage = identity + ': open client';
  await page.goto(clientOrigin);
  await dialog(page, 'Hubs & computers').getByRole('button', { name: 'Add hub', exact: true }).click();
  await dialog(page, 'Add hub').getByLabel('Hub address').fill(origin);
  stage = identity + ': discover Hub';
  await dialog(page, 'Add hub').getByRole('button', { name: 'Connect hub', exact: true }).click();
  const popupPromise = page.context().waitForEvent('page');
  void popupPromise.catch(() => {});
  stage = identity + ': choose provider';
  await dialog(page, 'Sign in to Hub').getByRole('button', { name: 'Continue with ' + method, exact: true }).click();
  const popup = await popupPromise;
  stage = identity + ': controlled provider loaded';
  await popup.getByRole('button', { name: 'Sign in as ' + people[identity].name, exact: true }).waitFor();
  await shot(popup, 'provider-' + identity);
  const close = popup.waitForEvent('close');
  await popup.getByRole('button', { name: 'Sign in as ' + people[identity].name, exact: true }).click();
  stage = identity + ': OAuth callback and popup close';
  await close;
  stage = identity + ': wait for completed connection page';
  // Popup closure precedes credential persistence and finishConnect(). Wait for
  // that existing UI flow to finish before another navigation is clicked.
  await dialog(page, 'Hubs & computers').waitFor({ state: 'visible' });
  stage = identity + ': connected identity visible';
  await home(page);
  await page.getByText(people[identity].name, { exact: true }).waitFor();
}
async function prepareWorkspaceFixtures(workspace) {
  // Physical Computer bootstrap fixtures, never Hub/application records or grants.
  await writeFile(join(workspace, 'fixture.md'), '# Daily fixture Markdown\n\nA pre-existing document on the Computer.\n');
  await writeFile(join(workspace, 'fixture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V0AAAAASUVORK5CYII=', 'base64'));
  const content = 'BT /F1 14 Tf 30 130 Td (Daily PDF fixture) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n', offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  await writeFile(join(workspace, 'fixture.pdf'), pdf);
  const git = promisify(execFile);
  await git('git', ['-C', workspace, 'init', '-q']);
  await git('git', ['-C', workspace, '-c', 'user.name=Daily fixture', '-c', 'user.email=fixture@controlled.test', 'add', '.']);
  await git('git', ['-C', workspace, '-c', 'user.name=Daily fixture', '-c', 'user.email=fixture@controlled.test', 'commit', '-q', '-m', 'Physical Computer workspace fixture']);
}
async function createComputer(name) {
  await home(ownerPage);
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: 'Add computer', exact: true }).click();
  await dialog(ownerPage, 'Add computer').getByLabel('Computer name').fill(name);
  await dialog(ownerPage, 'Add computer').getByRole('button', { name: 'Add computer', exact: true }).click();
  const pair = dialog(ownerPage, 'Pair computer');
  await pair.locator('[data-code]').waitFor();
  const code = await pair.locator('[data-code]').innerText();
  await shot(ownerPage, name.replaceAll(' ', '-').toLowerCase() + '-pairing');
  const homePath = join(scratch, name.replaceAll(' ', '-')), workspace = join(homePath, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'journey.txt'), 'Customer journey workspace\n');
  if (process.env.DAILY_EXERCISE === '1') await prepareWorkspaceFixtures(workspace);
  const piHome = join(homePath, '.pi', 'agent');
  await mkdir(piHome, { recursive: true });
  await writeFile(join(piHome, 'models.json'), JSON.stringify({ providers: {
    'controlled-anthropic': { baseUrl: origin + '/controlled-models/v1', apiKey: 'controlled-no-live-secret', api: 'anthropic-messages', models: [{ id: 'journey-model', api: 'anthropic-messages', reasoning: false }] },
  } }), { mode: 0o600 });
  await writeFile(join(piHome, 'settings.json'), JSON.stringify({ defaultProvider: 'controlled-anthropic', defaultModel: 'journey-model', defaultThinkingLevel: 'off' }), { mode: 0o600 });
  const api = createComputerApi(homePath);
  await api.enroll({ enrollment: { identityUrl: origin, code }, runtime: 'oar', nativeHome: homePath,
    nativeStateHome: homePath, workspacePath: workspace, oarPermissionPolicy: 'locally-trusted' });
  const service = api.service(undefined, { runtime: () => new ManagedRuntime({ databasePath: join(homePath, 'managed.sqlite'), home: homePath, stateHome: homePath, workspace, factory }) });
  services.push(service); await service.start();
  externalBootstrap.push({ computer: name, operation: 'External Computer enroll and service start using the pairing code generated in browser', runtime: 'Real ManagedRuntime with controlled ManagedFactory', preparedProviderConfig: 'External Computer installation prepares private controlled-anthropic Pi provider URL/key, anthropic-messages API and local journey-model reasoning:false/default Off; browser discovery overrides requests using returned metadata, no human or agent seeding', preparedWorkspaceFixtures: process.env.DAILY_EXERCISE === '1' ? 'Pre-existing text, Markdown, PNG, valid PDF and Git repository on the physical Computer; file create/edit tests remain browser UI' : 'Pre-existing text file' });
  await pair.getByRole('button', { name: 'Done', exact: true }).click();
  stage = name + ': wait for completed pairing page';
  await dialog(ownerPage, 'Hubs & computers').waitFor({ state: 'visible' });
  await home(ownerPage);
  stage = name + ': verify Online in browser';
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: new RegExp(name) }).getByText(/Online/).waitFor();
  return workspace;
}
async function access(name, user, value, remove = false) {
  stage = name + ': ' + (remove ? 'remove' : value) + ' allowlist for ' + user;
  await home(ownerPage);
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: new RegExp(name) }).click();
  await dialog(ownerPage, name).getByRole('button', { name: 'Manage access', exact: true }).click();
  const allow = dialog(ownerPage, 'Computer allowlist');
  if (remove) {
    await allow.locator('.connectionRow').filter({ has: ownerPage.getByText(people[user].name, { exact: true }) }).getByRole('button', { name: 'Remove access', exact: true }).click();
    await allow.getByText('No identities are allowlisted.', { exact: true }).waitFor();
  } else {
    await allow.getByLabel('Hub member', { exact: true }).selectOption({ label: people[user].name + ' · ' + (user === 'owner' ? 'Owner' : 'Member') });
    await allow.getByLabel('Computer access', { exact: true }).selectOption(value);
    await allow.getByRole('button', { name: 'Grant computer access', exact: true }).click();
    await allow.locator('.connectionMembers').getByText(value === 'write' ? 'Read and write' : 'Read only', { exact: true }).waitFor();
  }
  await shot(ownerPage, name.replaceAll(' ', '-').toLowerCase() + '-' + (remove ? 'revoked' : value));
  if (name === 'Computer A' && user === 'owner' && value === 'write' && !remove) {
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await shot(ownerPage, 'customer-computer-allowlist-portrait');
    await ownerPage.setViewportSize({ width: 944, height: 560 });
    await shot(ownerPage, 'customer-computer-allowlist-landscape');
    await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  }
  await backHome(ownerPage);
}
async function grantMemberFiles() {
  stage = 'Computer B: owner grants Member workspace files through UI';
  await home(ownerPage);
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).click();
  await dialog(ownerPage, 'Computer B').getByRole('button', { name: 'Manage access', exact: true }).click();
  await dialog(ownerPage, 'Computer allowlist').getByRole('button', { name: 'Workspace permissions', exact: true }).click();
  const files = dialog(ownerPage, 'Workspace permissions');
  const form = files.locator('.workspace-form').filter({ has: ownerPage.getByLabel('Workspace access for Journey Member', { exact: true }) });
  await form.getByLabel('Approved workspace', { exact: true }).selectOption('default');
  await form.getByLabel('Workspace access for Journey Member', { exact: true }).selectOption('write');
  await form.getByLabel('Allowed files or directories', { exact: true }).fill('.');
  await form.getByRole('button', { name: 'Save file access', exact: true }).click();
  await form.getByText('Workspace access saved', { exact: true }).waitFor();
  await shot(ownerPage, 'owner-grants-member-b-files');
  await backHome(ownerPage);
  pass('Computer owner separately grants Member access to the approved workspace through UI');
}
async function closeConnections(page) { await home(page); await dialog(page, 'Hubs & computers').getByRole('button', { name: 'Back', exact: true }).click(); }
const card = (page, name) => page.locator('.session').filter({ has: page.getByText(name, { exact: true }) });
async function createAgent(page, computer, name, workspace) {
  stage = name + ': new agent form';
  await closeConnections(page); await page.locator('#newBtn').click();
  const create = dialog(page, 'New agent');
  await create.getByLabel('Computer & hub', { exact: true }).selectOption({ label: computer + ' · Customer Hub' });
  if (page === memberPage) assert.equal(await create.getByLabel('Computer & hub', { exact: true }).locator('option').filter({ hasText: 'Computer A' }).count(), 0);
  await create.locator('[data-catalog-status]').getByText('Provider and model choices were read from this computer’s configuration.', { exact: true }).waitFor();
  await create.getByLabel('Runtime', { exact: true }).selectOption('pi');
  await create.getByLabel('Provider', { exact: true }).selectOption('controlled-anthropic');
  assert.equal(await create.getByLabel('Model', { exact: true }).inputValue(), 'journey-model');
  assert.equal(await create.getByLabel('Reasoning', { exact: true }).inputValue(), 'off');
  await create.getByText('The Computer’s model configuration does not advertise reasoning levels beyond Off.', { exact: true }).waitFor();
  stage = name + ': caller-key model discovery';
  await create.getByRole('button', { name: 'Discover models', exact: true }).click();
  await create.locator('[data-discovery-status]').filter({ hasText: '3 caller-key-visible models' }).waitFor();
  assert.deepEqual(await create.getByLabel('Model', { exact: true }).locator('option').allTextContents(), ['Choose a model', 'journey-model', 'journey-model-next', 'journey-unknown', 'Custom…']);
  assert.equal(await create.getByLabel('Model', { exact: true }).inputValue(), 'journey-model');
  await create.getByLabel('Model', { exact: true }).selectOption('journey-unknown');
  await create.getByText('LiteLLM reasoning metadata is unknown. These are runtime request levels from this Computer; provider acceptance is not verified.', { exact: true }).waitFor();
  await shot(page, name.replaceAll(' ', '-').toLowerCase() + '-discovery-unknown');
  await create.getByLabel('Model', { exact: true }).selectOption('journey-model');
  assert.deepEqual(await create.getByLabel('Requested reasoning', { exact: true }).locator('option').allTextContents(), ['Choose a reasoning level', 'Low', 'High', 'Maximum']);
  await create.getByLabel('Requested reasoning', { exact: true }).selectOption('low');
  await shot(page, name.replaceAll(' ', '-').toLowerCase() + '-discovery-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, name.replaceAll(' ', '-').toLowerCase() + '-discovery-portrait');
  await create.locator('.agent-creation-body').hover();
  await page.mouse.wheel(0, 550);
  const requestedEffort = create.getByLabel('Requested reasoning', { exact: true });
  await requestedEffort.waitFor({ state: 'visible' });
  assert.equal(await requestedEffort.inputValue(), 'low');
  await page.waitForFunction(() => {
    const effort = document.querySelector('dialog[open] select[name="effort"]')?.getBoundingClientRect();
    const footer = document.querySelector('dialog[open] footer')?.getBoundingClientRect();
    const header = document.querySelector('dialog[open] header')?.getBoundingClientRect();
    return !!effort && !!footer && !!header && effort.top >= header.bottom && effort.bottom <= footer.top;
  });
  await shot(page, name.replaceAll(' ', '-').toLowerCase() + '-discovery-effort-portrait');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await create.getByLabel('Agent name', { exact: true }).fill(name);
  await create.getByText('More', { exact: true }).click();
  await create.getByLabel('Working directory', { exact: true }).fill(workspace);
  await shot(page, name.replaceAll(' ', '-').toLowerCase() + '-create');
  stage = name + ': submit managed agent';
  await create.getByRole('button', { name: 'Create agent', exact: true }).click();
  await create.waitFor({ state: 'hidden', timeout: 60000 });
  await card(page, name).waitFor(); await card(page, name).click();
}
async function send(page, text) {
  stage = 'managed UI send: ' + text;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.msg.assistant:not(.typing)').filter({ hasText: 'Managed response: ' + text }).first().waitFor();
}
async function dailyAttempt(label, action) {
  try { await action(); return true; }
  catch (error) {
    failures.push(label + ': ' + redactDiagnostic(error instanceof Error ? error.message : error));
    console.error('FAIL', label);
    if (label.startsWith('Daily file') && await ownerPage.locator('#fileViewer').isVisible().catch(() => false))
      browserDiagnostics.push('File rendered text: ' + redactDiagnostic(await ownerPage.locator('#fileViewer .view-lines').allTextContents().then(values => values.join('|')).catch(() => 'unavailable')));
    await shot(ownerPage, label.replaceAll(' ', '-').toLowerCase() + '-failure').catch(() => {});
    for (const id of ['fileCloseBtn', 'diagCloseBtn', 'chatSearchCloseBtn', 'editCloseBtn', 'settingsCloseBtn', 'helpCloseBtn', 'queueCloseBtn', 'appConfirmCancelBtn']) {
      if (await ownerPage.locator('#' + id).isVisible().catch(() => false)) await ownerPage.locator('#' + id).click();
    }
    if (await ownerPage.locator('#fileUnsavedDiscardBtn').isVisible().catch(() => false)) await ownerPage.locator('#fileUnsavedDiscardBtn').click();
    await ownerPage.setViewportSize({ width: 1440, height: 1000 });
    return false;
  }
}
async function dailyCustomer(workspaceA) {
  stage = 'Daily customer: select persisted owner agent';
  await closeConnections(ownerPage);
  await card(ownerPage, 'Owner agent A').waitFor(); await card(ownerPage, 'Owner agent A').click();
  await ownerPage.locator('.msg.assistant:not(.typing)').filter({ hasText: 'Managed response: Owner UI message' }).first().waitFor();
  if (process.env.DAILY_EDITOR_DIAGNOSTIC_ONLY !== '1') {
  stage = 'Daily customer: appearance settings';
  await ownerPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog(ownerPage, 'Settings').getByRole('radio', { name: 'Slate', exact: true }).click();
  await dialog(ownerPage, 'Settings').getByRole('radio', { name: 'Dark', exact: true }).click();
  await ownerPage.waitForFunction(() => {
    const link = document.querySelector('link#codoxearThemeLink[href*="themes/slate.css"]');
    const channels = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
    return Boolean(link?.sheet && channels?.reduce((sum, value) => sum + value, 0) < 200);
  });
  await shot(ownerPage, 'daily-settings-slate-dark'); await ownerPage.locator('#settingsCloseBtn').click();
  await ownerPage.reload(); await card(ownerPage, 'Owner agent A').waitFor(); await card(ownerPage, 'Owner agent A').click();
  await ownerPage.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await dialog(ownerPage, 'Settings').getByRole('radio', { name: 'Slate', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await dialog(ownerPage, 'Settings').getByRole('radio', { name: 'Dark', exact: true }).getAttribute('aria-checked'), 'true');
  await ownerPage.waitForFunction(() => {
    const link = document.querySelector('link#codoxearThemeLink[href*="themes/slate.css"]');
    const channels = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
    return Boolean(link?.sheet && channels?.reduce((sum, value) => sum + value, 0) < 200);
  });
  await dialog(ownerPage, 'Settings').getByRole('radio', { name: 'Paper', exact: true }).click();
  await dialog(ownerPage, 'Settings').getByRole('radio', { name: 'Light', exact: true }).click();
  await ownerPage.locator('#settingsCloseBtn').click();
  pass('Daily customer changes theme and mode through Settings, confirms persistence after reload, and restores Paper Light');
  await dailyAttempt('Daily voice settings cancel', async () => {
    stage = 'Daily customer: voice settings cancel';
    await ownerPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await ownerPage.locator('#voiceBaseUrlInput').waitFor({ state: 'visible' });
    const original = await ownerPage.locator('#voiceBaseUrlInput').inputValue();
    await ownerPage.locator('#voiceBaseUrlInput').fill('https://cancelled.invalid/v1');
    await ownerPage.locator('#voiceSettingsCancelBtn').click();
    await dialog(ownerPage, 'Settings').waitFor({ state: 'hidden' });
    await ownerPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await ownerPage.locator('#voiceBaseUrlInput').waitFor({ state: 'visible' });
    assert.equal(await ownerPage.locator('#voiceBaseUrlInput').inputValue(), original);
    await shot(ownerPage, 'daily-voice-settings-cancelled'); await ownerPage.locator('#settingsCloseBtn').click();
    pass('Daily customer cancels a voice endpoint edit and reopening Settings retains its previous value');
  });
  await dailyAttempt('Daily Help', async () => {
    stage = 'Daily customer: open Help';
    await ownerPage.getByRole('button', { name: 'Help', exact: true }).click();
    await dialog(ownerPage, 'Help').waitFor({ state: 'visible' });
    await shot(ownerPage, 'daily-help'); await ownerPage.locator('#helpCloseBtn').click();
    pass('Daily customer opens and closes the current deployed Help dialog');
  });
  stage = 'Daily customer: conversation copy and search';
  await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
  await dialog(ownerPage, 'Details').getByRole('button', { name: 'Copy conversation', exact: true }).click();
  await ownerPage.locator('#toast').filter({ hasText: /^Copied [0-9]+ messages?/ }).waitFor();
  const copied = await ownerPage.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes('Managed response: Owner UI message'));
  await shot(ownerPage, 'daily-copy-conversation'); await ownerPage.locator('#diagCloseBtn').click();
  await ownerPage.getByRole('button', { name: 'Search conversation', exact: true }).click();
  await ownerPage.locator('#chatSearchInput').fill('Owner UI message');
  await ownerPage.locator('#chatSearchStatus').filter({ hasText: /[1-9]/ }).waitFor();
  await shot(ownerPage, 'daily-conversation-search'); await ownerPage.locator('#chatSearchCloseBtn').click();
  pass('Daily customer copies the actual persisted conversation and searches its message text through UI');
  await dailyAttempt('Daily queue and interrupt', async () => {
    stage = 'Daily customer: queue while running and interrupt';
    await ownerPage.getByRole('textbox', { name: 'Message', exact: true }).fill('DAILY_LONG controlled slow turn');
    await ownerPage.getByRole('button', { name: 'Send', exact: true }).click();
    await ownerPage.locator('#interruptBtn').waitFor({ state: 'visible' });
    await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
    await dialog(ownerPage, 'Details').getByText('journey-model', { exact: true }).first().waitFor();
    assert.equal(await dialog(ownerPage, 'Details').getByRole('button', { name: 'Change model', exact: true }).isDisabled(), true);
    assert.equal(await dialog(ownerPage, 'Details').getByRole('button', { name: 'Change reasoning effort', exact: true }).isDisabled(), true);
    await shot(ownerPage, 'details-model-effort-busy');
    await ownerPage.locator('#diagCloseBtn').click();
    await ownerPage.getByRole('textbox', { name: 'Message', exact: true }).fill('Daily queued message');
    await ownerPage.locator('#sendBtn').click();
    await dialog(ownerPage, 'Send options').getByRole('button', { name: 'Send after current', exact: true }).click();
    await ownerPage.locator('#queueBtn').click();
    await dialog(ownerPage, 'Queued messages').getByRole('textbox', { name: 'Queued message 1', exact: true }).waitFor();
    assert.equal(await dialog(ownerPage, 'Queued messages').getByRole('textbox', { name: 'Queued message 1', exact: true }).inputValue(), 'Daily queued message');
    await shot(ownerPage, 'daily-queued-message'); await ownerPage.locator('#queueCloseBtn').click();
    const interrupted = ownerPage.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/interrupt') && response.ok()); void interrupted.catch(() => {});
    await ownerPage.locator('#interruptBtn').click(); await interrupted;
    await ownerPage.locator('.msg.assistant:not(.typing)').filter({ hasText: 'Managed response: Daily queued message' }).first().waitFor();
    await shot(ownerPage, 'daily-interrupted-queue-completed');
    pass('Daily customer queues a real prompt while the managed driver is running, reviews it, interrupts the active turn, and receives the queued reply');
  });
  }
  await dailyAttempt('Daily file create save download', async () => {
  stage = 'Daily customer: create edit save and download file';
  await ownerPage.getByRole('button', { name: 'View file', exact: true }).click();
  await ownerPage.locator('#filePickerInput').fill('daily-note.txt');
  await ownerPage.locator('#filePickerMenu').getByRole('option').filter({ hasText: 'Create new file: daily-note.txt' }).click();
  await ownerPage.locator('#fileViewer .monaco-editor .view-lines').first().waitFor({ state: 'visible' });
  await ownerPage.locator('#fileViewer .monaco-editor .view-lines').first().click({ position: { x: 40, y: 10 } });
  browserDiagnostics.push('Editor input before typing: ' + JSON.stringify(await ownerPage.evaluate(() => {
    const active = document.activeElement;
    return { activeTag: active?.tagName, activeClass: active?.className, activeLabel: active?.getAttribute('aria-label'),
      inputs: [...document.querySelectorAll('#fileViewer .monaco-editor textarea, #fileViewer .native-edit-context')].map(input => { const styles = getComputedStyle(input); return { tag: input.tagName, className: input.className, label: input.getAttribute('aria-label'), readOnly: input.readOnly, valueLength: input.value?.length, width: styles.width, height: styles.height, padding: styles.padding, resize: styles.resize, position: styles.position, opacity: styles.opacity, display: styles.display }; }),
      editContextCount: document.querySelectorAll('#fileViewer .native-edit-context').length };
  })));
  await ownerPage.keyboard.type('Daily customer file created and saved through UI');
  await ownerPage.locator('#fileViewer .view-lines').filter({ hasText: 'Daily customer file created and saved through UI' }).waitFor();
  const savedFile = ownerPage.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/file/write') && response.ok());
  void savedFile.catch(() => {});
  await ownerPage.getByRole('button', { name: 'Save file', exact: true }).click(); await savedFile;
  await shot(ownerPage, 'daily-file-created-saved');
  if (process.env.DAILY_EDITOR_DIAGNOSTIC_ONLY === '1') {
    await ownerPage.locator('#fileCloseBtn').click();
    await ownerPage.reload(); await card(ownerPage, 'Owner agent A').waitFor(); await card(ownerPage, 'Owner agent A').click();
    await ownerPage.getByRole('button', { name: 'View file', exact: true }).click();
    await ownerPage.locator('#filePickerInput').fill('daily-note.txt');
    await ownerPage.locator('#filePickerMenu').getByText('daily-note.txt', { exact: false }).first().click();
    await ownerPage.locator('#fileViewer .view-lines').filter({ hasText: 'Daily customer file created and saved through UI' }).waitFor();
    await shot(ownerPage, 'daily-file-reloaded-content'); await ownerPage.locator('#fileCloseBtn').click();
    pass('Human editor line click and keyboard typing produce visible text that persists after UI save and page reload');
    return;
  }
  const downloading = ownerPage.waitForEvent('download'); void downloading.catch(() => {});
  await ownerPage.getByRole('button', { name: 'Download file', exact: true }).click();
  const download = await downloading;
  assert.equal(await download.failure(), null);
  assert.equal((await readFile(await download.path(), 'utf8')).trim(), 'Daily customer file created and saved through UI');
  await ownerPage.locator('#fileCloseBtn').click();
  pass('Daily customer creates and saves a file through the editor and downloads its actual saved contents');
  });
  if (process.env.DAILY_EDITOR_DIAGNOSTIC_ONLY === '1') return;
  await dailyAttempt('Daily runtime model change', async () => {
    stage = 'Daily customer: model command through composer';
    const changedModel = ownerPage.waitForResponse(response => response.request().method() === 'POST' && /\/(settings|send)(?:\?|$)/.test(new URL(response.url()).pathname) && response.ok());
    void changedModel.catch(() => {});
    await ownerPage.getByRole('textbox', { name: 'Message', exact: true }).fill('/model journey-model-next');
    await ownerPage.locator('#sendBtn').click(); await changedModel;
    await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
    await dialog(ownerPage, 'Details').getByText('journey-model-next', { exact: true }).first().waitFor();
    await shot(ownerPage, 'daily-model-changed'); await ownerPage.locator('#diagCloseBtn').click();
    await ownerPage.reload(); await card(ownerPage, 'Owner agent A').waitFor(); await card(ownerPage, 'Owner agent A').click();
    await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
    await dialog(ownerPage, 'Details').getByText('journey-model-next', { exact: true }).first().waitFor();
    await shot(ownerPage, 'daily-model-persisted'); await ownerPage.locator('#diagCloseBtn').click();
    pass('Daily customer changes model with a normal composer command and Details confirms its persisted value after reload');
  });
  await dailyAttempt('Details model and thinking effort', async () => {
    stage = 'Details: discover saved provider and choose model and thinking effort';
    await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
    const details = dialog(ownerPage, 'Details');
    await details.getByRole('button', { name: 'Change model', exact: true }).click();
    const model = details.getByLabel('Model', { exact: true });
    const effort = details.getByLabel('Thinking effort', { exact: true });
    await model.locator('option[value="journey-model-next"]:checked').waitFor({ state: 'attached' });
    await details.getByRole('button', { name: 'Discover models', exact: true }).click();
    await model.locator('option[value="journey-model"]').waitFor({ state: 'attached' });
    await model.selectOption('journey-model');
    await effort.locator('option[value="max"]:not(:disabled)').waitFor({ state: 'attached' });
    await effort.selectOption('max');
    await shot(ownerPage, 'details-model-effort-desktop');
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await details.getByRole('button', { name: 'Save settings', exact: true }).scrollIntoViewIfNeeded();
    for (const control of [model, effort, details.getByRole('button', { name: 'Save settings', exact: true })]) {
      const box = await control.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, 'Details editing controls fit phone viewport with touch targets');
    }
    await shot(ownerPage, 'details-model-effort-portrait');
    const saved = ownerPage.waitForResponse(response => response.request().method() === 'POST' && /\/settings(?:\?|$)/.test(new URL(response.url()).pathname));
    void saved.catch(() => {});
    await details.getByRole('button', { name: 'Save settings', exact: true }).click();
    const response = await saved;
    assert.ok(response.ok(), 'Runtime confirms the model and thinking effort together');
    const accepted = await response.json();
    assert.equal(accepted.model, 'journey-model');
    assert.equal(accepted.reasoning_effort, 'max');
    await ownerPage.waitForFunction(() => document.querySelector('#diagCurrentModel')?.textContent === 'journey-model' && document.querySelector('#diagCurrentEffort')?.textContent === 'max');
    await shot(ownerPage, 'details-model-effort-saved');
    await ownerPage.locator('#diagCloseBtn').click();
    await ownerPage.reload(); await card(ownerPage, 'Owner agent A').waitFor();
    await ownerPage.locator('#threadTitle').filter({ hasText: 'Owner agent A' }).waitFor();
    await ownerPage.locator('.msg.assistant:not(.typing)').filter({ hasText: 'Managed response: Owner UI message' }).first().waitFor();
    await ownerPage.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    await ownerPage.waitForFunction(() => document.body.classList.contains('sidebar-open'));
    await card(ownerPage, 'Owner agent A').click();
    await ownerPage.waitForFunction(() => !document.body.classList.contains('sidebar-open'));
    await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
    await details.getByRole('button', { name: 'Change reasoning effort', exact: true }).click();
    await model.locator('option[value="journey-model"]:checked').waitFor({ state: 'attached' });
    await effort.locator('option[value="max"]:checked').waitFor({ state: 'attached' });
    await shot(ownerPage, 'details-model-effort-persisted');
    await effort.selectOption('high');
    await ownerPage.locator('#diagCloseBtn').click();
    await ownerPage.getByRole('button', { name: 'Details', exact: true }).click();
    await details.getByRole('button', { name: 'Change reasoning effort', exact: true }).click();
    await effort.locator('option[value="max"]:checked').waitFor({ state: 'attached' });
    await ownerPage.locator('#diagCloseBtn').click();
    await ownerPage.setViewportSize({ width: 1440, height: 1000 });
    pass('Details discovers the saved provider, confirms model and exact Max together, persists both after reload, and closing unsaved edits retains accepted settings; phone controls fit');
  });
  await dailyAttempt('Daily attachment upload and removal', async () => {
    stage = 'Daily customer: choose attachment and remove staged upload';
    const choosing = ownerPage.waitForEvent('filechooser'); void choosing.catch(() => {});
    await ownerPage.getByRole('button', { name: /^Attach file/ }).click();
    await (await choosing).setFiles({ name: 'daily-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Daily browser file chooser upload') });
    await ownerPage.locator('#stagedAttachments').getByText('daily-upload.txt', { exact: false }).first().waitFor();
    await shot(ownerPage, 'daily-attachment-staged');
    await ownerPage.getByRole('button', { name: 'Remove daily-upload.txt', exact: true }).click();
    await ownerPage.locator('#stagedAttachments').getByText('daily-upload.txt', { exact: false }).first().waitFor({ state: 'hidden' });
    pass('Daily customer uploads a text attachment through the real file chooser, reviews the staged upload, and removes it');
    stage = 'Daily customer: send image and file attachments';
    const choosingBoth = ownerPage.waitForEvent('filechooser'); void choosingBoth.catch(() => {});
    await ownerPage.getByRole('button', { name: /^Attach file/ }).click();
    await (await choosingBoth).setFiles([
      { name: 'daily-sent.txt', mimeType: 'text/plain', buffer: Buffer.from('Daily customer attached text') },
      { name: 'daily-sent.png', mimeType: 'image/png', buffer: await readFile(join(workspaceA, 'fixture.png')) },
    ]);
    await ownerPage.locator('#stagedAttachments').getByText('daily-sent.txt', { exact: false }).first().waitFor();
    await ownerPage.locator('#stagedAttachments').getByText('daily-sent.png', { exact: false }).first().waitFor();
    await shot(ownerPage, 'daily-file-and-image-ready');
    await send(ownerPage, 'Daily message with file and image');
    const attachmentInput = managedInputs.find(input => input.text.includes('Daily message with file and image'));
    assert.ok(attachmentInput?.text.includes('Attached file "daily-sent.txt"'), 'File must reach the managed driver as an attached file reference');
    assert.equal(attachmentInput?.images.length, 1, 'PNG must reach the managed driver as exactly one image input');
    assert.equal(attachmentInput.images[0].mediaType, 'image/png');
    await ownerPage.locator('#stagedAttachments').waitFor({ state: 'hidden' });
    await shot(ownerPage, 'daily-file-and-image-sent');
    pass('Daily customer chooses a text file and PNG in the real file chooser and sends their staged attachments with a message');
  });
  await dailyAttempt('Daily file preview formats', async () => {
    stage = 'Daily customer: Markdown image and PDF previews';
    for (const [name, type] of [['fixture.md', 'Markdown'], ['fixture.png', 'image'], ['fixture.pdf', 'PDF']]) {
      await ownerPage.getByRole('button', { name: 'View file', exact: true }).click();
      await ownerPage.locator('#filePickerInput').fill(name);
      await ownerPage.locator('#filePickerMenu').getByText(name, { exact: false }).first().click();
      if (type === 'Markdown') {
        await ownerPage.getByRole('button', { name: 'Toggle markdown preview', exact: true }).click();
        await ownerPage.locator('#fileViewer').getByRole('heading', { name: 'Daily fixture Markdown', exact: true }).waitFor();
      } else if (type === 'image') {
        await ownerPage.locator('#fileImage').waitFor({ state: 'visible' });
        await ownerPage.waitForFunction(() => {
          const image = document.querySelector('#fileImage');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1;
        });
      } else await ownerPage.locator('#fileViewer canvas').first().waitFor({ state: 'visible' });
      await shot(ownerPage, 'daily-preview-' + type.toLowerCase()); await ownerPage.locator('#fileCloseBtn').click();
    }
    pass('Daily customer opens pre-existing Markdown, image and PDF fixtures through Files and receives their actual rendered previews');
  });
  await dailyAttempt('Daily Git diff', async () => {
    stage = 'Daily customer: tracked file edit and Git diff';
    await ownerPage.getByRole('button', { name: 'View file', exact: true }).click();
    await ownerPage.locator('#filePickerInput').fill('journey.txt');
    await ownerPage.locator('#filePickerMenu').getByText('journey.txt', { exact: false }).first().click();
    await ownerPage.locator('#fileViewer .view-lines').filter({ hasText: 'Customer journey workspace' }).waitFor();
    await ownerPage.getByRole('button', { name: 'Edit file', exact: true }).click();
    await ownerPage.locator('#fileViewer .view-lines').first().click({ position: { x: 40, y: 10 } });
    await ownerPage.keyboard.press('Control+End'); await ownerPage.keyboard.type('\nDaily customer Git change');
    const saved = ownerPage.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/file/write') && response.ok()); void saved.catch(() => {});
    await ownerPage.getByRole('button', { name: 'Save file', exact: true }).click(); await saved;
    await ownerPage.getByRole('button', { name: 'Toggle diff', exact: true }).click();
    await ownerPage.locator('#fileStatus').filter({ hasText: 'journey.txt - diff' }).waitFor();
    await ownerPage.locator('#fileViewer .monaco-diff-editor').waitFor({ state: 'visible' });
    await ownerPage.locator('#fileViewer .view-lines').filter({ hasText: 'Daily customer Git change' }).first().waitFor();
    await ownerPage.locator('#fileViewer .monaco-diff-editor .line-insert, #fileViewer .monaco-diff-editor .char-insert').first().waitFor({ state: 'visible' });
    await shot(ownerPage, 'daily-git-diff'); await ownerPage.locator('#fileCloseBtn').click();
    pass('Daily customer edits and saves a tracked file through UI and opens the actual Git comparison');
  });
  if (process.env.DAILY_GIT_DIAGNOSTIC_ONLY === '1') return;
  await dailyAttempt('Daily Hub roles', async () => {
  stage = 'Daily customer: promote and demote Hub admin';
  await settings(ownerPage);
  await dialog(ownerPage, 'Hub settings').getByRole('button', { name: 'Manage Hub members', exact: true }).click();
  const memberRow = dialog(ownerPage, 'Hub members').locator('.connectionRow').filter({ has: ownerPage.getByText('Journey Member', { exact: true }) });
  await memberRow.getByRole('button', { name: 'Make admin', exact: true }).click();
  await memberRow.getByRole('button', { name: 'Make member', exact: true }).waitFor();
  await shot(ownerPage, 'daily-promoted-admin');
  await memberPage.reload(); await home(memberPage);
  await dialog(memberPage, 'Hubs & computers').getByText('Admin', { exact: true }).waitFor();
  await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer A/ }).waitFor();
  await shot(memberPage, 'daily-admin-sees-computers-without-usage');
  await hubMembers(memberPage);
  await createInvitationLink(memberPage, 'daily-admin-created-invitation-link', '24');
  await dialog(memberPage, 'Hub members').locator('[data-pending-invitation]').getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await dialog(memberPage, 'Hub members').getByText('No pending invitations.', { exact: true }).waitFor();
  await shot(memberPage, 'daily-admin-revoked-pending-invitation');
  await memberRow.getByRole('button', { name: 'Make member', exact: true }).click();
  await memberRow.getByRole('button', { name: 'Make admin', exact: true }).waitFor();
  await backHome(ownerPage); await closeConnections(ownerPage); await card(ownerPage, 'Owner agent A').click();
  pass('Owner promotes Member to Admin; Admin sees all Computers without automatic usage and creates/revokes a pending Member invitation link; Owner restores Member role');
  });
  await dailyAttempt('Daily simultaneous identities', async () => {
    stage = 'Daily customer: add second provider identity on same device';
    await settings(ownerPage);
    await dialog(ownerPage, 'Hub settings').getByRole('button', { name: 'Add sign-in', exact: true }).click();
    const popupPromise = ownerContext.waitForEvent('page'); void popupPromise.catch(() => {});
    await dialog(ownerPage, 'Sign in to Hub').getByRole('button', { name: 'Continue with Feishu', exact: true }).click();
    const popup = await popupPromise; const closed = popup.waitForEvent('close'); void closed.catch(() => {});
    await popup.getByRole('button', { name: 'Sign in as Journey Member', exact: true }).click(); await closed;
    await dialog(ownerPage, 'Hubs & computers').waitFor({ state: 'visible' }); await home(ownerPage);
    await dialog(ownerPage, 'Hubs & computers').getByText('Journey Owner', { exact: true }).first().waitFor();
    await dialog(ownerPage, 'Hubs & computers').getByText('Journey Member', { exact: true }).waitFor();
    assert.equal(await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: /Computer A/ }).count(), 1);
    assert.equal(await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).count(), 1);
    await shot(ownerPage, 'daily-two-provider-identities-one-device');
    await closeConnections(ownerPage); await card(ownerPage, 'Owner agent A').click();
    pass('Daily customer adds a second verified provider identity on the same device and sees deduplicated Computer resources without merging accounts');
  });
  await dailyAttempt('Daily create duplicate and delete', async () => {
    stage = 'Daily customer: duplicate launch settings';
    await card(ownerPage, 'Owner agent A').hover();
    await card(ownerPage, 'Owner agent A').getByRole('button', { name: 'Duplicate session', exact: true }).click();
    const copy = dialog(ownerPage, 'New agent');
    await copy.waitFor({ state: 'visible' });
    await copy.getByText('Create a new agent on this Computer and runtime. Review its provider, model and launch settings before creating it.', { exact: true }).waitFor();
    assert.match(await copy.getByLabel('Computer & hub', { exact: true }).locator('option:checked').innerText(), /Computer A/);
    assert.equal(await copy.getByLabel('Runtime', { exact: true }).inputValue(), 'pi');
    await copy.getByText('More', { exact: true }).click();
    assert.equal(await copy.getByLabel('Working directory', { exact: true }).inputValue(), workspaceA);
    await shot(ownerPage, 'daily-duplicate-private-credentials-required');
    await copy.getByLabel('Agent name', { exact: true }).fill('Daily disposable duplicate');
    await copy.locator('[data-catalog-status]').filter({ hasText: 'Provider and model choices were read' }).waitFor();
    await copy.getByLabel('Runtime', { exact: true }).selectOption('pi');
    await copy.getByLabel('Provider', { exact: true }).selectOption({ label: 'Custom API' });
    assert.equal(await copy.getByLabel('API key', { exact: true }).inputValue(), '', 'Duplicate must require re-entry rather than copy saved secrets');
    await copy.getByLabel('API URL', { exact: true }).fill(origin + '/controlled-models/v1');
    await copy.getByLabel('API key', { exact: true }).fill('controlled-no-live-secret');
    await copy.getByLabel('API compatibility', { exact: true }).selectOption('anthropic-messages');
    await copy.getByLabel('Custom model', { exact: true }).fill('journey-model');
    await copy.getByLabel('Requested reasoning', { exact: true }).selectOption('low');
    await copy.getByRole('button', { name: 'Create agent', exact: true }).click();
    await copy.waitFor({ state: 'hidden' }); await card(ownerPage, 'Daily disposable duplicate').waitFor();
    await shot(ownerPage, 'daily-duplicate-created');
    stage = 'Daily customer: cancel then confirm deletion';
    const duplicate = card(ownerPage, 'Daily disposable duplicate');
    await duplicate.hover(); await duplicate.getByRole('button', { name: 'Delete session', exact: true }).click();
    await ownerPage.locator('#appConfirmCancelBtn').click(); await duplicate.waitFor();
    await duplicate.hover(); await duplicate.getByRole('button', { name: 'Delete session', exact: true }).click();
    await ownerPage.locator('#appConfirmConfirmBtn').click(); await duplicate.waitFor({ state: 'hidden' });
    await ownerPage.reload(); await card(ownerPage, 'Owner agent A').waitFor();
    assert.equal(await card(ownerPage, 'Daily disposable duplicate').count(), 0);
    await shot(ownerPage, 'daily-deleted-after-reload'); await card(ownerPage, 'Owner agent A').click();
    pass('Duplicate opens New agent on the source Computer/runtime/directory without copying secrets; customer re-enters credentials, cancels deletion once, confirms deletion, and verifies it remains absent after reload');
  });
  await dailyAttempt('Daily rename and snooze', async () => {
  stage = 'Daily customer: rename priority and snooze';
  await card(ownerPage, 'Owner agent A').hover();
  await card(ownerPage, 'Owner agent A').getByRole('button', { name: 'Edit conversation', exact: true }).click();
  await dialog(ownerPage, 'Edit conversation').getByLabel('Conversation name', { exact: true }).fill('Daily customer agent');
  await ownerPage.locator('#editPriorityRange').focus();
  await ownerPage.locator('#editPriorityRange').press('End');
  await dialog(ownerPage, 'Edit conversation').getByRole('button', { name: '4 hours', exact: true }).click();
  await ownerPage.locator('#editSaveBtn').click();
  await dialog(ownerPage, 'Edit conversation').waitFor({ state: 'hidden' });
  await card(ownerPage, 'Daily customer agent').waitFor(); await shot(ownerPage, 'daily-renamed-snoozed');
  await ownerPage.reload(); await card(ownerPage, 'Daily customer agent').waitFor();
  await card(ownerPage, 'Daily customer agent').hover();
  await card(ownerPage, 'Daily customer agent').getByRole('button', { name: 'Edit conversation', exact: true }).click();
  assert.equal(await ownerPage.locator('#editPriorityRange').inputValue(), '1');
  await shot(ownerPage, 'daily-renamed-priority-persisted'); await ownerPage.locator('#editCloseBtn').click();
  pass('Daily customer renames, sets priority with the keyboard, and snoozes the conversation through Edit; name and priority persist after reload');
  });
  for (const feature of ['Sidebar star/archive/manual drag order: no visible controls found in the exercised card', 'Provider-policy disable/re-enable UI and saved-identity disconnect/session revocation UI: not exercised; separate backend coverage retained', 'Native resume/import (no existing external native CLI session in this fresh managed-only Hub)', 'Live provider answers and device/mobile Safari acceptance (controlled boundary)']) unavailable.push(feature);
}
try {
  const init = await ownerContext.newPage();
  stage = 'initialize: open private link';
  await init.goto(origin + '/initialize?' + new URLSearchParams({ token: initialization.token }));
  assert.equal(new URL(init.url()).searchParams.has('token'), false);
  await shot(init, 'initialization-provider-choice');
  stage = 'initialize: choose Google';
  await init.getByRole('link', { name: 'Continue with Google', exact: true }).click();
  stage = 'initialize: provider identity button';
  await init.getByRole('button', { name: 'Sign in as Journey Owner', exact: true }).waitFor();
  await shot(init, 'initialization-controlled-provider');
  await init.getByRole('button', { name: 'Sign in as Journey Owner', exact: true }).click();
  stage = 'initialize: verified owner callback';
  await init.getByText('Signed in as', { exact: false }).waitFor();
  await shot(init, 'initialized-owner'); await init.close();
  stage = 'owner: connect client';
  await signIn(ownerPage, 'Google', 'owner');
  await ownerPage.getByText('Owner', { exact: true }).waitFor();
  await dialog(ownerPage, 'Hubs & computers').getByText('No computers yet. Add a computer to get started.', { exact: true }).waitFor();
  await shot(ownerPage, 'empty-owner-hub');
  stage = 'owner: Hub settings role and return';
  await settings(ownerPage);
  assert.equal(await dialog(ownerPage, 'Hub settings').getByRole('button', { name: 'Accept invitation', exact: true }).count(), 0);
  await shot(ownerPage, 'owner-hub-settings-role');
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await shot(ownerPage, 'customer-hub-settings-portrait');
  await ownerPage.setViewportSize({ width: 944, height: 560 });
  await shot(ownerPage, 'customer-hub-settings-landscape');
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  await backHome(ownerPage);
  pass('First verified browser identity initializes ownership on an empty independent Hub');
  stage = 'create Computer A'; const workspaceA = await createComputer('Computer A');
  await access('Computer A', 'owner', 'write');
  pass('Owner creates Computer A through UI and explicitly grants only itself execution access');
  stage = 'Owner: create and revoke link before recipient exists';
  await hubMembers(ownerPage);
  const members = dialog(ownerPage, 'Hub members');
  assert.equal(await members.getByText('Journey Member', { exact: true }).count(), 0);
  const revokedInvitation = await createInvitationLink(ownerPage, 'owner-pending-link-before-recipient', '1');
  await members.locator('[data-pending-invitation]').getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await members.getByText('No pending invitations.', { exact: true }).waitFor();
  await shot(ownerPage, 'owner-revoked-pending-link');
  await rejectInvitationLink(revokedInvitation, 'revoked', 'recipient-revoked-link-denied');
  stage = 'Owner: invitation link created before recipient sign-in';
  const invitation = await createInvitationLink(ownerPage, 'owner-created-invitation', '1');
  await members.locator('[data-pending-invitation]').getByText('Member invitation', { exact: true }).waitFor();
  await members.locator('[data-pending-invitation]').getByText(/^Expires /).waitFor();
  await ownerPage.goto(invitation);
  await dialog(ownerPage, 'Hub invitation').getByText('Already a Hub member. Use another identity to join with this invitation.', { exact: true }).waitFor();
  assert.equal(await dialog(ownerPage, 'Hub invitation').getByRole('button', { name: 'Join Hub', exact: true }).count(), 0);
  await shot(ownerPage, 'owner-cannot-join-own-hub-invitation');
  await ownerPage.locator('.connectionPage').getByRole('button', { name: 'Back', exact: true }).click();
  await home(ownerPage);
  stage = 'Recipient: open link and choose enabled provider';
  await memberPage.goto(invitation);
  const preview = dialog(memberPage, 'Hub invitation');
  await preview.getByText('Invitation role:', { exact: false }).waitFor();
  await preview.getByText('Expires:', { exact: false }).waitFor();
  await preview.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Continue with Feishu', exact: true }).waitFor();
  assert.equal(await preview.getByRole('button', { name: 'Join Hub', exact: true }).count(), 0);
  assert.equal(new URLSearchParams(new URL(memberPage.url()).hash.slice(1)).has('invite'), false);
  await shot(memberPage, 'recipient-link-before-sign-in');
  const popupPromise = memberContext.waitForEvent('page'); void popupPromise.catch(() => {});
  await preview.getByRole('button', { name: 'Continue with Feishu', exact: true }).click();
  const popup = await popupPromise;
  const popupClosed = popup.waitForEvent('close'); void popupClosed.catch(() => {});
  await popup.getByRole('button', { name: 'Sign in as Journey Member', exact: true }).waitFor();
  await shot(popup, 'provider-member');
  await popup.getByRole('button', { name: 'Sign in as Journey Member', exact: true }).click(); await popupClosed;
  stage = 'Recipient: review signed-in identity and explicitly join';
  await preview.getByRole('button', { name: 'Join Hub', exact: true }).waitFor();
  assert.match(await preview.getByLabel('Sign-in identity', { exact: true }).locator('option:checked').innerText(), /Journey Member.*feishu/);
  await shot(memberPage, 'member-signed-in-before-explicit-join');
  await preview.getByRole('button', { name: 'Join Hub', exact: true }).click();
  await dialog(memberPage, 'Joined Hub').getByText('Joined as Member. Computer access requires a separate grant.', { exact: true }).waitFor();
  await shot(memberPage, 'member-explicitly-joined-hub');
  await dialog(memberPage, 'Joined Hub').getByRole('button', { name: 'View Hub', exact: true }).click();
  await home(memberPage); await memberPage.getByText('Member', { exact: true }).waitFor();
  await dialog(memberPage, 'Hubs & computers').locator('.connectionHub summary').getByText('Customer Hub', { exact: true }).waitFor();
  await dialog(memberPage, 'Hubs & computers').getByText('No computers are available to these identities. Ask a Hub owner or admin for allowlist access.', { exact: true }).waitFor();
  assert.equal(await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer A/ }).count(), 0);
  await shot(memberPage, 'member-joined-no-computers');
  await closeConnections(memberPage);
  await memberPage.getByText('No accessible agents or Computers. Ask a Hub Owner or Admin for Computer access.', { exact: true }).first().waitFor();
  assert.equal(await memberPage.getByText('Connect a hub to discover sessions.', { exact: true }).first().isVisible().catch(() => false), false);
  await shot(memberPage, 'member-joined-awaiting-computer-access');
  await rejectInvitationLink(invitation, 'already used', 'recipient-used-link-denied');
  unavailable.push('Elapsed invitation expiry: UI configures and displays 1-hour expiry; actual expiry denial requires waiting at least one hour and is covered separately by backend clock tests');
  pass('Owner creates invitation links before recipient exists, revokes a pending link, cannot join its own Hub, and recipient chooses Feishu then explicitly joins Member with no Computer grant; fresh browsers reject revoked and reused links');
  stage = 'Computer B allowlist'; const workspaceB = await createComputer('Computer B');
  await access('Computer B', 'member', 'write');
  await ownerPage.reload(); await home(ownerPage);
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: /Computer A/ }).waitFor();
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).waitFor();
  await dialog(ownerPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).getByText(/Not allowlisted/).waitFor();
  await shot(ownerPage, 'owner-sees-both-with-b-blocked');
  await closeConnections(ownerPage); await ownerPage.locator('#newBtn').click();
  const ownerChoices = dialog(ownerPage, 'New agent').getByLabel('Computer & hub', { exact: true });
  assert.equal(await ownerChoices.locator('option').filter({ hasText: 'Computer B' }).count(), 0);
  await dialog(ownerPage, 'New agent').getByRole('button', { name: 'Cancel', exact: true }).click();
  await memberPage.reload(); await home(memberPage);
  await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).waitFor();
  assert.equal(await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer A/ }).count(), 0);
  await shot(memberPage, 'member-sees-only-b');
  pass('Owner sees both Computers but cannot create on B; Member sees only B with separate explicit allowlists');
  stage = 'managed agents and toolbar';
  await createAgent(ownerPage, 'Computer A', 'Owner agent A', workspaceA); await send(ownerPage, 'Owner UI message');
  await shot(ownerPage, 'owner-agent-a-reply');
  stage = 'Owner toolbar: View file';
  await ownerPage.getByRole('button', { name: 'View file', exact: true }).click();
  await ownerPage.locator('#filePickerInput').fill('journey.txt');
  await ownerPage.locator('#filePickerMenu').getByText('journey.txt', { exact: false }).first().click();
  await ownerPage.locator('#fileViewer').getByText('Customer journey workspace', { exact: false }).first().waitFor();
  await shot(ownerPage, 'owner-view-file'); await ownerPage.locator('#fileCloseBtn').click();
  await createAgent(memberPage, 'Computer B', 'Member agent B', workspaceB); await send(memberPage, 'Member UI message');
  await shot(memberPage, 'member-agent-b-reply');
  stage = 'Member files before explicit workspace grant';
  await memberPage.getByRole('button', { name: 'View file', exact: true }).click();
  await memberPage.locator('#filePickerInput').fill('ungranted-new-file.txt');
  await memberPage.locator('#fileViewer').getByText('Workspace access requires an active computer membership and an explicit owner grant', { exact: false }).first().waitFor();
  assert.equal(await memberPage.locator('#filePickerMenu').getByText(/Create new file:/).count(), 0);
  await memberPage.locator('#filePickerInput').press('Enter');
  assert.equal(await memberPage.locator('#filePickerMenu').getByText(/Create new file:/).count(), 0);
  assert.equal(await memberPage.locator('#fileEditBtn').isDisabled(), true);
  await shot(memberPage, 'member-files-denied-without-create');
  await memberPage.locator('#fileCloseBtn').click();
  pass('Before an explicit workspace grant, Member file access is denied and neither a create-file option nor Enter opens an editor');
  await grantMemberFiles();
  stage = 'Member toolbar: Details';
  await memberPage.getByRole('button', { name: 'Details', exact: true }).click();
  await dialog(memberPage, 'Details').waitFor();
  await dialog(memberPage, 'Details').getByText('journey-model', { exact: true }).first().waitFor();
  await shot(memberPage, 'member-details'); await memberPage.locator('#diagCloseBtn').click();
  stage = 'Member toolbar: View file';
  await memberPage.getByRole('button', { name: 'View file', exact: true }).click();
  await memberPage.locator('#fileViewer').waitFor({ state: 'visible' });
  await memberPage.locator('#filePickerInput').fill('journey.txt');
  await memberPage.locator('#filePickerMenu').getByText('journey.txt', { exact: false }).first().click();
  await memberPage.locator('#fileViewer').getByText('Customer journey workspace', { exact: false }).first().waitFor();
  await shot(memberPage, 'member-view-file'); await memberPage.locator('#fileCloseBtn').click();
  stage = 'Member toolbar: Unattended';
  const unattendedLoaded = memberPage.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/unattended') && response.ok());
  await memberPage.getByRole('button', { name: 'Unattended mode', exact: true }).click();
  await dialog(memberPage, 'Unattended mode settings').waitFor(); await unattendedLoaded;
  await memberPage.getByLabel('Unattended remaining injections', { exact: true }).fill('1');
  await memberPage.getByLabel('Additional request for unattended prompt', { exact: true }).fill('Continue customer journey');
  const saved = memberPage.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/unattended') && response.ok());
  await dialog(memberPage, 'Unattended mode settings').getByText('Unattended mode', { exact: true }).click(); await saved;
  assert.equal(await memberPage.locator('#unattendedEnabled').isChecked(), true);
  await shot(memberPage, 'member-unattended-saved');
  await memberPage.getByRole('button', { name: 'Unattended mode', exact: true }).click();
  await memberPage.getByRole('button', { name: 'Unattended mode', exact: true }).click();
  assert.equal(await memberPage.locator('#unattendedEnabled').isChecked(), true);
  await dialog(memberPage, 'Unattended mode settings').getByText('Unattended mode', { exact: true }).click();
  assert.equal(await memberPage.locator('#unattendedEnabled').isChecked(), false);
  await memberPage.getByRole('button', { name: 'Unattended mode', exact: true }).click();
  pass('Both allowed identities create real managed agents and send through UI; View file, Details and Unattended controls open, with unattended settings saved');
  stage = 'read-only and revocation';
  await access('Computer B', 'member', 'read');
  await memberPage.reload(); await card(memberPage, 'Member agent B').waitFor(); await card(memberPage, 'Member agent B').click();
  await memberPage.locator('.msg.assistant:not(.typing)').filter({ hasText: 'Managed response: Member UI message' }).first().waitFor();
  // Read-only behavior must be visible: the composer/send cannot offer mutation.
  const sendButton = memberPage.locator('#sendBtn');
  await sendButton.waitFor({ state: 'visible' });
  assert.equal(await sendButton.isDisabled(), true, 'Read-only identity must not have an enabled Send action');
  await memberPage.getByRole('button', { name: 'Details', exact: true }).click();
  const readOnlyDetails = dialog(memberPage, 'Details');
  await readOnlyDetails.getByText('journey-model', { exact: true }).first().waitFor();
  assert.equal(await readOnlyDetails.getByRole('button', { name: 'Change model', exact: true }).isDisabled(), true);
  assert.equal(await readOnlyDetails.getByRole('button', { name: 'Change reasoning effort', exact: true }).isDisabled(), true);
  await shot(memberPage, 'details-model-effort-read-only');
  await memberPage.locator('#diagCloseBtn').click();
  await shot(memberPage, 'member-read-only-history');
  pass('Read-only grant retains persisted managed history and disables UI message mutation');
  await access('Computer B', 'member', 'read', true);
  await memberPage.reload(); await home(memberPage);
  await dialog(memberPage, 'Hubs & computers').getByText('Member', { exact: true }).waitFor();
  await dialog(memberPage, 'Hubs & computers').getByText('No computers are available to these identities. Ask a Hub owner or admin for allowlist access.', { exact: true }).waitFor();
  await memberPage.locator('.sessionDiscoveryStatus').getByText('No accessible agents or Computers. Ask a Hub Owner or Admin for Computer access.', { exact: true }).waitFor();
  assert.equal(await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).count(), 0);
  assert.equal(await card(memberPage, 'Member agent B').count(), 0);
  await shot(memberPage, 'member-revoked');
  pass('UI revocation removes Member access to Computer B and its existing agent after reload');
  if (process.env.DAILY_EXERCISE === '1') await dailyCustomer(workspaceA);
  if (failures.length) { process.exitCode = 1; } else passed = true;
} catch (error) {
  // Do not dump errors with private URLs, pairing/invitation codes or browser DOM.
  const detail = error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 2000) : 'UnknownError';
  failures.push('Customer journey failed during ' + stage + ': ' + detail);
  console.error(failures.at(-1));
  for (const [index, tab] of browser.contexts().flatMap(context => context.pages()).entries())
    await shot(tab, 'failure-page-' + index).catch(() => {});
  process.exitCode = 1;
} finally {
  const clientBuild = await ownerPage.evaluate(() => ({ origin: location.origin, loadedAssetVersion: window.CODOXEAR_ASSET_VERSION })).catch(() => ({ origin: clientOrigin, loadedVersionUnavailable: true }));
  // Read-only deployment provenance: direct static asset HTTP metadata, never an application mutation.
  const publicRelease = await ownerContext.request.get(clientOrigin + '/client-release.json').then(async response => ({ releaseStatus: response.status(), publicReleaseVersion: (await response.json()).version })).catch(() => ({ releaseUnavailable: true }));
  Object.assign(clientBuild, publicRelease);
  const result = { passed, stage, checks, failures, screenshots, unavailable, browserDiagnostics, clientSurface: process.env.CODOXEAR_CUSTOMER_CLIENT_ORIGIN ? 'Public deployed frontend' : 'Separate local static frontend',
    clientBuild,
    applicationActions: 'Browser UI only; no API authentication, membership, grants, Computer creation or agent seeding',
    oauthBoundary: 'Controlled Google/Feishu provider pages with explicit browser identity buttons; no live-provider acceptance',
    runtimeBoundary: 'Real ManagedRuntime, ComputerService and NativeHttpTarget; browser model discovery traverses the actual Hub tunnel and Computer HTTP fetch to controlled caller-key model/metadata endpoints; thin deterministic ManagedFactory advertises images/steer and records driver input, no live LLM or native OAR profile/image acceptance',
    externalBootstrap, browserPermissionSetup: process.env.CODOXEAR_CUSTOMER_CLIENT_ORIGIN ? 'Public-origin local-network-access and clipboard permissions granted to automated browser; no application grants injected' : 'Clipboard permissions only',
    physicalBootstrapBoundary: 'Computer attachment and start are external infrastructure operations, not browser-only product support', cleanup: [] };
  const saveResult = () => writeFileSync(join(artifacts, 'results.json'), JSON.stringify(result, null, 2));
  saveResult();
  // This watchdog belongs only to this ephemeral Docker test process. Never let
  // a failed assertion hold the shared verification lock through a hung close.
  const watchdog = setTimeout(() => {
    result.passed = false;
    failures.push('Infrastructure teardown exceeded its 45-second bound');
    result.cleanup.push('Teardown exceeded 45 seconds; terminating owned Docker test process');
    saveResult(); process.exit(1);
  }, 45000);
  watchdog.unref();
  async function closeOwned(label, action, milliseconds = 8000) {
    result.cleanup.push('Closing ' + label); saveResult();
    let timer;
    try {
      await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Close timeout')), milliseconds); })]);
      result.cleanup.push('Closed ' + label);
    } catch {
      result.passed = false; process.exitCode = 1;
      failures.push('Infrastructure teardown failed or timed out: ' + label);
      result.cleanup.push('Close failed or timed out: ' + label);
    } finally { clearTimeout(timer); saveResult(); }
  }
  await closeOwned('browser', () => browser.close());
  await closeOwned('Hub tunnels', () => tunnels.close());
  for (const [index, service] of services.reverse().entries()) await closeOwned('Computer service ' + index, () => service.stop());
  if (staticClient) await closeOwned('static client', () => { staticClient.closeAllConnections(); return new Promise(resolve => staticClient.close(resolve)); });
  await closeOwned('Hub server', () => { hub.server.closeAllConnections(); return hub.close(); });
  await closeOwned('Hub identity', () => authority.identity.close());
  await closeOwned('databases', () => { sessions.close(); store.close(); });
  await closeOwned('scratch workspace', () => rm(scratch, { recursive: true, force: true }));
  if (result.cleanup.some(entry => entry.startsWith('Close failed'))) process.exit(1);
}

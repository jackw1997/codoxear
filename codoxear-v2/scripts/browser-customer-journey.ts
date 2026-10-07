// @ts-nocheck -- Docker-only browser acceptance, controlled OAuth and managed-driver boundary.
import './testing/frontend-artifact.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { initializeHub, hubSetup } from '../src/auth/hub-setup.js';
import { independentAuthority } from '../src/hub/independent.js';
import { createHubApp } from '../src/hub/app.js';
import { HubSessions } from '../src/hub/sessions.js';
import { Tunnels } from '../src/protocol/tunnels.js';
import { createComputerApi } from '../src/computer/api.js';
import { ManagedRuntime } from '../src/computer/managed/runtime.js';
import { createStaticServer } from '../frontend/serve.mjs';
assert.ok(existsSync('/.dockerenv'), 'Customer journey must run in Docker');
const artifacts = process.env.CUSTOMER_JOURNEY_ARTIFACTS ?? '/opt/codoxear/artifacts/customer-journey';
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'customer-journey-'));
const origin = 'http://127.0.0.1:19964', clientOrigin = 'http://127.0.0.1:19965';
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
await hub.listen({ host: '127.0.0.1', port: 19964 });
const staticClient = createStaticServer();
await new Promise(resolve => staticClient.listen(19965, '127.0.0.1', resolve));
// Thin deterministic managed transport only. Runtime persistence, queue, authorization,
// files, HTTP relay, Computer service and Hub endpoints remain the production implementations.
class ControlledManagedSession {
  id; observer; sequence = 0;
  constructor(id) { this.id = id; }
  rawEvents(observer) { this.observer = observer; return () => { this.observer = undefined; }; }
  async prompt(text) {
    setTimeout(() => this.observer?.({ kind: 'frame', seq: this.sequence++, sessionId: this.id,
      receivedAt: Date.now(), agentPath: [], body: { events: [
        { kind: 'text_delta', text: 'Managed response: ' + text },
        { kind: 'turn_ended', outcome: { kind: 'completed' } },
      ] } }), 20);
    return { kind: 'accepted' };
  }
  async abort() { return { kind: 'accepted' }; }
  async dispose() { this.observer = undefined; }
}
const factory = { async open(options) { return new ControlledManagedSession(options.resume ?? randomUUID()); } };
const services = [];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
for (const context of [ownerContext, memberContext]) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: clientOrigin });
const ownerPage = await ownerContext.newPage(), memberPage = await memberContext.newPage();
const checks = [], screenshots = [], failures = [], externalBootstrap = [];
let stage = 'initialize owner', passed = false;
for (const page of [ownerPage, memberPage]) { page.setDefaultTimeout(30000); page.on('pageerror', () => failures.push('Browser runtime exception')); }
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const pass = text => { checks.push(text); console.log('PASS', text); };
async function shot(page, name) {
  const path = join(artifacts, name + '.png');
  await page.screenshot({ path, fullPage: true, mask: [page.locator('[data-code], [data-command], output, input[name="token"], input[type="password"]')] });
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
}
async function settings(page) { await home(page); await dialog(page, 'Hubs & computers').getByRole('button', { name: 'Hub settings', exact: true }).click(); }
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
  const api = createComputerApi(homePath);
  await api.enroll({ enrollment: { identityUrl: origin, code }, runtime: 'oar', nativeHome: homePath,
    nativeStateHome: homePath, workspacePath: workspace, oarPermissionPolicy: 'locally-trusted' });
  const service = api.service(undefined, { runtime: () => new ManagedRuntime({ databasePath: join(homePath, 'managed.sqlite'), home: homePath, stateHome: homePath, workspace, factory }) });
  services.push(service); await service.start();
  externalBootstrap.push({ computer: name, operation: 'External Computer enroll and service start using the pairing code generated in browser', runtime: 'Real ManagedRuntime with controlled ManagedFactory' });
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
  await create.getByLabel('Provider', { exact: true }).selectOption({ label: 'Custom API' });
  await create.getByLabel('API URL', { exact: true }).fill('https://controlled.invalid/v1');
  await create.getByLabel('API key', { exact: true }).fill('controlled-no-live-secret');
  await create.getByLabel('Custom model', { exact: true }).fill('journey-model');
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
  await settings(ownerPage); await shot(ownerPage, 'owner-hub-settings-role'); await backHome(ownerPage);
  pass('First verified browser identity initializes ownership on an empty independent Hub');
  stage = 'create Computer A'; const workspaceA = await createComputer('Computer A');
  await access('Computer A', 'owner', 'write');
  pass('Owner creates Computer A through UI and explicitly grants only itself execution access');
  stage = 'second identity and invitation';
  await signIn(memberPage, 'Feishu', 'member');
  await memberPage.getByText('Not a member', { exact: true }).waitFor();
  await shot(memberPage, 'member-before-invitation');
  await settings(memberPage);
  await dialog(memberPage, 'Hub settings').getByRole('button', { name: 'Sign-in methods', exact: true }).click();
  await dialog(memberPage, 'Sign-in methods').getByRole('button', { name: 'Copy invitation details', exact: true }).click();
  const invitationIdentity = JSON.parse(await memberPage.evaluate(() => navigator.clipboard.readText()));
  await backHome(memberPage);
  await settings(ownerPage);
  await dialog(ownerPage, 'Hub settings').getByRole('button', { name: 'Manage Hub members', exact: true }).click();
  const members = dialog(ownerPage, 'Hub members');
  await members.getByLabel('Invite by', { exact: true }).selectOption(invitationIdentity.method);
  await members.getByLabel('Sign-in connection').fill(invitationIdentity.connection);
  await members.getByLabel('Identity ID').fill(invitationIdentity.subject);
  await members.getByLabel('Tenant (optional)').fill(invitationIdentity.tenant);
  await members.getByLabel('Hub role', { exact: true }).selectOption('member');
  await members.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await members.locator('output').filter({ hasText: 'Invitation code:' }).waitFor();
  const invitation = (await members.locator('output').innerText()).split(': ')[1];
  await shot(ownerPage, 'owner-created-invitation'); await backHome(ownerPage);
  await settings(memberPage);
  await dialog(memberPage, 'Hub settings').getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await dialog(memberPage, 'Accept invitation').getByLabel('Invitation code').fill(invitation);
  await dialog(memberPage, 'Accept invitation').getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await home(memberPage); await memberPage.getByText('Member', { exact: true }).waitFor();
  assert.equal(await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer A/ }).count(), 0);
  await shot(memberPage, 'member-joined-no-computers');
  pass('Second identity signs in via provider popup, shares invitation identity through UI, and joins through the owner-created UI invitation');
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
  await dialog(memberPage, 'Details').getByText('journey-model', { exact: false }).first().waitFor();
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
  assert.ok(!(await sendButton.isVisible().catch(() => false)) || await sendButton.isDisabled(), 'Read-only identity must not have an enabled Send action');
  await shot(memberPage, 'member-read-only-history');
  pass('Read-only grant retains persisted managed history and disables UI message mutation');
  await access('Computer B', 'member', 'read', true);
  await memberPage.reload(); await home(memberPage);
  assert.equal(await dialog(memberPage, 'Hubs & computers').getByRole('button', { name: /Computer B/ }).count(), 0);
  assert.equal(await card(memberPage, 'Member agent B').count(), 0);
  await shot(memberPage, 'member-revoked');
  pass('UI revocation removes Member access to Computer B and its existing agent after reload');
  assert.deepEqual(failures, []); passed = true;
} catch (error) {
  // Do not dump errors with private URLs, pairing/invitation codes or browser DOM.
  const detail = error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 2000) : 'UnknownError';
  failures.push('Customer journey failed during ' + stage + ': ' + detail);
  console.error(failures.at(-1));
  for (const [index, tab] of browser.contexts().flatMap(context => context.pages()).entries())
    await shot(tab, 'failure-page-' + index).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ passed, stage, checks, failures, screenshots,
    applicationActions: 'Browser UI only; no API authentication, membership, grants, Computer creation or agent seeding',
    oauthBoundary: 'Controlled Google/Feishu provider pages with explicit browser identity buttons; no live-provider acceptance',
    runtimeBoundary: 'Real ManagedRuntime, ComputerService and NativeHttpTarget; thin deterministic ManagedFactory, no live LLM acceptance',
    externalBootstrap, physicalBootstrapBoundary: 'Computer attachment and start are external infrastructure operations, not browser-only product support' }, null, 2));
  await browser.close();
  for (const service of services.reverse()) await service.stop().catch(() => {});
  await new Promise(resolve => staticClient.close(resolve));
  hub.server.closeAllConnections(); await hub.close(); await authority.identity.close(); sessions.close(); store.close();
  await rm(scratch, { recursive: true, force: true });
}

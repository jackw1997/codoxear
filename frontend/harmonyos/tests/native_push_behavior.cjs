// Execute the actual ArkTS token owner with platform boundaries replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('/Applications/DevEco-Studio.app/Contents/tools/ohpm/node_modules/typescript');
const source = path.resolve(__dirname, '../entry/src/main/ets/services/NativePush.ets');
function harness(saved) {
  const files = new Map(saved ? [['/sandbox/native-push.json', saved]] : []);
  const calls = [], reports = [], listeners = new Set();
  let uuid = 0;
  const push = { getToken: async () => 'token-first', deleteToken: async () => { calls.push('delete'); },
    on: (_, ability, cb) => listeners.add(cb), off: (_, cb) => listeners.delete(cb) };
  const io = { OpenMode: { CREATE:1, WRITE_ONLY:2, TRUNC:4 },
    readTextSync: p => {if (!files.has(p)) throw Error('missing');return files.get(p);},
    openSync: p => {files.set(p,'');return {fd:p};}, writeSync: (fd,value) => {files.set(fd,files.get(fd)+Buffer.from(value).toString('utf8'));return value.byteLength;}, closeSync: () => {},
    renameSync: (from,to) => {files.set(to,files.get(from));files.delete(from);} };
  const kits = { '@kit.PushKit':{pushService:push}, '@kit.AbilityKit':{}, '@kit.CoreFileKit':{fileIo:io},
    '@kit.ArkTS':{util:{TextEncoder:class {encodeInto(text){return new Uint8Array(Buffer.from(text));}},generateRandomUUID:()=>'test-device-'+String(++uuid).padStart(24,'0')}},
    '@kit.NetworkKit':{http:{RequestMethod:{POST:'POST'}}}, './ApiClient':{} };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:name=>kits[name]},{filename:source});
  const owner = new exports.NativePush();owner.initialize('/sandbox');owner.bind({});
  const api = { address: ()=>'https://one.example/api/me', request:async (url,method,body)=> {
    if (!body) return '{"configured":true}';
    const value=JSON.parse(body);calls.push(value);return JSON.stringify({registered:value.enabled});
  }};
  return {owner,files,push,io,api,calls,reports,listeners,report:m=>reports.push(m),saved:()=>files.get('/sandbox/native-push.json')};
}
async function settle() {for(let i=0;i<20;i++)await Promise.resolve();}
async function main() {
  // Explicit opt-in is the first provider call; successful restart retains identity.
  const h=harness();assert.equal(h.owner.hasRegistration(),false);assert.equal(h.calls.length,0);
  assert.equal(await h.owner.enable(h.api,h.report),true);
  const first=JSON.parse(h.saved());assert.equal(first.token,'token-first');assert.equal(h.listeners.size,1);
  const restored=harness(h.saved());assert.equal(restored.owner.requested(restored.api.address()),true);
  restored.push.getToken=async()=>'token-second';await restored.owner.enable(restored.api,restored.report);
  assert.equal(JSON.parse(restored.saved()).device_id,first.device_id);
  assert.equal(restored.calls[0].token,'token-second');
  for(const cb of restored.listeners)cb('token-rotated');await settle();
  assert.equal(restored.calls.at(-1).token,'token-rotated');
  await restored.owner.disable(restored.api);
  assert.equal(restored.calls.at(-2).enabled,false);assert.equal(restored.calls.at(-1),'delete');
  assert.equal(restored.saved(),'null');assert.equal(restored.listeners.size,0);

  // Failed local persistence must never send a token whose recovery was lost.
  const disk=harness();disk.io.writeSync=()=>0;
  await assert.rejects(disk.owner.enable(disk.api,disk.report),/write was incomplete/);
  assert.equal(disk.calls.length,0);

  // Lost POST acknowledgement survives restart and can be revoked.
  const lost=harness();lost.api.request=async(_,method)=>{if(!method)return '{"configured":true}';throw Error('lost response');};
  await assert.rejects(lost.owner.enable(lost.api,lost.report),/lost response/);
  const recovered=harness(lost.saved());await recovered.owner.disable(recovered.api);
  assert.equal(recovered.calls[0].token,'token-first');assert.equal(recovered.calls[0].enabled,false);
  assert.equal(recovered.owner.hasRegistration(),false);

  // Server unavailable: revoke through provider. Provider unavailable: server
  // deletion suffices, but the inactive token remains for a later cleanup attempt.
  const offline=harness(h.saved());offline.api.request=async()=>{throw Error('offline');};
  await offline.owner.disable(offline.api);assert.deepEqual(offline.calls,['delete']);
  const providerDown=harness(h.saved());providerDown.push.deleteToken=async()=>{throw Error('provider offline');};
  await providerDown.owner.disable(providerDown.api);
  assert.equal(providerDown.owner.requested(providerDown.api.address()),false);
  assert.equal(providerDown.owner.hasRegistration(),true);
  const bothDown=harness(h.saved());bothDown.api.request=offline.api.request;bothDown.push.deleteToken=providerDown.push.deleteToken;
  await assert.rejects(bothDown.owner.disable(bothDown.api),/Unable to disable/);
  assert.equal(bothDown.owner.hasRegistration(),true);

  // Old server tokens must be revoked before registering on another connection.
  const switcher=harness(h.saved());switcher.api.address=()=>'https://two.example/api/me';
  await switcher.owner.enable(switcher.api,switcher.report);
  assert.equal(switcher.calls[0],'delete');assert.equal(switcher.calls[1].server,switcher.api.address());

  // Unsupported backend and unsigned app have an explicit foreground fallback.
  for(const fail of ['old','unconfigured','unsigned']) {
    const fallback=harness();
    if(fail==='old')fallback.api.request=async()=>{throw Object.assign(Error('not found'),{status:404});};
    if(fail==='unconfigured')fallback.api.request=async()=>'{"configured":false,"reason":"not provisioned"}';
    if(fail==='unsigned')fallback.push.getToken=async()=>{throw Error('not signed');};
    assert.equal(await fallback.owner.enable(fallback.api,fallback.report),false);
    assert.match(fallback.reports.at(-1),/App running only/);assert.equal(fallback.owner.hasRegistration(),false);
    const again=harness(fallback.saved());assert.equal(again.owner.requested(again.api.address()),true);
    await again.owner.disable(again.api);assert.equal(again.saved(),'null');assert.equal(again.calls.length,0);
  }
  const auth=harness();auth.api.request=async()=>{throw Object.assign(Error('login expired'),{status:401});};
  await assert.rejects(auth.owner.enable(auth.api,auth.report),/login expired/);

  // Disposal during an in-flight enable must not reattach callbacks to the old UI.
  const closing=harness();let release;
  closing.push.getToken=()=>new Promise(resolve=>{release=resolve;});
  const enabling=closing.owner.enable(closing.api,closing.report);await settle();
  closing.owner.detach();release('token-late');await enabling;
  assert.equal(closing.listeners.size,0);
  await closing.owner.revokeLocal();assert.equal(closing.owner.hasRegistration(),false);

  // A disable queues behind registration so a late acknowledgement cannot
  // restore the subscription after the user has disabled it.
  const racing=harness();let registered;
  racing.api.request=async(_,method,body)=>{
    if(!method)return '{"configured":true}';const value=JSON.parse(body);racing.calls.push(value);
    if(value.enabled)return new Promise(resolve=>{registered=()=>resolve('{"registered":true}');});
    return '{"registered":false}';
  };
  const on=racing.owner.enable(racing.api,racing.report);await settle();
  const off=racing.owner.disable(racing.api);registered();await Promise.all([on,off]);
  assert.equal(racing.saved(),'null');assert.equal(racing.calls.filter(x=>typeof x==='object').at(-1).enabled,false);
  console.log('PASS native push ownership: opt-in, restart, rotation, lost acknowledgement, revocation, fallback and lifecycle races');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

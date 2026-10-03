// Execute the actual vault code with an in-memory OS boundary; real AssetStore
// persistence, login, restart and logout are covered by native_saved_login.py.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('/Applications/DevEco-Studio.app/Contents/tools/ohpm/node_modules/typescript');
const asset = {
  Tag: { ALIAS: 1, SECRET: 2, ACCESSIBILITY: 3, RETURN_TYPE: 4, CONFLICT_RESOLUTION: 5 },
  Accessibility: { DEVICE_UNLOCKED: 2 }, ConflictResolution: { OVERWRITE: 0 },
  ReturnType: { ALL: 0 }, ErrorCode: { NOT_FOUND: 24000002 }
};
let stored, fault, writes = 0;
asset.query = async () => { if (fault) throw fault; if (!stored) throw {code: 24000002}; return [stored]; };
asset.add = async attrs => { if (fault) throw fault; writes++; stored = new Map(attrs); };
asset.remove = async () => { if (fault) throw fault; if (!stored) throw {code: 24000002}; stored = undefined; };
const exportsObject = {};
const kits = {'@kit.AssetStoreKit':{asset}, '@kit.BasicServicesKit':{}, '@kit.ArkTS':{util:{
  TextEncoder: class { encodeInto(v) { return new TextEncoder().encode(v); } },
  TextDecoder: {create: () => ({decodeWithStream: v => new TextDecoder().decode(v)})}
}}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../entry/src/main/ets/services/SavedLogin.ets','utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText, {exports:exportsObject, require:name=>kits[name]});
(async () => {
  const vault = new exportsObject.SavedLogin();
  assert.equal(await vault.password('https://one.test'), ''); await vault.clear();
  await vault.save(' https://one.test/// ', 'p密🐟');
  assert.equal(await new exportsObject.SavedLogin().password('https://one.test/'), 'p密🐟');
  for (const endpoint of ['http://one.test','https://one.test:443','https://two.test','https://one.test/other'])
    assert.equal(await vault.password(endpoint), '', 'credentials must not cross endpoints');
  assert.equal(stored.get(asset.Tag.ACCESSIBILITY), asset.Accessibility.DEVICE_UNLOCKED);
  assert.equal(new TextDecoder().decode(stored.get(asset.Tag.ALIAS)), 'codoxear.saved-login.v1');
  await vault.save('https://two.test', 'replacement');
  assert.equal(await vault.password('https://one.test'), '');
  assert.equal(await vault.password('https://two.test'), 'replacement');
  const before=writes; await assert.rejects(vault.save('https://two.test','x'.repeat(1025)), /too long/);
  assert.equal(writes,before); assert.equal(await vault.password('https://two.test'), 'replacement');
  fault={code:999};
  await assert.rejects(vault.password('https://two.test'), /Unable to read/);
  await assert.rejects(vault.clear(), /Unable to remove/);
  await assert.rejects(vault.save('https://two.test','secret'), /could not be saved/);
  fault=undefined; await vault.clear(); assert.equal(await vault.password('https://two.test'), '');
  const add=asset.add; let release, started;
  const running=new Promise(resolve=>{started=resolve});
  asset.add=async attrs=>{started();await new Promise(resolve=>{release=resolve});await add(attrs)};
  const saving=vault.save('https://one.test','racing'); await running;
  const clearing=vault.clear(); release(); await Promise.all([saving,clearing]);
  assert.equal(await vault.password('https://one.test'),'','logout must win over an in-flight save');
  console.log('PASS saved login: Unicode, normalization, endpoint isolation, overwrite, size limit, OS failures and removal');
})().catch(e=>{console.error(e);process.exit(1)});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { Store } from "../src/persistence/store.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { NotificationInbox } from "../src/hub/notifications.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import { createHub, createComputer, passwordHash, reserveAgent } from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const callback = "codoxear-v2://oauth/callback";
async function hub(origin: string) {
  const store = new Store(":memory:");
  store.change(s => s.users.push({id:"alice",name:"Alice",email:"alice@native.invalid",passwordHash:passwordHash("native-test-password"),disabled:false}));
  const created = store.change(s => createComputer(s,"alice",createHub(s,"alice","Native fixture").id,"Computer","alice"));
  store.change(s => {const agent=reserveAgent(s,"alice",created.computer.id,"Native tap","pi");agent.state="ready";agent.localId="native-session";});
  const local = await independentAuthority({origin,store,hubId:created.computer.hubId,otpKey:"native-test-key".repeat(4),clients:[{id:"codoxear-harmony",redirectUris:[callback]}],secureCookies:false});
  const signed = local.authority.accounts.password("alice@native.invalid","native-test-password","browser");
  const sessions = new HubSessions(":memory:");
  const inbox = new NotificationInbox(":memory:",created.computer.hubId,async()=>{}, {testMessage:true, supports: p=>p==="harmony",async send(){return "sent";}});
  const app = await createHubApp({origin,authority:local.client,localIdentity:local.identity,sessions,tunnels:new Tunnels(),notifications:inbox,secureCookies:false,webRoot:"/no-assets"});
  return {origin,app,local,store,signed,inbox,computer:created.computer,async close(){await app.close();await local.identity.close();sessions.close();inbox.close();store.close();}};
}
async function fixture() {
  const hubs = await Promise.all([hub("https://native-a.test"),hub("https://native-b.test")]);
  const values = new Map<string,Uint8Array>(), calls: Array<{url:string;body:any;authorization:string}> = [], browsers: string[] = [];
  let locked = false, now = Date.now(), loseRefresh = false, rotations = 0, deletedTokens = 0, token = "native-installation-push-1";
  let update: ((token:string)=>void)|undefined;
  const mockAsset = {Tag:{ALIAS:"alias",SECRET:"secret",RETURN_TYPE:"return",ACCESSIBILITY:"access",CONFLICT_RESOLUTION:"conflict"}, ReturnType:{ALL:"all"}, Accessibility:{DEVICE_UNLOCKED:"unlocked"},ConflictResolution:{OVERWRITE:"overwrite"},ErrorCode:{NOT_FOUND:404},
    async query(query:Map<string,any>) { if(locked)throw Object.assign(Error("locked"),{code:423});const key=Buffer.from(query.get("alias")).toString(), value=values.get(key);if(!value)throw Object.assign(Error("missing"),{code:404});return[new Map([["secret",value]])]; },
    async add(attributes:Map<string,any>){if(locked)throw Error("locked");assert.equal(attributes.get("access"),"unlocked");assert.ok(attributes.get("secret").length<=1024);values.set(Buffer.from(attributes.get("alias")).toString(),new Uint8Array(attributes.get("secret")));},
    async remove(query:Map<string,any>){if(locked)throw Error("locked");values.delete(Buffer.from(query.get("alias")).toString());}};
  const http = {RequestMethod:{GET:"GET",POST:"POST",DELETE:"DELETE"},HttpDataType:{STRING:"text",ARRAY_BUFFER:"binary"},createHttp(){return{destroy(){},async request(url:string,options:any){
    const address=new URL(url), h=hubs.find(h=>h.origin===address.origin);assert.ok(h,"No external identity/Hub request");
    const body=options.extraData?JSON.parse(options.extraData):undefined;calls.push({url,body,authorization:options.header.Authorization??""});
    const response=await h.app.inject({method:options.method,url:address.pathname+address.search,headers:options.header,...(options.extraData?{payload:options.extraData}:{})});
    if(body?.grant_type==="refresh_token"){rotations++;if(loseRefresh)throw Error("Response lost after actual Hub rotation");}
    return{responseCode:response.statusCode,result:response.body,header:response.headers,cookies:""};}};}};
  const util = {TextEncoder:class{encodeInto(value:string){return new TextEncoder().encode(value);}},TextDecoder:{create(){return{decodeWithStream(value:Uint8Array){return new TextDecoder().decode(value);}};}},Base64Helper:class{encodeToStringSync(value:Uint8Array){return Buffer.from(value).toString("base64");}}};
  const cryptoFramework={createRandom(){return{generateRandomSync(size:number){return{data:new Uint8Array(randomBytes(size))};}};},createMd(){let data:Uint8Array;return{async update(value:{data:Uint8Array}){data=value.data;},async digest(){return{data:new Uint8Array(createHash("sha256").update(data!).digest())};}};}};
  const modules=new Map<string,any>();
  function load(file:string):any{
    file=resolve(file);if(modules.has(file))return modules.get(file);
    const exports:any={};modules.set(file,exports);
    const source=readFileSync(file,"utf8"), transpiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true},reportDiagnostics:true});
    assert.deepEqual(transpiled.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error),[],file);
    vm.runInNewContext(transpiled.outputText,{exports,Observed:(value:any)=>value,Date:class extends Date{static override now(){return now;}},console,setTimeout,clearTimeout,Uint8Array,Map,JSON,encodeURIComponent,decodeURIComponent,
      require:(name:string)=>name.startsWith(".")?load(resolve(dirname(file),name+".ets")):name==="@kit.AssetStoreKit"?{asset:mockAsset}:name==="@kit.NetworkKit"?{http}:name==="@kit.ArkTS"?{util,url:{URL}}:name==="@kit.CryptoArchitectureKit"?{cryptoFramework}:name==="@kit.PushKit"?{pushService:{async getToken(){return token;},async deleteToken(){deletedTokens++;},on(_event:string,_ability:unknown,fn:(token:string)=>void){update=fn;},off(){update=undefined;}}}:{}},{filename:file});return exports;
  }
  const directory="native/harmony/entry/src/main/ets/services/", {IdentityPlatform,AssetVault,PushKitInstallation}=load(directory+"IdentityPlatform.ets"),{HubAccounts}=load(directory+"HubAccounts.ets"),{HubPush}=load(directory+"HubPush.ets");
  const platform=new IdentityPlatform({async openLink(url:string){browsers.push(url);}}),vault=new AssetVault(platform),provider=new PushKitInstallation({});
  const accounts=new HubAccounts(vault,platform,"native-installation"),push=new HubPush(accounts,vault,provider,"native-installation");
  async function begin(index:number){await accounts.begin(hubs[index]!.origin);const url=new URL(browsers.at(-1)!);const h=hubs[index]!;const response=await h.app.inject({url:url.pathname+url.search,cookies:{["codoxear_identity_"+h.computer.hubId]:h.signed.credential}});assert.equal(response.statusCode,302,response.body);return String(response.headers.location);}
  async function login(index:number){return accounts.finish(await begin(index));}
  const {ApiClient}=load(directory+"ApiClient.ets");
  const {NativeApp}=load(directory+"../model/NativeApp.ets");
  return {accounts,push,provider,platform,vault,values,calls,hubs,login,begin,classes:{HubAccounts,HubPush,ApiClient,NativeApp},advance(){now+=360000;},lock(value:boolean){locked=value;},lose(){loseRefresh=true;},rotations:()=>rotations,deleted:()=>deletedTokens,async updated(value:string){token=value;update?.(value);await push.updateToken(value);},async close(){push.dispose();await Promise.all(hubs.map(h=>h.close()));}};
}
test("native presenter completes exact per-Hub system-browser callbacks, cancel/restart and two-account selection with actual independent OAuth",async()=>{
 const f=await fixture();try{
  const callback=await f.begin(0);await assert.rejects(f.accounts.finish(callback.replace("codoxear-v2:","other-app:")),/application/);
  await f.accounts.cancel();await assert.rejects(f.accounts.finish(callback),/expired/);
  const first=await f.login(0),second=await f.login(1);assert.notEqual(first,second);assert.equal(f.accounts.accounts.length,2);assert.deepEqual(Array.from(f.accounts.accounts,(a:any)=>a.accountId),["alice","alice"]);
  f.accounts.select(first);assert.equal((await f.accounts.computers(first))[0].id,f.hubs[0]!.computer.id);
  const restored=new f.classes.HubAccounts(f.vault,f.platform,"native-installation");await restored.restore();assert.equal(restored.accounts.length,2);await restored.computers(second);
  assert.ok(f.calls.every(c=>new URL(c.url).origin===f.hubs[0]!.origin||new URL(c.url).origin===f.hubs[1]!.origin));
  assert.ok([...f.values.keys()].every(k=>/^codoxear\.native\.v2\.[A-Za-z0-9_-]+$/.test(k)));assert.ok(!JSON.stringify(f.accounts.accounts).includes("refreshToken"));
 }finally{await f.close();}
});
test("delivered native account presenter restores the collection and Computer choices and clears presentation on device lock",async()=>{
 const f=await fixture();try{
  const key=await f.login(0),presenter=new f.classes.NativeApp(f.vault,f.platform,f.provider,"native-installation");
  await presenter.initialize("/mock-native-storage");await presenter.chooseAccount(key);assert.equal(presenter.computers[0].id,f.hubs[0]!.computer.id);assert.equal(presenter.accounts.selected,key);assert.equal(presenter.error,"");
  presenter.background();assert.equal(presenter.accounts.selected,"");assert.equal(presenter.computers.length,0);assert.equal(presenter.workspace.authenticated,false);assert.equal(presenter.accounts.accounts.length,1);presenter.dispose();
 }finally{await f.close();}
});
test("delivered native project has no missing or outside-project imports",()=>{
 const root=resolve("native/harmony");let count=0;
 const walk=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const file=resolve(directory,entry.name);if(entry.isDirectory()){walk(file);continue;}if(!/\.(?:ets|ts)$/.test(file))continue;
  const source=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  for(const declaration of source.statements){if(!ts.isImportDeclaration(declaration)||!ts.isStringLiteral(declaration.moduleSpecifier))continue;const name=declaration.moduleSpecifier.text;if(!name.startsWith("."))continue;const target=resolve(dirname(file),name);assert.ok(target.startsWith(root+"/"),file);assert.ok([".ets",".ts",".js"].some(extension=>existsSync(target+extension))||existsSync(target),file+" imports missing "+name);count++;}
 }};walk(root);assert.ok(count>0);
});
test("delivered native ApiClient refreshes scoped credentials before invocation and fences a switched account before any mutation",async()=>{
 const f=await fixture();try{
  const key=await f.login(0),account=f.accounts.accounts[0],computer=(await f.accounts.computers(key))[0],client=new f.classes.ApiClient();
  const profile={endpoint:account.origin,issuer:account.origin,accountId:account.accountId,hubId:account.hubId,computerId:computer.id,accessToken:await f.accounts.token(key),tokenProvider:()=>f.accounts.token(key)};
  client.configureRelay(profile);assert.equal(JSON.parse(await client.request("/api/me")).user.id,"alice");
  f.advance();const before=f.rotations();await client.request("/api/me");assert.equal(f.rotations()-before,1);
  let release!:(value:string)=>void;const pendingToken=new Promise<string>(resolve=>{release=resolve;});
  client.configureRelay({...profile,tokenProvider:()=>pendingToken});const calls=f.calls.length,send=client.request("/api/sessions/broker-"+"b".repeat(32)+"/send","POST",JSON.stringify({text:"must not send"}));
  client.configure("https://direct.test");release(profile.accessToken);await assert.rejects(send,/superseded/);assert.equal(f.calls.length,calls);
 }finally{await f.close();}
});
test("OS secure vault locks preserve credentials; rotation is serialized per account and a lost result requires new login",async()=>{
 const f=await fixture();try{
  const key=await f.login(0);await f.accounts.token(key);f.advance();const before=f.rotations();await Promise.all([f.accounts.token(key),f.accounts.token(key),f.accounts.computers(key)]);assert.equal(f.rotations()-before,1);
  f.accounts.lock();f.lock(true);await assert.rejects(f.accounts.token(key),/Unlock/);await assert.rejects(f.vault.write("locked-write","must not persist"),/locked/);await assert.rejects(f.vault.remove("account:"+key),/locked/);f.lock(false);assert.ok(await f.vault.read("account:"+key));assert.equal(await f.vault.read("locked-write"),null);await f.accounts.token(key);
  f.advance();f.lose();await assert.rejects(f.accounts.token(key),/lost/);assert.equal(await f.vault.read("account:"+key),null);assert.equal(f.accounts.selected,"");await assert.rejects(f.accounts.token(key),/again/);
 }finally{await f.close();}
});
test("native registration collection refreshes both independent Hubs and removing one account preserves the other installation subscription",async()=>{
 const f=await fixture();try{
  const first=await f.login(0),second=await f.login(1);await f.push.restore();
  await f.push.enable(first,(await f.accounts.computers(first))[0]);await f.push.enable(second,(await f.accounts.computers(second))[0]);assert.equal(f.push.registrations.length,2);
  await f.updated("native-installation-push-2");
  const target={server:JSON.stringify(["relay-v1",f.hubs[0]!.origin,"alice",f.hubs[0]!.computer.hubId,f.hubs[0]!.computer.id]),computerId:f.hubs[0]!.computer.id,hubId:f.hubs[0]!.computer.hubId,localId:"native-session"};
  assert.equal((await f.push.authorizeTarget(target)).accountKey,first);
  await assert.rejects(f.push.authorizeTarget({...target,localId:"unshared-or-missing"}),/agent access changed/);
  for(const h of f.hubs){const rows=h.inbox.subscriptions("alice");assert.equal(rows.length,1);}
  const uploaded=f.calls.filter(c=>c.body?.provider==="harmony"&&c.body.token==="native-installation-push-2");assert.ok(uploaded.some(c=>c.url.startsWith(f.hubs[0]!.origin)));assert.ok(uploaded.some(c=>c.url.startsWith(f.hubs[1]!.origin)));
  await f.accounts.logout(first);assert.equal(f.deleted(),0);assert.equal(f.hubs[0]!.inbox.subscriptions("alice").length,0);assert.equal(f.hubs[1]!.inbox.subscriptions("alice").length,1);assert.equal(f.accounts.accounts.length,1);
  await assert.rejects(f.push.authorizeTarget({server:JSON.stringify(["relay-v1",f.hubs[0]!.origin,"alice",f.hubs[0]!.computer.hubId,f.hubs[0]!.computer.id]),computerId:f.hubs[0]!.computer.id,hubId:f.hubs[0]!.computer.hubId,localId:"old-session"}),/removed/);
  f.hubs[1]!.store.change(s=>{s.computers[0]!.binding++;});await assert.rejects(f.push.updateToken("next-token"),/binding changed/);
  await f.accounts.logout(second);assert.equal(f.deleted(),1);assert.equal(f.push.registrations.length,0);assert.equal(f.hubs[1]!.inbox.subscriptions("alice").length,0);
 }finally{await f.close();}
});

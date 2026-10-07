import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolveSchemaReferences } from "../scripts/openapi-schemas.js";
import { WebSocket } from "ws";
import { protocolFixture, type RegisteredRoute } from "../scripts/protocol-fixture.js";
import { registeredInventory, HUB_CAPABILITIES, ErrorResponse } from "../src/protocol/inventory.js";
import { relayEndpointInventory, classifyRoute } from "../src/protocol/routes.js";
import { PAIRING_LIFETIME_SECONDS } from "../src/contracts/pairing.js";
import { DomainError } from "../src/contracts/model.js";
assert.ok(existsSync("/.dockerenv"),"Run protocol conformance in Docker");
const documents:Record<string,any>={};
async function document(name="hub") {return documents[name]??=resolveSchemaReferences(JSON.parse(await readFile("protocol/"+name+".openapi.json","utf8")));}
const pathName=(value:string)=>value.replace(/:([A-Za-z][A-Za-z0-9_]*)/g,"{$1}");
async function responseContract(path:string,method:string,status:number,body:unknown,component="hub") {
  const route=(await document(component)).paths[pathName(path)]?.[method.toLowerCase()];assert.ok(route,method+" "+path+" documented");
  assert.ok(route.responses[String(status)],"Documented status "+status+" for "+method+" "+path);
  const schema=route.responses[String(status)].content?.["application/json"]?.schema;
  if(schema&&Object.keys(schema).length)assert.ok(z.fromJSONSchema(schema).safeParse(body).success,"Response matches generated JSON Schema: "+JSON.stringify(body));
}
const comparable=(routes:RegisteredRoute[])=>[...new Set(routes.filter(r=>r.method!=="HEAD").map(r=>r.method+" "+r.path))].sort();
test("explicit inventory matches every actual Hub and authority registered method",async()=>{
  const f=await protocolFixture();try {
    for(const [component,routes]of [["hub",f.hubRoutes],["identity",f.identityRoutes]] as const) {
      const expected=registeredInventory[component].flatMap(r=>r.methods.map(method=>({method,path:r.path,websocket:!!r.websocket})));
      assert.deepEqual(comparable(routes),comparable(expected),component+" complete registered inventory");
      assert.equal(routes.find(r=>r.method==="GET"&&r.path==="/connect/v1/computers/:id")?.websocket,component==="hub"?true:undefined);
    }
    const saved=JSON.parse(await readFile("protocol/registered-routes.json","utf8"));assert.deepEqual(saved,registeredInventory);
  }finally{await f.close();}
});
test("public specs use exact inner methods even where the outer independent router forwards broadly",async()=>{
  const f=await protocolFixture();try {
    const spec=await document();assert.ok(spec.paths["/api/v1/meta"].get);
    assert.deepEqual(Object.keys(spec.paths["/.well-known/jwks.json"]),["get"]);
    assert.deepEqual(Object.keys(spec.paths["/oauth/token"]),["post"]);
    for(const [method,path]of [["POST","/.well-known/jwks.json"],["GET","/oauth/token"],["PUT","/api/v1/pairing/inspect-transfer"]]as const){const response=await f.hub.inject({method,url:path});assert.equal(response.statusCode,404);RouterError(response.json());}
  }finally{await f.close();}
});
function RouterError(value:unknown){assert.ok(ErrorResponse.safeParse(value).success);}
test("delegation authority request schemas reject malformed scope at the actual handlers",async()=>{
  const f=await protocolFixture();try {
    const internal=await document("internal");
    const scope={hubId:f.computer.hubId,identitySessionId:f.session.id,actorId:"owner",parentId:"parent",targetComputerId:f.computer.id,sourceComputerId:f.computer.id,sourceBinding:1};
    for(const [path,body] of [
      ["/internal/delegation-authorize",{...scope,action:"create",sourceBinding:0}],
      ["/internal/delegation-child-context",{...scope,childId:"child",extra:"rejected"}],
      ["/internal/delegation-reserve",{...scope,action:"create",agentId:"child",name:"Child",backend:"fixture"}],
    ] as const){
      const endpoint=internal.paths[path].post;
      assert.equal(z.fromJSONSchema(endpoint.requestBody.content["application/json"].schema).safeParse(body).success,false);
      const response=await f.identity.inject({method:"POST",url:path,payload:body});
      assert.equal(response.statusCode,400);
      await responseContract(path,"POST",400,response.json(),"internal");
    }
    const hub=await document();
    const delegated=hub.paths["/connect/v1/computers/{computerId}/agents/{parentId}/delegations"].post;
    assert.deepEqual(delegated.security,[{ComputerCredential:[],DelegationGrant:[]}]);
    assert.equal(hub.components.securitySchemes.DelegationGrant.name,"X-Codoxear-Delegation-Grant");
    const grants=await f.hub.inject({method:"POST",url:"/api/agents/parent/delegation-grants",payload:{targetComputerIds:[]},headers:{authorization:"Bearer "+f.bearer}});
    assert.equal(grants.statusCode,400);
    await responseContract("/api/agents/:id/delegation-grants","POST",400,grants.json());
  }finally{await f.close();}
});
test("actual anonymous metadata and current account envelopes satisfy generated response schemas",async()=>{
  const f=await protocolFixture();try {
    for(const path of ["/health","/api/v1/meta","/api/auth/options","/.well-known/jwks.json"]){const r=await f.hub.inject({url:path});assert.equal(r.statusCode,200);await responseContract(path,"GET",r.statusCode,r.json());}
    const meta=(await f.hub.inject({url:"/api/v1/meta"})).json();assert.deepEqual(meta.capabilities,[...HUB_CAPABILITIES]);assert.equal(meta.independent,true);
    const headers={authorization:"Bearer "+f.bearer};
    for(const path of ["/api/v1/me","/api/agent-directory","/api/v1/push/subscriptions"]){const r=await f.hub.inject({url:path,headers});assert.equal(r.statusCode,200);await responseContract(path,"GET",r.statusCode,r.json());}
    const noLogin=await f.hub.inject({url:"/api/v1/push/subscriptions"});assert.equal(noLogin.statusCode,401);await responseContract("/api/v1/push/subscriptions","GET",noLogin.statusCode,noLogin.json());
  }finally{await f.close();}
});
test("generated structural request limits agree with real handlers for auth, push, transfer, workspace and download",async()=>{
  const f=await protocolFixture();try {
    const invalid=[
      ["POST","/api/v1/auth/keys/challenge",{keyId:"short",installationId:"fixture"}],
      ["POST","/api/v1/auth/keys/verify",{challengeId:"challenge",signature:"short"}],
      ["POST","/oauth/token",{grant_type:"refresh_token",refresh_token:"short"}],
      ["POST","/oauth/revoke",{token:"short"}],
      ["POST","/api/v1/pairing/inspect-transfer",{code:"short"}],
      ["POST","/api/v1/pairing/redeem-transfer",{code:"ABCDEFGH",transferId:"transfer",credential:"short"}],
      ["POST","/api/v1/push/subscriptions",{provider:"harmony",computerId:f.computer.id,installationId:"phone",token:"fixture",userId:"other-account"}],
      ["POST","/api/v1/push/authorize",{computerId:f.computer.id,installationId:"phone",clientId:"client",agentId:"agent",binding:0,subscriptionTag:"a".repeat(64)}],
      ["PUT","/api/computers/:id/workspace",{path:"x".repeat(4001)}],
      ["PUT","/api/computers/:id/workspace-access/:userId",{access:"write",uploads:"yes"}],
      ["POST","/api/v1/downloads/prepare",{agentId:"agent",query:"path=file",extra:true}],
    ]as const;
    for(const [method,path,payload]of invalid){const schema=(await document()).paths[pathName(path)][method.toLowerCase()].requestBody.content["application/json"].schema;assert.equal(z.fromJSONSchema(schema).safeParse(payload).success,false,method+" "+path+" rejects invalid structure");const url=path.replace(":id",f.computer.id).replace(":userId","owner");const response=await f.hub.inject({method,url,payload,headers:{authorization:"Bearer "+f.bearer}});assert.equal(response.statusCode,400,method+" "+path+": "+response.body);await responseContract(path,method,response.statusCode,response.json());}
    const consume=await f.hub.inject({method:"POST",url:"/api/v1/downloads/consume",headers:{"content-type":"application/x-www-form-urlencoded"},payload:"ticket=short"});assert.equal(consume.statusCode,400);await responseContract("/api/v1/downloads/consume","POST",consume.statusCode,consume.json());
  }finally{await f.close();}
});
test("pairing advertises the actual 15-minute lifetime and redeems normalized short codes once",async()=>{
  const f=await protocolFixture();try {
    const response=await f.hub.inject({method:"POST",url:"/api/computers/"+f.computer.id+"/pairing",headers:{authorization:"Bearer "+f.bearer},payload:{}});assert.equal(response.statusCode,200);const value=response.json();await responseContract("/api/computers/:id/pairing","POST",response.statusCode,value);
    assert.equal(value.expiresIn,PAIRING_LIFETIME_SECONDS);assert.ok(value.expiresAt>Date.now()+PAIRING_LIFETIME_SECONDS*1000-2000);
    const code=value.code.slice(0,4).toLowerCase()+"-"+value.code.slice(4).toLowerCase();const redeem=await f.hub.inject({method:"POST",url:"/api/v1/pairing/redeem",payload:{code}});assert.equal(redeem.statusCode,200);await responseContract("/api/v1/pairing/redeem","POST",redeem.statusCode,redeem.json());
    const second=await f.hub.inject({method:"POST",url:"/api/v1/pairing/redeem",payload:{code}});assert.equal(second.statusCode,403);await responseContract("/api/v1/pairing/redeem","POST",second.statusCode,second.json());
    const limits=JSON.parse(await readFile("protocol/limits.json","utf8"));assert.equal(limits.pairingLifetimeSeconds,value.expiresIn);assert.equal(limits.downloadTicketLifetimeSeconds,120);
  }finally{await f.close();}
});
test("documented relay methods preserve capability distinctions and deny method/path escalation",async()=>{
  const relay=await document("relay");
  for(const endpoint of relayEndpointInventory()){const sample=endpoint.path.replace("{localId}","broker-"+"a".repeat(32)).replace("{filename}","segment-000.ts");assert.equal(classifyRoute(endpoint.method,sample).action,endpoint.action);const documented=relay.paths["/api/v1/computers/{computerId}"+endpoint.path][endpoint.method.toLowerCase()];assert.equal(documented["x-required-route-capability"],endpoint.action);}
  for(const [method,path]of [["DELETE","/api/sessions/broker-local/file/read"],["PUT","/api/sessions/broker-local/send"],["POST","/api/sessions/broker-local/git/diff"],["GET","/api/sessions/broker-local/file/write"],["GET","/api/sessions/broker-local/../../settings/voice"]]as const)assert.throws(()=>classifyRoute(method,path),e=>e instanceof DomainError&&[400,403].includes(e.status));
  assert.equal(classifyRoute("POST","/api/sessions/broker-local/draft").action,"read");assert.equal(classifyRoute("POST","/api/sessions/broker-local/delete").action,"session.delete");assert.equal(classifyRoute("GET","/api/sessions/broker-local/git/diff").action,"files.read");
  assert.equal(classifyRoute("GET","/api/sessions/broker-local/messages/neighbor").action,"read");
  assert.throws(()=>classifyRoute("POST","/api/sessions/broker-local/messages/neighbor"),e=>e instanceof DomainError&&e.status===403);
});
test("Computer tunnel rejects unsupported majors through the actual WebSocket upgrade interface",async()=>{
  const f=await protocolFixture();try {
    await f.hub.listen({host:"127.0.0.1",port:0});const address=f.hub.server.address() as {port:number};
    const rejected=await new Promise<{status:number;body:unknown}>((resolve,reject)=>{const ws=new WebSocket("ws://127.0.0.1:"+address.port+"/connect/v1/computers/"+f.computer.id,{headers:{"x-codoxear-hub":f.computer.hubId,"x-codoxear-protocol":"2"}});ws.on("unexpected-response",(_request,response)=>{const parts:Buffer[]=[];response.on("data",part=>parts.push(Buffer.from(part)));response.on("end",()=>{ws.terminate();resolve({status:response.statusCode!,body:JSON.parse(Buffer.concat(parts).toString())});});});ws.on("error",()=>{});ws.on("open",()=>{ws.close();reject(Error("Unsupported major was accepted"));});});
    assert.equal(rejected.status,426);await responseContract("/connect/v1/computers/:id","GET",rejected.status,rejected.body);
  }finally{await f.close();}
});

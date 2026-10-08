import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { WorkspaceRegistry } from "../src/computer/native/workspace/registry.js";
import { WorkspaceContext, GrantPath } from "../src/contracts/workspaces.js";
import { emptyBody, type HttpRequest } from "../src/protocol/http-frames.js";
async function fixture() {
 const home = await mkdtemp(join(tmpdir(), "delegated-")), root = join(home,"root"), second = join(home,"second");
 await mkdir(root); await mkdir(second);
 let cwd = root, capable = true, legacyAttachments: unknown[] = []; const calls: Array<{path:string; body: any}> = [];
 const runtime = {home,stateHome:home, async request(path:string, method?:string, body?:unknown) { if(path === "/api/sessions") return {sessions:[{session_id: "broker-"+"b".repeat(32),cwd}]}; if(path.endsWith("/state"))return{actor_attachments:capable,attachments:legacyAttachments};calls.push({path,body}); return {ok:true}; },async completions(){return [];} } as unknown as NativeRuntime;
 const target = new NativeHttpTarget(runtime,root), registry = new WorkspaceRegistry(home,root), base="/api/sessions/broker-"+"b".repeat(32);
 const call = async (route:string, grant: Partial<WorkspaceContext> = {}, body?:unknown, actorId="member", headers:Record<string,string>={}, signal=new AbortController().signal) => {
   const response = await target.execute({method:body === undefined?"GET":"POST",path:base+route,headers,actorId,workspace:{id:"default",access:"write",...grant},body:body === undefined?emptyBody:(async function*(){yield Buffer.from(JSON.stringify(body));})(),signal});
   const chunks=[];for await(const chunk of response.body) chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
   return {...response,bytes,json:()=>JSON.parse(bytes.toString())};
 };
 return {home,root,second,registry,target,call,calls,setLegacy:(attachments:unknown[])=>{capable=false;legacyAttachments=attachments;},setCwd:(path:string)=>{cwd=path;},async close(){target.close();await rm(home,{recursive:true,force:true});}};
}
test("concurrent owner approvals and lazy initialization across registry instances preserve every stable root", async()=>{
 const f=await fixture();try{
  const third=join(f.home,"third");await mkdir(third);
  const other=new WorkspaceRegistry(f.home,f.root);
  const [first,second]=await Promise.all([f.registry.execute({path:f.second,name:"Second"}),other.execute({path:third,name:"Third"}),f.registry.roots(),other.roots()]);
  const persisted=await new WorkspaceRegistry(f.home,f.root).roots();
  assert.deepEqual(new Set(persisted.map(r=>r.path)),new Set([f.root,f.second,third]));
  assert.equal(persisted.length,3);assert.equal(new Set(persisted.map(r=>r.id)).size,3);
  assert.equal(first.roots.find(r=>r.path===f.second)!.id,persisted.find(r=>r.path===f.second)!.id);
  assert.equal(second.roots.find(r=>r.path===third)!.id,persisted.find(r=>r.path===third)!.id);
 }finally{await f.close();}
});
test("multiple Computer-approved stable roots enforce individual paths, hardlink/symlink and directory identity fences", async()=>{
 const f=await fixture();try {
  await mkdir(join(f.root,"approved"));await writeFile(join(f.root,"approved","edit.txt"),"before");await writeFile(join(f.root,"private.txt"),"private");
  await link(join(f.root,"private.txt"),join(f.root,"approved","hardlink.txt"));await symlink(join(f.root,"private.txt"),join(f.root,"approved","symlink.txt"));
  const grant={paths:["approved"]};
  assert.equal((await f.call("/file/read?path=approved/edit.txt",grant)).json().text,"before");
  assert.equal((await f.call("/file/read?path=private.txt",grant)).status,403);
  assert.equal((await f.call("/file/read?path=approved/hardlink.txt",grant)).status,403);
  assert.equal((await f.call("/file/read?path=approved/symlink.txt",grant)).status,403);
  assert.deepEqual((await f.call("/file/list",grant)).json().files,["approved/edit.txt"]);
  const read=await f.call("/file/read?path=approved/edit.txt",grant);
  assert.equal((await f.call("/file/write",grant,{path:"approved/edit.txt",version:read.json().version,text:"after"})).status,200);
  assert.equal((await f.call("/file/write",grant,{path:"approved/edit.txt",version:read.json().version,text:"stale"})).status,409);
  const added=await f.registry.execute({path:f.second,name:"Second"});const id=added.roots.find(r=>r.path===f.second)!.id;
  await writeFile(join(f.second,"second.txt"),"second");f.setCwd(f.second);
  assert.equal((await f.call("/file/read?path=second.txt",{id})).json().text,"second");
  assert.equal((await f.call("/file/read?path=second.txt",{id:"default"})).status,403);
  await f.registry.execute({id,remove:true});assert.equal((await f.call("/file/read?path=second.txt",{id})).status,403);
  await assert.rejects(f.registry.execute({id,path:f.second}));
  f.setCwd(f.root);await rename(f.root,f.root+"-old");await mkdir(f.root);await writeFile(join(f.root,"private.txt"),"replacement");
  assert.equal((await f.call("/file/read?path=private.txt")).status,403);
 } finally{await f.close();}
});
test("Git is a separate complete-repository capability, rejects external object stores and cannot expose Git internals as working files",async()=>{
 const f=await fixture();try{
  for(const args of [["init"],["config","user.email","fixture@invalid.test"],["config","user.name","Fixture"]]) execFileSync("git",args,{cwd:f.root,stdio:"ignore"});
  await writeFile(join(f.root,"committed.txt"),"history secret");execFileSync("git",["add","."],{cwd:f.root});execFileSync("git",["commit","-m","fixture"],{cwd:f.root,stdio:"ignore"});await writeFile(join(f.root,"committed.txt"),"current");
  assert.equal((await f.call("/git/file_versions?path=committed.txt")).status,403);
  const history=await f.call("/git/file_versions?path=committed.txt",{git:true,paths:["other.txt"]});assert.equal(history.status,200);assert.equal(history.json().base_text,"history secret");
  const diff=await f.call("/git/diff?path=committed.txt",{git:true});assert.equal(diff.status,200);assert.match(diff.json().diff,/history secret/);
  assert.equal((await f.call("/file/read?path=.git/config",{git:true})).status,403);
  await writeFile(join(f.root,".git","objects","info","alternates"),f.second);assert.equal((await f.call("/git/file_versions?path=committed.txt",{git:true})).status,403);
 }finally{await f.close();}
});
test("attachment uploads use separate actor/grant storage, reject arbitrary path injection and pass actor fences to native broker",async()=>{
 const f=await fixture();try{
  const body={filename:"member.txt",data_b64:Buffer.from("member bytes").toString("base64")};
  assert.equal((await f.call("/inject_file",{},body)).status,403);
  assert.equal((await f.call("/inject_file",{uploads:true},body)).status,200);
  const first=f.calls.at(-1)!.body;assert.equal(first.actorId,"member");assert.equal(first.workspace.uploads,true);assert.equal(await readFile(first.path,"utf8"),"member bytes");
  assert.equal((await f.call("/inject_file",{uploads:true},body,"other")).status,200);const other=f.calls.at(-1)!.body;assert.notEqual(join(first.path,".."),join(other.path,".."));
  assert.equal((await f.call("/inject_file",{uploads:true},{path:first.path},"other")).status,403);
  await f.call("/send",{uploads:true},{text:"send"});assert.equal(f.calls.at(-1)!.body.workspace.uploads,true);assert.equal(f.calls.at(-1)!.body.actorId,"member");
 }finally{await f.close();}
});
test("video processing needs explicit capability, allowed source and scoped cache; range and cancellation stay enforced",async()=>{
 const f=await fixture();try{
  const source=join(f.root,"clip.webm");execFileSync(process.env.FFMPEG_BIN??"ffmpeg",["-nostdin","-v","error","-f","lavfi","-i","color=c=blue:s=32x32:d=0.3","-c:v","libvpx","-y",source]);
  assert.equal((await f.call("/file/video_preview?path=clip.webm")).status,403);
  assert.equal((await f.call("/file/video_preview?path=clip.webm",{transcode:true,paths:["other.webm"]})).status,403);
  const preview=await f.call("/file/video_preview?path=clip.webm",{transcode:true},undefined,"member",{range:"bytes=0-15"});assert.equal(preview.status,206);assert.equal(preview.bytes.length,16);
  const controller=new AbortController();controller.abort();await assert.rejects(f.call("/file/video_preview?path=clip.webm",{transcode:true},undefined,"member",{},controller.signal));
 }finally{await f.close();}
});
test("grant schema rejects path traversal, absolute paths and ambiguous segments",()=>{
 for(const path of ["../secret","/outside","a/../secret","a//b","a/./b","a\\b"])assert.equal(GrantPath.safeParse(path).success,false);
 assert.equal(GrantPath.safeParse("src/file.ts").success,true);
});
test("running pre-isolation brokers preserve owner attachments and refuse delegated attachment mutation or consuming sends",async()=>{
 const f=await fixture();try{
  f.setLegacy([{path:"/owner/private.txt"}]);
  for(const [route,body] of [["/inject_file",{filename:"file.txt",data_b64:"Ynl0ZXM="}],["/send",{text:"must not consume owner attachments"}],["/attachments",undefined],["/attachments/clear",{}]] as const){
   const denied=await f.call(route,{uploads:true},body);assert.equal(denied.status,409);assert.equal(denied.json().code,"attachment_runtime_update");
  }
  assert.equal(f.calls.length,0);
  f.setLegacy([]);assert.equal((await f.call("/send",{}, {text:"ordinary member text"})).status,200);
 }finally{await f.close();}
});
test("owner root removal cancels an already-open native download before its next chunk",async()=>{
 const f=await fixture();try{
  const added=await f.registry.execute({path:f.second,name:"Second"}),id=added.roots.find(r=>r.path===f.second)!.id;
  f.setCwd(f.second);await writeFile(join(f.second,"large.bin"),Buffer.alloc(512*1024,1));
  const response=await f.target.execute({method:"GET",path:"/api/sessions/broker-"+"b".repeat(32)+"/file/download?path=large.bin",headers:{},actorId:"member",workspace:{id,access:"read"},signal:new AbortController().signal,body:emptyBody});
  assert.equal(response.status,200);const iterator=response.body[Symbol.asyncIterator]();assert.equal((await iterator.next()).value?.length,65536);
  await f.registry.execute({id,remove:true});await assert.rejects(iterator.next(),/removed this workspace/);
 }finally{await f.close();}
});

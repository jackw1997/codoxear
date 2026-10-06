import assert from "node:assert/strict";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { socketPath } from "../src/computer/native/paths.js";
import type { NativeRuntime } from "../src/computer/native/runtime.js";
import type { BrokerLaunch } from "../src/computer/native/types.js";

/** Controlled terminal producer; recovery and the browser use the real broker interfaces. */
export async function recoveredUnattended(runtime: NativeRuntime, home: string, workspace: string) {
  const command = join(home,"accessibility-codex-producer");
  await writeFile(command,`#!${process.execPath}
const fs=require('fs'),path=require('path');
const resume=process.argv.indexOf('resume'),id=resume<0?'accessibility-'+process.pid:process.argv[resume+1];
const dir=path.join(process.env.HOME,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});
const log=path.join(dir,id+'.jsonl'),fd=fs.openSync(log,'a');
function row(type,payload){fs.writeSync(fd,JSON.stringify({type,payload,timestamp:new Date().toISOString()})+'\\n');}
if(fs.statSync(log).size===0)row('session_meta',{id,cwd:process.cwd()});
process.stdout.write('100% context left ? for shortcuts\\n');process.stdin.setRawMode(true);
let buffer='';process.stdin.on('data',data=>{
if(data.toString().includes('Unattended-mode operating constitution'))process.stdout.write('UNATTENDED_PASTE_BOUNDARY\\n');
buffer+=data.toString().replace(/\\x1b\\[(?:200|201)~/g,'');
if(!buffer.includes('\\r'))return;const text=buffer.split('\\r')[0];buffer='';
row('event_msg',{type:'user_message',message:text});
row('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Controlled completed objective'}]});
row('event_msg',{type:'task_complete'});process.stdout.write('100% context left ? for shortcuts\\n');});
`,{mode:0o755});
  async function until(fn:()=>Promise<boolean>|boolean) {
    const end=Date.now()+20000;
    while(!await fn()){ if(Date.now()>end)throw Error("Unattended recovery timed out");await new Promise(r=>setTimeout(r,50)); }
  }
  const prior=process.env.CODEX_BIN; process.env.CODEX_BIN=command;
  let id:string;
  try { id=(await runtime.createTerminal("codex","Recovered unattended review",{cwd:workspace})).localId; }
  finally { if(prior===undefined)delete process.env.CODEX_BIN;else process.env.CODEX_BIN=prior; }
  await until(async()=>(await runtime.request(`/api/sessions/${id}/state`)).readiness==="ready");
  await runtime.request(`/api/sessions/${id}/send`,"POST",{text:"Completed objective"});
  await until(async()=>(await runtime.request(`/api/sessions/${id}/messages/tail`)).events.some((e:any)=>e.role==="assistant"));
  const state=await runtime.request(`/api/sessions/${id}/state`);
  await runtime.request(`/api/sessions/${id}/unattended`,"POST",{enabled:true,cooldown_minutes:1,remaining_injections:2});
  const attachment=connect(socketPath(runtime.stateHome,id));attachment.setEncoding("utf8");
  let killed=false;
  attachment.on("data",chunk=>{if(!killed&&String(chunk).includes("UNATTENDED_PASTE_BOUNDARY")){killed=true;process.kill(state.broker_pid,"SIGKILL");}});
  attachment.write(JSON.stringify({operation:"attach"})+"\n");
  try {
    // Age this owned producer transcript to exercise the genuine idle cooldown.
    const rows=readFileSync(state.log_path,"utf8").trim().split("\n").map(line=>({...JSON.parse(line),timestamp:new Date(Date.now()-120000).toISOString()}));
    await writeFile(state.log_path,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    await until(()=>killed);
    const saved=JSON.parse(readFileSync(join(runtime.directory,id+".state.json"),"utf8"));
    assert.equal(saved.unattended.remaining_injections,1);
    assert.equal(typeof saved.unattended_attempt,"string");
    try {process.kill(state.pid,"SIGTERM");}catch{}
    await unlink(socketPath(runtime.stateHome,id));
    const restarted=spawn(process.execPath,["--import","tsx","src/computer/native/broker.ts","--terminal"],{cwd:process.cwd(),env:{...process.env,CODEX_BIN:command},stdio:["pipe","ignore","ignore"]});
    const launch:BrokerLaunch={home,storageHome:runtime.stateHome,sessionId:id,backend:"codex",cwd:workspace,name:"Recovered unattended review",resumePath:state.log_path,launch:{resume_session_id:state.thread_id}};
    restarted.stdin!.end(JSON.stringify(launch));
    await until(async()=>{try{return(await runtime.request(`/api/sessions/${id}/state`)).readiness==="ready";}catch{return false;}});
    const config=await runtime.request(`/api/sessions/${id}/unattended`);
    assert.equal(config.enabled,false);assert.equal(config.commit_unknown,saved.unattended_attempt);
    return {localId:id,attempt:config.commit_unknown,remaining:config.remaining_injections,close:()=>restarted.kill("SIGTERM")};
  } finally {attachment.destroy();}
}

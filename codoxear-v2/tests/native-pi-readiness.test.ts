import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeRuntime } from "../src/computer/native/runtime.js";
assert.ok(existsSync("/.dockerenv"), "Native behavior runs in Docker");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "Pi bootstrap headers and stale markers cannot admit a direct or queued prompt before submission is enabled",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-readiness-")),
      workspace = join(home, "workspace"),
      command = join(home, "pi-fixture");
    await mkdir(workspace);
    await writeFile(
      command,
      `#!${process.execPath}
const fs=require('fs'),path=require('path');
const marker=process.env.CODOXEAR_NATIVE_PI_MARKER, log=path.join(process.env.HOME,'producer.jsonl'), received=path.join(process.env.HOME,'received.jsonl');
const identity={cwd:process.cwd(),sessionFile:log,sessionId:'delayed-pi-fixture'};
fs.writeFileSync(marker,JSON.stringify({...identity,pid:-1,updatedAt:new Date().toISOString()}));
setTimeout(()=>fs.writeFileSync(marker,JSON.stringify({...identity,pid:process.pid,updatedAt:new Date(0).toISOString()})),1200);
process.stdout.write('Pi v1.0.0 Esc to interrupt Ctrl+C to clear 0 tokens 128k context\\nDownloading managed tools...\\n');
process.stdin.setRawMode(true);let ready=false,buffer='';
process.stdin.on('data',data=>{fs.appendFileSync(received,JSON.stringify({ready,data:data.toString()})+'\\n');buffer+=data.toString().replace(/\\x1b\\[(?:200|201)~/g,'');if(buffer.includes('\\r')){const text=buffer.split('\\r')[0];buffer='';fs.appendFileSync(log,JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text}]},timestamp:new Date().toISOString()})+'\\n');fs.appendFileSync(log,JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:'Completed'}],stopReason:'stop'},timestamp:new Date().toISOString()})+'\\n');}});
setTimeout(()=>{ready=true;fs.writeFileSync(log,JSON.stringify({type:'session',id:identity.sessionId,cwd:identity.cwd})+'\\n');fs.writeFileSync(marker,JSON.stringify({...identity,pid:process.pid,updatedAt:new Date().toISOString()}));process.stdout.write('Submission enabled\\n');},3500);
`,
      { mode: 0o755 },
    );
    const prior = process.env.PI_BIN;
    process.env.PI_BIN = command;
    const runtime = new NativeRuntime(home, workspace);
    let id: string | undefined;
    try {
      id = (await runtime.createTerminal("pi", "Delayed native bootstrap"))
        .localId;
      await wait(500);
      const initial = await runtime.request(`/api/sessions/${id}/state`);
      assert.equal(initial.readiness, "starting");
      await assert.rejects(
        runtime.request(`/api/sessions/${id}/send`, "POST", {
          text: "Must not paste",
        }),
        /starting|not sent/i,
      );
      await runtime.queueControl(id, "enqueue", {
        text: "Queued after actual startup",
      });
      await wait(1800);
      assert.equal(
        (await runtime.request(`/api/sessions/${id}/state`)).readiness,
        "starting",
        "elapsed time and Pi help are insufficient",
      );
      assert.equal(
        await readFile(join(home, "received.jsonl"), "utf8").catch(() => ""),
        "",
      );
      const end = Date.now() + 8000;
      while (
        !(
          await readFile(join(home, "received.jsonl"), "utf8").catch(() => "")
        ).includes("Queued after actual startup")
      ) {
        assert.ok(Date.now() < end, "fresh producer marker releases queue");
        await wait(75);
      }
      const inputs = (await readFile(join(home, "received.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      assert.ok(inputs.every((x) => x.ready === true));
      assert.equal(
        inputs.filter((x) => x.data.includes("Queued after actual startup"))
          .length,
        1,
      );
      assert.equal(
        (await runtime.request(`/api/sessions/${id}/state`)).readiness,
        "ready",
      );
    } finally {
      if (id)
        await runtime
          .request(`/api/sessions/${id}/delete`, "POST", {})
          .catch(() => {});
      runtime.close();
      if (prior === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prior;
    }
  },
);

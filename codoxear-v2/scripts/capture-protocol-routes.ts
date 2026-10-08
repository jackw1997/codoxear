import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { protocolFixture } from "./protocol-fixture.js";
assert.ok(existsSync("/.dockerenv"),"Run route capture in Docker");
const f=await protocolFixture();
try {
  const sort=(routes:typeof f.hubRoutes)=>routes.filter(r=>r.method!=="HEAD").sort((a,b)=>(a.path+":"+a.method).localeCompare(b.path+":"+b.method));
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/protocol-registered-routes.json",JSON.stringify({hub:sort(f.hubRoutes),identity:sort(f.identityRoutes)},null,2));
  console.log("Captured",sort(f.hubRoutes).length,"Hub and",sort(f.identityRoutes).length,"authority registered methods");
} finally {await f.close();}

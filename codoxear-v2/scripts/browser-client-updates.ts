/** Docker-only browser check of an open client surviving a frontend deployment. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createServer, request} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const {createStaticServer}=await import(new URL('../frontend/serve.mjs',import.meta.url).href);
assert(existsSync('/.dockerenv'), 'Browser verification requires Docker');
const staticServer=createStaticServer() as ReturnType<typeof createServer>;
await new Promise<void>(resolve=>staticServer.listen(0,'127.0.0.1',resolve));
const address=staticServer.address();assert(address&&typeof address!=='string');
const artifact=JSON.parse(await readFile(new URL('../frontend/dist/client/client-release.json',import.meta.url),'utf8'));
const original=artifact.version as string;
let version=original;
const proxy=createServer((incoming,outgoing)=>{
  if(incoming.url==='/client-release.json'){
    outgoing.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    outgoing.end(JSON.stringify({version}));return;
  }
  const upstream=request({hostname:'127.0.0.1',port:address.port,path:incoming.url,method:incoming.method},response=>{
    outgoing.writeHead(response.statusCode??500,response.headers);
    if((incoming.url??'').split('?')[0]==='/'){
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>outgoing.end(Buffer.concat(chunks).toString('utf8').replaceAll(original,version)));
    }else response.pipe(outgoing);
  });
  upstream.on('error',()=>outgoing.end());upstream.end();
});
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const endpoint=proxy.address();assert(endpoint&&typeof endpoint!=='string');
const origin='http://127.0.0.1:'+endpoint.port;
const playwright=await import(process.env.PLAYWRIGHT_MODULE??'@playwright/test') as typeof import('@playwright/test');
const browser=await playwright.chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:390,height:844}});
const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const artifacts=process.env.CLIENT_UPDATE_ARTIFACTS??'/opt/codoxear/artifacts/client-updates';await mkdir(artifacts,{recursive:true});
let passed=false;const checks:string[]=[];
try{
  await page.goto(origin);const connections=page.getByRole('dialog',{name:'Hubs & computers',exact:true});
  await connections.getByRole('button',{name:'Add hub',exact:true}).click();
  const add=page.getByRole('dialog',{name:'Add hub',exact:true});const input=add.getByLabel('Hub address');
  await input.fill('https://unsaved-hub.example');
  assert.equal(await page.locator('.clientUpdateNotice').count(),0);
  const other=await context.newPage();await other.goto('about:blank');
  version=createHash('sha256').update(original+'next-deployment').digest('hex').slice(0,16);
  await page.bringToFront();
  await page.locator('.clientUpdateNotice').waitFor({timeout:65000});
  assert.equal(await input.inputValue(),'https://unsaved-hub.example');
  assert.equal(await page.evaluate(()=>(window as Window & {CODOXEAR_ASSET_VERSION?:string}).CODOXEAR_ASSET_VERSION),original);
  checks.push('An open client detects a deployment and offers Reload without replacing the page or discarding its current form');
  await add.getByRole('button',{name:'Back',exact:true}).click();
  await connections.getByRole('button',{name:'Back',exact:true}).click();
  const reload=page.locator('.clientUpdateNotice').getByRole('button',{name:'Reload',exact:true});
  assert((await reload.boundingBox())!.height>=44);
  await page.screenshot({path:artifacts+'/update-available-phone.png',fullPage:true});
  await reload.click();await connections.waitFor();
  assert.equal(await page.evaluate(()=>(window as Window & {CODOXEAR_ASSET_VERSION?:string}).CODOXEAR_ASSET_VERSION),version);
  assert.equal(await page.locator('.clientUpdateNotice').count(),0);
  checks.push('Reload loads the current deployment and removes the update notice with a usable phone-sized control');
  assert.deepEqual(errors,[]);passed=true;
}finally{
  await writeFile(artifacts+'/results.json',JSON.stringify({passed,checks,errors,boundary:'Empty independent client; deployment version publication is infrastructure, no users or application grants seeded'},null,2)+'\n');
  await browser.close();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await new Promise<void>(resolve=>staticServer.close(()=>resolve()));
}

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

assert.ok(
  existsSync("/.dockerenv"),
  "Delegation browser checks require Docker",
);
test("Agent access enables/revokes scoped delegation and ignores stale responses", async () => {
  const compiled = await build({
    stdin: {
      contents: `
    import {delegationSection,bindDelegation} from './web/client/delegation.ts';
    window.mount = () => {
      window.cleanup?.();
      document.body.innerHTML = '<div class="connectionPage">'+delegationSection([
        {id:'allowed',name:'Work computer',canCreate:true,online:true},
        {id:'denied',name:'Read only computer',canCreate:false,online:true}
      ])+'</div>';
      window.calls=[]; window.pending=[];
      window.cleanup = bindDelegation(document.body,'parent',async(path,body,method)=>{
        window.calls.push({path,body,method});
        return await new Promise((resolve,reject)=>window.pending.push({resolve,reject}));
      });
    }; window.mount();`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.setContent("<html><body></body></html>");
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    assert.equal(await page.getByText("Read only computer").count(), 0);
    await page.getByRole("checkbox", { name: "Work computer" }).check();
    await page.getByRole("button", { name: "Enable subagents" }).click();
    await page.waitForFunction(() => (window as any).pending.length === 2);
    const calls = await page.evaluate(() => (window as any).calls);
    assert.deepEqual(calls[1].body, {
      targetComputerIds: ["allowed"],
      ttlSeconds: 900,
    });
    await page.evaluate(() => {
      const w = window as any;
      w.pending[1].resolve({
        installed: true,
        expiresAt: Date.now() + 900000,
        targetComputerIds: ["allowed"],
      });
    });
    await page.getByText(/Subagent access enabled until/).waitFor();
    // Late initial GET must not overwrite a newer successful enable response.
    await page.evaluate(() =>
      (window as any).pending[0].resolve({ installed: false }),
    );
    await page.getByText(/Subagent access enabled until/).waitFor();
    await page.getByRole("button", { name: "Disable access" }).click();
    await page.waitForFunction(() => (window as any).pending.length === 3);
    assert.equal(
      await page.evaluate(() => (window as any).calls[2].method),
      "DELETE",
    );
    await page.evaluate(() =>
      (window as any).pending[2].resolve({ revoked: true }),
    );
    await page.getByText("Subagent access is disabled or expired.").waitFor();
    await page.getByRole("button", { name: "Enable subagents" }).click();
    await page.waitForFunction(() => (window as any).pending.length === 4);
    await page.evaluate(() =>
      (window as any).pending[3].resolve({ installed: false }),
    );
    await page
      .getByText(
        "Tool installation was not confirmed. Check access status before retrying.",
      )
      .waitFor();
    assert.equal(
      await page.getByText(/Subagent access enabled until/).count(),
      0,
    );
    await page.evaluate(() => {
      const w = window as any;
      w.mount();
      w.pending[0].resolve({ installed: false, authorizationUnknown: true });
    });
    await page
      .getByText(
        "Subagent authorization could not be checked. Current access is unknown.",
      )
      .waitFor();
    await page.evaluate(() => {
      const w = window as any;
      w.mount();
      w.pending[0].resolve({
        installed: false,
        authorized: true,
        expiresAt: Date.now() + 60000,
        targetComputerIds: ["allowed"],
      });
    });
    await page.getByText(/but the tool is not currently active/).waitFor();
    await page.evaluate(() => {
      const w = window as any;
      w.mount();
      w.pending[0].resolve({ installed: true, expiresAt: Date.now() + 100 });
    });
    await page.getByText("Subagent access is disabled or expired.").waitFor();
    await page.evaluate(() => {
      const w = window as any;
      w.mount();
      const old = w.pending[0];
      w.mount();
      old.resolve({ installed: true, expiresAt: Date.now() + 60000 });
      w.pending[0].resolve({ installed: false });
    });
    await page.getByText("Subagent access is disabled or expired.").waitFor();
    await page.evaluate(() => (window as any).cleanup());
    await page.close();
  } finally {
    await browser.close();
  }
});

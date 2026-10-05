// @ts-nocheck -- Browser document verification uses dynamic Playwright fixtures.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
if (!existsSync("/.dockerenv")) throw new Error("Run browser checks in Docker");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  for (const path of ["README.html", "artifacts/verification.html"]) {
    await page.goto("file://" + process.cwd() + "/" + path);
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.complete && i.naturalWidth > 0),
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path + " overflows",
      );
    }
    console.log("PASS document images and desktop/mobile layout:", path);
  }
  await page.goto(
    "file://" + process.cwd() + "/docs/computer-architecture.svg",
  );
  await page.setViewportSize({ width: 1120, height: 680 });
  await page.screenshot({ path: "artifacts/computer-architecture.png" });
} finally {
  await browser.close();
}

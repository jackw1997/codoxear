import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { OarFactory } from "../src/computer/managed/factory.js";
import { oarSetupIssues } from "../src/computer/oar-setup.js";
import { computerPackagePaths } from "../src/computer/package-paths.js";

assert.ok(
  existsSync("/.dockerenv"),
  "Managed worker verification runs only in Docker",
);

test("managed worker uses the injected package from an unrelated workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "managed-worker-package-"));
  let session: Awaited<ReturnType<OarFactory["open"]>> | undefined;
  try {
    const workspace = join(directory, "workspace");
    const runtime = join(directory, "standalone-runtime");
    await mkdir(workspace);
    await mkdir(runtime);
    const loaderPath = join(runtime, "load.mjs");
    // This adapter seam models OAR's framed local interface without starting
    // an external CLI or relying on a repository-level node_modules tree.
    await writeFile(
      loaderPath,
      `
      export const runtimes = {
        require(backend) {
          if (backend !== "pi") throw Error("unexpected runtime");
          return {
            installation: async () => ({ kind: "available" }),
            session: async (_installation, options) => {
              if (options.cwd !== ${JSON.stringify(workspace)}) throw Error("wrong workspace");
              let observer;
              return {
                id: "explicit-computer-runtime",
                capabilities: { images: true, steer: false },
                rawEvents(fn) { observer = fn; },
                async prompt(text, options) {
                  if (!/^[a-f0-9-]{36}$/.test(options.inputId)) throw Error("invalid input id");
                  if (text === "native image" && options.images?.[0]?.path !== "/uploaded/pixel.png") throw Error("image input lost");
                  observer({ kind: "frame", seq: 0, sessionId: "explicit-computer-runtime", receivedAt: 1, agentPath: [], body: { events: [{ kind: "text_delta", text }] } });
                  return { kind: "accepted" };
                },
                async abort() { return { kind: "accepted" }; },
                async dispose() {},
              };
            },
          };
        },
      };
    `,
    );
    session = await new OarFactory({ loaderPath }).open({
      home: directory,
      stateHome: directory,
      cwd: workspace,
      backend: "pi",
      permissionPolicy: "locally-trusted",
    });
    assert.equal(session.id, "explicit-computer-runtime");
    assert.deepEqual(session.capabilities, { images: true, steer: false });
    const events: unknown[] = [];
    session.rawEvents((record) => events.push(record));
    assert.deepEqual(
      await session.prompt("isolated package", { inputId: "receipt-1" }),
      { kind: "accepted" },
    );
    assert.equal(events.length, 1);
    assert.deepEqual(await session.prompt("native image", { inputId: "image-receipt", images: [{ path: "/uploaded/pixel.png", mediaType: "image/png" }] }), { kind: "accepted" });
    assert.equal(events.length, 2);
    assert.deepEqual(await session.abort(), { kind: "accepted" });
  } finally {
    await session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Computer loader rejects a changed OAR pin before evaluating that runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "managed-worker-version-"));
  try {
    const installed = join(directory, "node_modules/@botiverse/oar");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({
        name: "@botiverse/oar",
        version: "99.0.0",
        type: "module",
        exports: "./index.mjs",
      }),
    );
    const marker = join(directory, "evaluated");
    await writeFile(
      join(installed, "index.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "evaluated"); export const runtimes = {};`,
    );
    const loaderPath = join(directory, "load.mjs");
    await copyFile(computerPackagePaths().oarLoader, loaderPath);
    await assert.rejects(
      import(pathToFileURL(loaderPath).href),
      /exactly 0\.13\.3/,
    );
    assert.equal(existsSync(marker), false);
    await writeFile(join(directory, "package.json"), "{}");
    await writeFile(join(directory, "package-lock.json"), "{}");
    assert.deepEqual(await oarSetupIssues("locally-trusted", loaderPath), [
      "Install @botiverse/oar exactly 0.13.3; a different runtime version is present",
    ]);
    assert.equal(
      existsSync(marker),
      false,
      "doctor must not evaluate a runtime",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed factory refuses relative loader injection", async () => {
  await assert.rejects(
    new OarFactory({ loaderPath: "runtime/oar/load.mjs" }).open({
      home: "/tmp",
      stateHome: "/tmp",
      cwd: "/tmp",
      backend: "pi",
      permissionPolicy: "locally-trusted",
    }),
    /absolute Computer OAR loader path/,
  );
});

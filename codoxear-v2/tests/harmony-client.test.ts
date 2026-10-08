import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
assert.ok(existsSync("/.dockerenv"), "Docker only");
function load() {
  const requests: Array<{
      url: string;
      options: any;
      resolve: (v: any) => void;
    }> = [],
    connections: any[] = [];
  const http = {
    RequestMethod: { GET: "GET", POST: "POST" },
    HttpDataType: { ARRAY_BUFFER: "binary", STRING: "text" },
    createHttp() {
      const handlers = new Map();
      const connection = {
        destroyed: false,
        on(name: string, fn: any) {
          handlers.set(name, fn);
        },
        destroy() {
          this.destroyed = true;
        },
        request(url: string, options: any) {
          return new Promise((resolve) =>
            requests.push({ url, options, resolve }),
          );
        },
        requestInStream(url: string, options: any) {
          return new Promise((resolve) =>
            requests.push({ url, options, resolve }),
          );
        },
        emit(name: string, value: any) {
          handlers.get(name)?.(value);
        },
      };
      connections.push(connection);
      return connection;
    },
  };
  const exports: any = {},
    source = readFileSync(
      "tests/fixtures/harmony/services/ApiClient.ets",
      "utf8",
    );
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    {
      exports,
      require: (name: string) =>
        name === "@kit.NetworkKit"
          ? { http }
          : name === "@kit.CryptoArchitectureKit"
            ? {
                cryptoFramework: {
                  createMd: (algorithm: string) => {
                    assert.equal(algorithm, "SHA256");
                    const hash = createHash("sha256");
                    return {
                      async update(blob: { data: Uint8Array }) {
                        hash.update(blob.data);
                      },
                      async digest() {
                        return { data: new Uint8Array(hash.digest()) };
                      },
                    };
                  },
                },
              }
            : {
                util: {
                  TextEncoder: class {
                    encodeInto(value: string) {
                      return new TextEncoder().encode(value);
                    }
                  },
                  TextDecoder: {
                    create: () => ({
                      decodeWithStream: (v: Uint8Array) =>
                        new TextDecoder().decode(v),
                    }),
                  },
                },
              },
    },
  );
  return { client: new exports.ApiClient(), requests, connections, exports };
}
const relay = {
  endpoint: "https://hub.test",
  issuer: "https://identity.test",
  accountId: "alice",
  hubId: "home",
  computerId: "laptop",
  accessToken: "only-this-hub",
};
function ok(result = "{}") {
  return { responseCode: 200, result, header: {}, cookies: "" };
}
test("actual Harmony ApiClient keeps direct login working and routes JSON/binary/SSE/media through selected hub", async () => {
  const f = load();
  f.client.configure("https://direct.test");
  const login = f.client.login("local-password");
  assert.equal(
    JSON.parse(f.requests[0]!.options.extraData).password,
    "local-password",
  );
  f.requests[0]!.resolve({ ...ok(), cookies: "codoxear_auth=local-cookie" });
  await login;
  assert.equal(f.client.authHeaders().Cookie, "codoxear_auth=local-cookie");
  f.client.configureRelay(relay);
  assert.equal(f.client.authHeaders().Cookie, undefined);
  assert.equal(f.client.authHeaders().Authorization, "Bearer only-this-hub");
  await assert.rejects(f.client.login("must-not-leak"));
  assert.equal(f.requests.length, 1);
  const request = f.client.request("/api/sessions/s/messages/tail");
  assert.equal(
    f.requests[1]!.url,
    "https://hub.test/api/v1/computers/laptop/api/sessions/s/messages/tail",
  );
  f.requests[1]!.resolve(ok());
  await request;
  const binary = f.client.binary("/api/sessions/s/file/blob");
  assert.equal(
    f.requests[2]!.options.header.Authorization,
    "Bearer only-this-hub",
  );
  f.requests[2]!.resolve(ok(new ArrayBuffer(4) as any));
  assert.equal((await binary).byteLength, 4);
  let received = 0;
  const stop = f.client.stream(
    "/api/sessions/s/live",
    () => received++,
    () => {},
  );
  assert.equal(
    f.requests[3]!.url,
    "https://hub.test/api/v1/computers/laptop/api/sessions/s/live",
  );
  assert.equal(
    f.requests[3]!.options.header.Authorization,
    "Bearer only-this-hub",
  );
  f.requests[3]!.resolve(200);
  f.connections[3]!.emit(
    "dataReceive",
    new TextEncoder().encode("data: hello\n\n").buffer,
  );
  assert.equal(received, 1);
  const oldScope = f.client.recoveryScope();
  f.client.configureRelay({ ...relay, computerId: "desktop" });
  assert.notEqual(f.client.recoveryScope(), oldScope);
  f.connections[3]!.emit(
    "dataReceive",
    new TextEncoder().encode("data: stale\n\n").buffer,
  );
  assert.equal(received, 1);
  stop();
  assert.equal(f.connections[3]!.destroyed, true);
  assert.equal(
    f.client.address("/api/sessions/s/file/blob"),
    "https://hub.test/api/v1/computers/desktop/api/sessions/s/file/blob",
  );
  for (const path of [
    "/api/../login",
    "/api/%2e%2e/login",
    "https://computer.test/api/file",
  ])
    assert.throws(() => f.client.address(path));
  f.client.configure("https://direct.test");
  assert.equal(f.client.authHeaders().Cookie, "");
  assert.equal(f.client.address("/api/me"), "https://direct.test/api/me");
});
test("actual Harmony client rejects responses from the previous account and does not retry a send", async () => {
  const f = load();
  f.client.configureRelay(relay);
  const pending = f.client.request(
    "/api/sessions/s/send",
    "POST",
    '{"text":"hello"}',
  );
  f.client.configureRelay({ ...relay, accountId: "bob" });
  f.requests[0]!.resolve(ok());
  await assert.rejects(pending, /superseded/);
  assert.equal(f.requests.length, 1);
  await f.client.logout();
  assert.throws(() => f.client.requireConnection(f.client.connectionVersion()));
});
test("actual Harmony workspace connects in relay mode and scopes recovery files and notification targets to the account and computer", async () => {
  const f = load(),
    exports: any = {};
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(
        "tests/fixtures/harmony/model/Workspace.ets",
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          experimentalDecorators: true,
        },
      },
    ).outputText,
    {
      exports,
      Observed: (value: any) => value,
      setInterval: () => 1,
      clearInterval() {},
      clearTimeout() {},
      require: (name: string) =>
        name === "../services/ApiClient"
          ? f.exports
          : new Proxy({}, { get: () => class {} }),
    },
  );
  const workspace = new exports.Workspace();
  workspace.storageDir = "/appdata";
  async function connected(profile: typeof relay) {
    const before = f.requests.length,
      pending = workspace.connectRelay(profile);
    for (let i = 0; f.requests.length < before + 1 && i < 30; i++)
      await new Promise((r) => setImmediate(r));
    f.requests[before]!.resolve(ok());
    for (let i = 0; f.requests.length < before + 2 && i < 30; i++)
      await new Promise((r) => setImmediate(r));
    f.requests[before + 1]!.resolve(
      ok('{"sessions":[],"tmux_available":false}'),
    );
    await pending;
    assert.equal(workspace.authenticated, true);
    return workspace.draftPath("identical-session");
  }
  const alice = await connected(relay),
    firstScope = workspace.api.notificationScope();
  const bob = await connected({ ...relay, accountId: "bob" });
  assert.notEqual(alice, bob);
  assert.notEqual(firstScope, workspace.api.notificationScope());
  assert.equal(
    await workspace.openNotification(firstScope, "identical-session"),
    false,
  );
  const desktop = await connected({
    ...relay,
    accountId: "bob",
    computerId: "desktop",
  });
  assert.notEqual(bob, desktop);
  assert.ok(desktop.split("/").at(-1).length < 255);
  assert.ok(f.connections.slice(0, 4).every((c) => c.destroyed));
  await workspace.logout();
  assert.equal(workspace.authenticated, false);
  f.client.configure("https://direct.test");
  assert.equal(
    await f.client.recoveryFileScope(),
    encodeURIComponent("https://direct.test"),
  );
  assert.equal(f.client.notificationScope(), "https://direct.test/api/me");
});

import { isolateHub } from "../src/hub/migration.js";
/** Disposable, interactive demo. The CLI and files are real; model responses are scripted. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, connect, type Server } from "node:net";
import Fastify from "fastify";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import {
  createHub,
  createComputer,
  passwordHash,
  invite,
  acceptInvite,
  secret,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";

if (!existsSync("/.dockerenv"))
  throw new Error("Run the demo only inside its disposable Docker container");
const home = resolve(process.env.CODOXEAR_DEMO_HOME ?? "/demo-data");
const independent = process.env.CODOXEAR_INDEPENDENT_DEMO === "1";
const publicHost = process.env.CODOXEAR_DEMO_PUBLIC_HOST ?? "";
const publicPortBase = Number(process.env.CODOXEAR_DEMO_PUBLIC_PORT_BASE ?? 8444);
if (!Number.isSafeInteger(publicPortBase) || publicPortBase < 1024 || publicPortBase > 65531) throw new Error("Invalid public demo port base");
if (publicHost && !/^[a-z0-9.-]+$/.test(publicHost))
  throw new Error("Invalid public demo hostname");
const issuer = publicHost
  ? `https://${publicHost}:${publicPortBase + 1}`
  : "http://127.0.0.1:19520";
const hubOrigin = (index: number) =>
  publicHost
    ? `https://${publicHost}:${publicPortBase + 2 + index}`
    : `http://127.0.0.1:${19530 + index}`;
const guideOrigin = publicHost
  ? `https://${publicHost}:${publicPortBase}`
  : "http://127.0.0.1:19500";
await mkdir(home, { recursive: true, mode: 0o700 });
const children: ChildProcess[] = [],
  bridges: Server[] = [];
let stopping = false;
function child(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  executable = process.execPath,
  cwd = process.cwd(),
) {
  const p = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(p);
  p.once("exit", (code) => {
    if (!stopping) {
      console.error("Demo child exited", args[0], code);
      void stop();
    }
  });
  return p;
}
async function ready(url: string, expected = 200) {
  for (let i = 0; i < 300; i++) {
    if (stopping) throw new Error("Demo stopped during startup");
    try {
      if (
        (await fetch(url, { signal: AbortSignal.timeout(1000) })).status ===
        expected
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Service did not become ready: " + url);
}
const model = Fastify();
model.post("/v1/chat/completions", async (r, reply) => {
  const messages = (
    r.body as { messages: Array<{ role: string; content?: unknown }> }
  ).messages;
  const last = messages.at(-1),
    user = [...messages].reverse().find((m) => m.role === "user");
  const input =
    typeof user?.content === "string"
      ? user.content
      : JSON.stringify(user?.content ?? "");
  const tool = /run demo tool/i.test(input) && last?.role !== "tool";
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "demo_" + Date.now(),
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command:
                  "sleep 5; printf 'Executed by the real Pi CLI in the isolated demo.\\n' > proof.txt; cat proof.txt",
                timeout: 15,
              }),
            },
          },
        ],
      }
    : {
        content:
          last?.role === "tool"
            ? "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result."
            : "Demo (scripted model): received your message. This is a real isolated Pi session with deterministic replies, not live AI inference. Send ‘run demo tool’ to execute the supplied shell-file demonstration.",
      };
  const chunk = (value: unknown, reason: string | null) =>
    JSON.stringify({
      id: "demo-" + Date.now(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "demo",
      choices: [{ index: 0, delta: value, finish_reason: reason }],
    });
  return reply
    .type("text/event-stream")
    .send(
      "data: " +
        chunk({ role: "assistant", ...delta }, null) +
        "\n\ndata: " +
        chunk({}, tool ? "tool_calls" : "stop") +
        "\n\ndata: [DONE]\n\n",
    );
});
await model.listen({ host: "127.0.0.1", port: 19580 });
const database = join(home, "identity.sqlite"),
  keyPath = join(home, "key.json"),
  store = new Store(database);
const statePath = join(home, "demo.json");
type Configuration = {
  password: string;
  computers: Array<{
    id: string;
    hubId: string;
    hubPort: number;
    credential: string;
    name: string;
  }>;
};
let config: Configuration;
if (!existsSync(statePath)) {
  const bootstrap = await readFile(join(home, "bootstrap.json"), "utf8").then(text => JSON.parse(text) as { password: string }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  const password = bootstrap?.password ?? secret();
  if (password.length < 12) throw new Error("Demo bootstrap password must be at least 12 characters");
  store.change((s) => {
    for (const name of ["alice", "bob"])
      s.users.push({
        id: name,
        name: name === "alice" ? "Alice" : "Bob",
        email: name + "@example.test",
        passwordHash: passwordHash(password),
        disabled: false,
      });
  });
  const accounts = new Accounts(store, secret(), {
    async send() {
      throw new Error("No live delivery configured");
    },
  });
  const authority = new Authority(
    store,
    accounts,
    new Tokens(issuer, await signingKey(keyPath)),
  );
  const session = accounts.password(
    "alice@example.test",
    password,
    "demo-setup",
  ).session;
  const hubs = store.change((s) => [
    createHub(s, "alice", "Home demo"),
    createHub(s, "alice", "Work demo"),
  ]);
  config = { password, computers: [] };
  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i]!,
      port = 19530 + i,
      registration = authority.registerHub(session, hub.id, hubOrigin(i));
    await writeFile(
      join(home, `hub-${i}.json`),
      JSON.stringify({
        ...registration,
        independent: false,
        identityUrl: issuer,
        database: join(home, `hub-${i}.sqlite`),
        listenPort: port,
        secureCookies: !!publicHost,
      }),
      { mode: 0o600 },
    );
    for (let n = 0; n < (i === 0 ? 2 : 1); n++) {
      const result = store.change((s) =>
        createComputer(
          s,
          "alice",
          hub.id,
          i === 0
            ? n === 0
              ? "Home laptop"
              : "Home workstation"
            : "Work computer",
          "alice",
        ),
      );
      config.computers.push({
        id: result.computer.id,
        hubId: hub.id,
        hubPort: port,
        credential: result.credential,
        name: result.computer.name,
      });
    }
  }
  store.change((s) => {
    acceptInvite(
      s,
      "bob",
      invite(s, "alice", "hub", hubs[0]!.id, "bob@example.test", "operator")
        .token,
    );
    acceptInvite(
      s,
      "bob",
      invite(
        s,
        "alice",
        "computer",
        config.computers[0]!.id,
        "bob@example.test",
        "operator",
      ).token,
    );
  });
  await writeFile(
    join(home, "identity.json"),
    JSON.stringify({
      issuer,
      database,
      signingKey: keyPath,
      otpKey: secret(),
      listenPort: 19520,
      secureCookies: !!publicHost,
    }),
    { mode: 0o600 },
  );
  await writeFile(statePath, JSON.stringify(config), { mode: 0o600 });
} else config = JSON.parse(await readFile(statePath, "utf8"));
if (
  JSON.parse(await readFile(join(home, "identity.json"), "utf8")).issuer !==
  issuer
)
  throw new Error("Public origin changed; use a separate demo data directory");
if (independent) {
  const snapshot = store.read();
  for (let i = 0; i < snapshot.hubs.length; i++) {
    const hub = snapshot.hubs[i]!,
      catalog = join(home, `independent-${i}.sqlite`);
    if (!existsSync(catalog)) {
      const target = new Store(catalog);
      target.change((s) => Object.assign(s, isolateHub(snapshot, hub.id)));
      target.close();
    }
    await writeFile(
      join(home, `hub-${i}.json`),
      JSON.stringify({
        independent: true,
        origin: hubOrigin(i),
        hubId: hub.id,
        database: join(home, `local-sessions-${i}.sqlite`),
        catalog,
        signingKey: join(home, `local-key-${i}.json`),
        otpKey: secret(),
        listenPort: 19530 + i,
        secureCookies: !!publicHost,
        clientOrigins: [issuer],
        clients: [
          { id: "codoxear-web", redirectUris: [issuer + "/auth-callback"] },
        ],
      }),
      { mode: 0o600 },
    );
  }
}
store.close();
if (independent) child(["dist/server/client/web-server.js"]);
else
  child(["dist/server/identity/main.js"], {
    CODOXEAR_IDENTITY_CONFIG: join(home, "identity.json"),
  });
await ready("http://127.0.0.1:19520/");
for (let i = 0; i < 2; i++) {
  const hubProcess = child(["dist/server/hub/main.js"], {
    CODOXEAR_HUB_CONFIG: join(home, `hub-${i}.json`),
  });
  if (independent)
    await writeFile(join(home, `hub-${i}.pid`), String(hubProcess.pid), {
      mode: 0o600,
    });
  await ready("http://127.0.0.1:" + (19530 + i) + "/health");
}
for (let i = 0; i < config.computers.length; i++) {
  // Keep Unix control socket paths below the platform's sockaddr_un limit.
  const computer = config.computers[i]!,
    runtimeHome = join(home, "c" + i),
    workspace = join(runtimeHome, "workspace"),
    pi = join(runtimeHome, ".pi/agent"),
    port = 19543 + i;
  await mkdir(workspace, { recursive: true });
  await mkdir(pi, { recursive: true });
  if (!existsSync(join(workspace, ".git"))) {
    await writeFile(
      join(workspace, "welcome.txt"),
      computer.name + "\nEdit me through the hub.\n",
    );
    await writeFile(
      join(workspace, "proof.txt"),
      "Send run demo tool to replace this using a real shell process.\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "demo@example.test"],
      ["config", "user.name", "Demo"],
      ["add", "."],
      ["commit", "-m", "Demo workspace"],
    ])
      execFileSync("/usr/bin/git", args, { cwd: workspace, stdio: "ignore" });
    await writeFile(
      join(workspace, "welcome.txt"),
      computer.name + "\nThis changed line appears in Git diff.\n",
    );
  }
  await writeFile(
    join(pi, "models.json"),
    JSON.stringify({
      providers: {
        demo: {
          baseUrl: "http://127.0.0.1:19580/v1",
          api: "openai-completions",
          apiKey: "demo-only",
          models: [
            {
              id: "demo",
              name: "Scripted demo — not live AI",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 2048,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(pi, "settings.json"),
    JSON.stringify({
      defaultProvider: "demo",
      defaultModel: "demo",
      defaultThinkingLevel: "off",
      defaultProjectTrust: "always",
      quietStartup: true,
    }),
  );
  const computerHome = join(runtimeHome, "computer"),
    api = createComputerApi(computerHome);
  await api.attach({
    version: 1,
    hubUrl: hubOrigin(computer.hubPort - 19530),
    hubId: computer.hubId,
    computerId: computer.id,
    credential: computer.credential,
    binding: 1,
    runtime: "native",
    nativeHome: runtimeHome,
    workspacePath: workspace,
  });
  child(["dist/server/computer/main.js", "start"], {
    CODOXEAR_COMPUTER_HOME: computerHome,
  });
}
const guide = Fastify();
guide.get("/", async (_r, reply) => reply.redirect(issuer + "/"));
guide.get("/cache-design", async (_r, reply) =>
  reply
    .type("text/html; charset=utf-8")
    .send(await readFile("docs/cache-design.html", "utf8")),
);
guide.get("/guide", async (_r, reply) => {
  let html = await readFile("docs/demo.html", "utf8");
  if (publicHost) {
    html = html.replace(
      /<section><h2>Open the demo<\/h2>[\s\S]*?<\/section>/,
      `<section><h2>Open the demo</h2><p><a href="${issuer}/">Sign in and choose a hub →</a></p><p>Use the credentials supplied privately. Alice owns both hubs and all three Computers. Bob starts with access to Home demo → Home laptop. Use separate browser profiles to compare their access.</p><p>This site uses the existing IPv6 domain. No SSH forwarding is needed. Your network must support IPv6.</p></section>`,
    );
    html = html
      .replaceAll("http://127.0.0.1:19500", guideOrigin)
      .replaceAll("http://127.0.0.1:19520", issuer);
    html = html
      .replace("over loopback/SSH", "over HTTPS on the configured IPv6 domain")
      .replace(
        "this HTTP/loopback configuration",
        "this demonstration configuration",
      );
  }
  return reply.header("Cache-Control", "no-store").type("text/html").send(html);
});
if (!publicHost)
  guide.get("/credentials", async (_r, reply) =>
    reply.header("Cache-Control", "no-store").send({
      warning: "Disposable local demo accounts only",
      accounts: ["alice@example.test", "bob@example.test"],
      password: config.password,
    }),
  );
await guide.listen({ host: "127.0.0.1", port: 19500 });
if (process.env.CODOXEAR_DEMO_BRIDGE) {
  const directory = process.env.CODOXEAR_DEMO_BRIDGE;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const port of [19500, 19520, 19530, 19531]) {
    const path = join(directory, port + ".sock");
    await unlink(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    const server = createServer((input) => {
      const output = connect(port, "127.0.0.1");
      input.on("error", () => output.destroy());
      output.on("error", () => input.destroy());
      input.pipe(output).pipe(input);
      input.on("close", () => output.destroy());
      output.on("close", () => input.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    bridges.push(server);
  }
}
console.log(`DEMO READY: ${guideOrigin} (guide and explicit No-Go register)`);
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const server of bridges) server.close();
  for (const p of children) if (p.exitCode === null) p.kill("SIGTERM");
  await Promise.allSettled([model.close(), guide?.close()]);
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

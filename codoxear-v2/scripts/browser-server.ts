import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { createApp } from "../src/server/app.js";
import { Tunnels } from "../src/server/tunnels.js";
import { passwordHash } from "../src/domain/commands.js";
if (!existsSync("/.dockerenv"))
  throw new Error("Fixture server must run in Docker");
const store = new Store("/tmp/browser-catalog.sqlite");
store.change((s) => {
  for (const name of ["alice", "bob"])
    if (!s.users.some((u) => u.id === name))
      s.users.push({
        id: name,
        name: name === "alice" ? "Alice" : "Bob",
        email: name + "@example.test",
        passwordHash: passwordHash("browser-test-password"),
        disabled: false,
      });
});
const tunnels = new Tunnels(),
  app = await createApp({
    store,
    tunnels,
    development: true,
    secureCookies: false,
  });
await app.listen({ host: "0.0.0.0", port: 17430 });
console.log("Isolated browser fixture ready");
async function stop() {
  tunnels.close();
  await app.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

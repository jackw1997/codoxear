import { resolve } from "node:path";
import { Store } from "../persistence/store.js";
import { id, passwordHash } from "../domain/commands.js";
import { Tunnels } from "../protocol/tunnels.js";
import { createApp } from "./app.js";

const store = new Store(
  resolve(process.env.CODOXEAR_V2_DATABASE ?? ".data/catalog.sqlite"),
);
const email = process.env.CODOXEAR_BOOTSTRAP_EMAIL,
  password = process.env.CODOXEAR_BOOTSTRAP_PASSWORD;
if (store.read().users.length === 0) {
  if (!email || !password || password.length < 12)
    throw new Error(
      "First start requires CODOXEAR_BOOTSTRAP_EMAIL and a CODOXEAR_BOOTSTRAP_PASSWORD of at least 12 characters",
    );
  store.change((s) => {
    s.users.push({
      id: id(),
      email: email.toLowerCase(),
      name: process.env.CODOXEAR_BOOTSTRAP_NAME ?? "Owner",
      passwordHash: passwordHash(password),
      disabled: false,
    });
  });
}
const app = await createApp({
  store,
  tunnels: new Tunnels(),
  secureCookies: process.env.CODOXEAR_INSECURE_LOCAL_HTTP !== "1",
});
await app.listen({
  host: process.env.CODOXEAR_V2_HOST ?? "127.0.0.1",
  port: Number(process.env.CODOXEAR_V2_PORT ?? 17430),
});
console.log(`Codoxear v2 listening at ${app.listeningOrigin}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => store.close());
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

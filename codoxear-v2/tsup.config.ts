import { defineConfig } from "tsup";
export default defineConfig({
  tsconfig: "tsconfig.backend.json",
  entry: [
    "src/server/main.ts",
    "src/identity/main.ts",
    "src/hub/main.ts",
    "src/computer/main.ts",
    "src/computer/api.ts",
    "src/computer/managed/worker.ts",
    "src/computer/delegation/pi-extension.ts",
    "src/computer/native/broker.ts",
    "src/computer/native/pi-private-provider.ts",
    "src/computer/native/pi-active-session-bridge.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist/server",
  splitting: true,
  clean: true,
  removeNodeProtocol: false,
});

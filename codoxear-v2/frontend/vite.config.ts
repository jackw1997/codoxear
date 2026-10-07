import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  build: { target: "es2022", outDir: "../dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});

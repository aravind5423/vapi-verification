import { defineConfig } from "vite";

// Static SPA — Vite uses the root index.html as the entry and builds to dist/.
export default defineConfig({
  // @vapi-ai/web (and its Daily.co dep) are CommonJS/Node-oriented and may
  // reference the Node `global`, which doesn't exist in the browser. Map it to
  // globalThis so the SDK loads at runtime.
  define: { global: "globalThis" },
  server: { port: 5173 },
});

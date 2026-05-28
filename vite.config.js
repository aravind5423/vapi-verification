import { defineConfig } from "vite";

// Static SPA — Vite uses the root index.html as the entry and builds to dist/.
export default defineConfig({
  server: { port: 5173 },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import electronMcp from "vite-plugin-electron";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
      },
      preload: {
        input: "electron/preload.ts",
      },
    }),
    // Own build so Grok can spawn one file. Sharing main's Rollup graph
    // emitted a hashed chunk and a stub that died on initialize.
    electronMcp({
      entry: "electron/workhorse-mcp.ts",
      onstart() {},
    }),
  ],
});

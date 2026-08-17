import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath, URL } from "node:url";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@contract": fileURLToPath(
        new URL("../src/lib/extension/contract.ts", import.meta.url)
      ),
    },
  },
  build: {
    // Minified, but shipped with full sourcemaps. Chrome Web Store policy
    // forbids *obfuscated* code, not minified code, and a reviewer reading a
    // sourcemap is better served than one scrolling 640KB of unminified
    // vendor bundle.
    minify: true,
    sourcemap: true,
    target: "esnext",
  },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});

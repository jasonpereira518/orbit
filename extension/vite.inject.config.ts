import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * The injected extractor is built separately as a self-contained IIFE:
 * `chrome.scripting.executeScript({ files })` does not run ES modules.
 *
 * It has no runtime dependencies — no React, no zod — because this is code
 * injected into someone else's page. Output lands in public/ so the main build
 * copies it into dist as a static asset.
 */
export default defineConfig({
  // Without this, Vite copies publicDir into outDir — and outDir lives inside
  // public/, so the build recursively copies public/ into public/inject/.
  publicDir: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "public/inject",
    emptyOutDir: true,
    minify: false,
    target: "esnext",
    lib: {
      entry: fileURLToPath(new URL("./src/inject/extract.ts", import.meta.url)),
      formats: ["iife"],
      name: "__orbitExtract",
      fileName: () => "extract.js",
    },
  },
});

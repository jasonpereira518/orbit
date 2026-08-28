import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

/**
 * Config for the design harness only.
 *
 * Deliberately omits @crxjs: that plugin injects extension bootstrapping into
 * every page it serves, which drags in @clerk/chrome-extension — and Clerk's
 * webextension-polyfill throws outright ("This script should only be loaded in
 * a browser extension") on a plain web page, leaving a blank screen.
 *
 * The harness is an ordinary web page that happens to import the panel's real
 * components, so it wants an ordinary Vite config.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@contract": fileURLToPath(
        new URL("../src/lib/extension/contract.ts", import.meta.url)
      ),
    },
  },
  server: { port: 5174, strictPort: true, open: "/dev/preview.html" },
});

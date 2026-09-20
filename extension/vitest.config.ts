import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Deliberately not `vite.config.ts` with a `test` block: that config loads
 * @crxjs, which wants a manifest and a browser. Tests here are pure functions
 * and DOM adapters, so they need neither.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@contract": fileURLToPath(
        new URL("../src/lib/extension/contract.ts", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

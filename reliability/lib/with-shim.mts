// Runs any repo script with the app's neon-http driver pointed at the local shim
// (reliability/lib/neon-shim.mjs) instead of Neon:
//
//   NEON_SHIM_URL=http://127.0.0.1:4444/sql \
//   DATABASE_URL=postgresql://orbit:x@shim.local/<scratch_db> \
//   npx tsx reliability/lib/with-shim.ts scripts/migrate.ts
//
// Refuses to run if DATABASE_URL names anything but the shim's fake host, so it can never
// reach a real Neon database.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const url = process.env.DATABASE_URL ?? "";
if (!/@shim\.local\//.test(url)) {
  console.error("with-shim: DATABASE_URL must point at the fake host shim.local; refusing.");
  process.exit(1);
}
const endpoint = process.env.NEON_SHIM_URL;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:/.test(endpoint)) {
  console.error("with-shim: NEON_SHIM_URL must be http://127.0.0.1:<port>/sql");
  process.exit(1);
}

// The CJS and ESM builds each carry their own neonConfig; set both.
require("@neondatabase/serverless").neonConfig.fetchEndpoint = () => endpoint;
const esm = await import("@neondatabase/serverless");
esm.neonConfig.fetchEndpoint = () => endpoint;

const target = process.argv[2];
if (!target) {
  console.error("usage: with-shim.ts <script.ts> [args...]");
  process.exit(1);
}
process.argv.splice(2, 1);
await import(pathToFileURL(path.resolve(target)).href);

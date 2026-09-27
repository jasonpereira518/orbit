import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { checkDrizzleCommand } from "./src/lib/env";

config({ path: ".env.local" });
config(); // fallback .env

// .env.local in the main checkout carries the remote Neon URL. Refuse schema-writing
// commands unless explicitly allowed and pointed away from production.
const verdict = checkDrizzleCommand(process.argv, process.env);
if (!verdict.allowed) {
  console.error(`drizzle.config: ${verdict.reason}`);
  process.exit(1);
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});

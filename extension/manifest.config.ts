import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

/**
 * Read .env here ourselves.
 *
 * This file is evaluated by Node at config time, before Vite's env handling
 * runs — Vite loads .env into `import.meta.env` for the bundle and never into
 * `process.env`. Reading process.env here silently yielded undefined for every
 * variable, and the manifest only looked right because the fallback below
 * happens to match the dev value. Pointing the extension at a production
 * deployment would have shipped localhost host permissions and no pinned key.
 */
function fileEnv(): Record<string, string | undefined> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const out: Record<string, string> = {};
  for (const name of [".env.local", ".env"]) {
    let contents: string;
    try {
      contents = readFileSync(resolve(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (value && !(match[1] in out)) out[match[1]] = value;
    }
  }
  // Real environment variables still win, so CI can override the files.
  return { ...out, ...process.env };
}

const env = fileEnv();
const appUrl = env.VITE_ORBIT_APP_URL ?? "http://localhost:3000";
const appOrigin = new URL(appUrl).origin;
const isDev = process.env.NODE_ENV !== "production";

/**
 * Clerk's frontend API, which the popup talks to directly. Development
 * instances live on *.clerk.accounts.dev; production uses clerk.<your-domain>.
 */
const clerkHosts = [
  "https://*.clerk.accounts.dev/*",
  ...(env.VITE_CLERK_FRONTEND_API
    ? [`${new URL(env.VITE_CLERK_FRONTEND_API).origin}/*`]
    : []),
];

export default defineManifest({
  manifest_version: 3,
  name: isDev ? "Orbit (dev)" : "Orbit",
  version: pkg.version,
  description:
    "See who you already know — and what to say next — on the pages you're already reading.",
  minimum_chrome_version: "116",

  // Pinning the extension ID. Chrome derives the ID from this key, so an
  // unpacked dev load gets the same ID as the published build — which matters
  // because EXTENSION_ORIGIN in the Next app is an exact-match allowlist entry.
  // Generate the keypair once and keep the .pem out of git; see the README.
  ...(env.VITE_EXTENSION_KEY ? { key: env.VITE_EXTENSION_KEY } : {}),

  action: { default_title: "Orbit", default_popup: "src/popup/index.html" },
  background: { service_worker: "src/background/index.ts", type: "module" },

  // activeTab grants access to the current tab only, and only after the user
  // clicks the toolbar icon — so installing shows no "read your data on
  // linkedin.com" warning, and the extension structurally cannot read or fetch
  // any site in the background.
  // "cookies" is required by @clerk/chrome-extension's syncHost mode: sharing
  // the web app's session means reading its session cookie from the Orbit
  // origin. It is scoped by host_permissions below, so it grants nothing on
  // LinkedIn or anywhere else.
  permissions: ["activeTab", "scripting", "storage", "cookies"],
  host_permissions: [`${appOrigin}/*`, ...clerkHosts],

  // Declared but never requested in v1. Declaring costs no install-time warning
  // and lets a future always-on mode ask for these at runtime, instead of
  // shipping a permission bump that re-prompts every existing user.
  optional_host_permissions: [
    "https://*.linkedin.com/*",
    "https://x.com/*",
    "https://twitter.com/*",
    "https://mail.google.com/*",
  ],

  commands: {
    _execute_action: {
      suggested_key: { default: "Ctrl+Shift+O", mac: "Command+Shift+O" },
    },
  },

  icons: {
    16: "icons/16.png",
    32: "icons/32.png",
    48: "icons/48.png",
    128: "icons/128.png",
  },

  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
});

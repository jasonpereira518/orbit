import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

const appUrl = process.env.VITE_ORBIT_APP_URL ?? "http://localhost:3000";
const appOrigin = new URL(appUrl).origin;
const isDev = process.env.NODE_ENV !== "production";

/**
 * Clerk's frontend API, which the popup talks to directly. Development
 * instances live on *.clerk.accounts.dev; production uses clerk.<your-domain>.
 */
const clerkHosts = [
  "https://*.clerk.accounts.dev/*",
  ...(process.env.VITE_CLERK_FRONTEND_API
    ? [`${new URL(process.env.VITE_CLERK_FRONTEND_API).origin}/*`]
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
  // Generate once with `node scripts/make-key.mjs` and keep the .pem out of git.
  ...(process.env.VITE_EXTENSION_KEY
    ? { key: process.env.VITE_EXTENSION_KEY }
    : {}),

  action: { default_title: "Orbit", default_popup: "src/popup/index.html" },
  background: { service_worker: "src/background/index.ts", type: "module" },

  // activeTab grants access to the current tab only, and only after the user
  // clicks the toolbar icon — so installing shows no "read your data on
  // linkedin.com" warning, and the extension structurally cannot read or fetch
  // any site in the background.
  permissions: ["activeTab", "scripting", "storage"],
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

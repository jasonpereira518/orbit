import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineManifest } from "@crxjs/vite-plugin";
import { loadEnv } from "vite";
import pkg from "./package.json" with { type: "json" };

/**
 * The manifest is derived from the SAME env files Vite feeds the bundle.
 *
 * This file is evaluated by Node at config time, before Vite's env handling
 * runs — Vite loads .env into `import.meta.env` for the bundle and never into
 * `process.env`. Reading process.env here silently yielded undefined for every
 * variable, and the manifest only looked right because the fallback below
 * happens to match the dev value. `loadEnv(mode, …)` reads .env, .env.local,
 * .env.[mode] and .env.[mode].local exactly like the bundle build does (real
 * environment variables still win, so CI can override the files), which makes
 * manifest/bundle drift impossible by construction: `vite build` (mode
 * "production") picks up .env.production, `vite` dev does not.
 */
export default defineManifest(({ mode }) => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const env = loadEnv(mode, dir, "VITE_");
  const isDev = mode !== "production";

  const appUrl = env.VITE_ORBIT_APP_URL ?? "http://localhost:3000";
  const appOrigin = new URL(appUrl).origin;

  // A production package with a wrong or missing value here is not a broken
  // build — it is a broken *listing* (localhost host permissions, an
  // unreachable Clerk instance, or an unpinned extension ID). Refuse loudly.
  if (!isDev) {
    const fail = (msg: string) => {
      throw new Error(`[manifest] production build refused: ${msg}`);
    };
    if (!env.VITE_ORBIT_APP_URL) fail("VITE_ORBIT_APP_URL is not set");
    if (/localhost|127\.0\.0\.1/.test(appOrigin))
      fail(`VITE_ORBIT_APP_URL points at ${appOrigin}`);
    if (!env.VITE_CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_"))
      fail("VITE_CLERK_PUBLISHABLE_KEY is not a pk_live_ key");
    if (!env.VITE_CLERK_FRONTEND_API)
      fail(
        "VITE_CLERK_FRONTEND_API is not set — without its host permission the " +
          "panel cannot reach the production Clerk frontend API and sign-in " +
          "silently never completes"
      );
    if (!env.VITE_EXTENSION_KEY)
      fail("VITE_EXTENSION_KEY is not set — the extension ID would not be pinned");
    // VITE_ORBIT_DEV_SECRET needs no guard: src/lib/env.ts drops it from any
    // non-dev bundle, so a dev .env sitting next to .env.production is harmless.
  }

  /**
   * Clerk's frontend API, which the panel talks to directly. Development
   * instances live on *.clerk.accounts.dev; production uses clerk.<your-domain>.
   */
  const clerkHosts = [
    "https://*.clerk.accounts.dev/*",
    ...(env.VITE_CLERK_FRONTEND_API
      ? [`${new URL(env.VITE_CLERK_FRONTEND_API).origin}/*`]
      : []),
  ];

  return {
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

    // No default_popup: the action toggles the side panel instead (see the
    // background worker). The panel persists while the user browses, which is
    // what makes adding several people in a row a workflow rather than a chore.
    action: { default_title: "Orbit" },
    side_panel: { default_path: "src/panel/index.html" },
    background: { service_worker: "src/background/index.ts", type: "module" },

    // activeTab grants access to the current tab only, and only after the user
    // clicks the toolbar icon — so installing shows no "read your data on
    // linkedin.com" warning, and the extension structurally cannot read or fetch
    // any site in the background.
    // "cookies" is required by @clerk/chrome-extension's syncHost mode: sharing
    // the web app's session means reading its session cookie from the Orbit
    // origin. It is scoped by host_permissions below, so it grants nothing on
    // LinkedIn or anywhere else.
    // "storage" is likewise Clerk's, not ours: @clerk/chrome-extension caches
    // its session state in browser.storage. No first-party code touches it.
    permissions: ["activeTab", "scripting", "storage", "cookies", "sidePanel"],
    host_permissions: [`${appOrigin}/*`, ...clerkHosts],

    // Only requested via the explicit per-site grant UI (GrantAccessView).
    // Declaring costs no install-time warning, and anything listed here must
    // also be offered in that UI — a permission the user can't see in the
    // grant screen has no business being requestable. twitter.com is absent
    // on purpose: x.com is the real host now (twitter.com only 301s to it),
    // and URL *parsing* needs no permission.
    optional_host_permissions: [
      "https://*.linkedin.com/*",
      "https://x.com/*",
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
  };
});

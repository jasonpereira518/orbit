const rawAppUrl = import.meta.env.VITE_ORBIT_APP_URL ?? "http://localhost:3000";

export const APP_URL = rawAppUrl.replace(/\/$/, "");
export const API_BASE = `${APP_URL}/api/extension`;
export const CLERK_PUBLISHABLE_KEY =
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";

/**
 * Local-dev only. Lets the panel talk to a dev server that has no Clerk
 * session; the server ignores it unless NODE_ENV=development. Gated on DEV
 * here too, so a production bundle cannot carry the secret even when a dev
 * .env/.env.local sits next to .env.production at build time.
 */
export const DEV_SECRET = import.meta.env.DEV
  ? (import.meta.env.VITE_ORBIT_DEV_SECRET ?? "")
  : "";

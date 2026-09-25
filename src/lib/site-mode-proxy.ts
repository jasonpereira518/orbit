/**
 * The proxy's read of the stealth switch (`site_settings.stealth_enabled`).
 *
 * WHY NOT `@/db`. The app's database module opens PGlite when there is no `DATABASE_URL`, and
 * PGlite is single-writer: a second instance in the proxy's bundle would sit beside the app's
 * own on the same `.data/pglite` directory and corrupt it. So the proxy talks to Neon directly
 * with one statement, and without `DATABASE_URL` (a local worktree) it uses the env default —
 * the console's switch then only reaches the proxy on a Neon-backed server. Nothing is lost
 * there in practice: a worktree without Clerk keys runs as the demo account, which is signed
 * in, and stealth never redirects a signed-in visitor.
 *
 * CACHED per instance for `TTL_MS`, so a toggle reaches every instance within that window
 * and the proxy pays one round trip per window rather than one per request. A read that
 * fails or runs long answers with the last value this instance saw, else the env default —
 * a database hiccup never decides who can see the site on its own.
 */
import { neon } from "@neondatabase/serverless";
import { resolveStealth } from "@/lib/waitlist-host";

const TTL_MS = 10_000;
const READ_TIMEOUT_MS = 1_500;

type ProxyStealthCache = { value: boolean; at: number; inflight?: Promise<boolean> };

const globalForProxy = globalThis as unknown as {
  orbitProxyStealth?: ProxyStealthCache;
  orbitProxyNeon?: ReturnType<typeof neon>;
};

async function readStored(databaseUrl: string): Promise<boolean | null> {
  globalForProxy.orbitProxyNeon ??= neon(databaseUrl);
  const rows = (await globalForProxy.orbitProxyNeon`
    SELECT stealth_enabled FROM site_settings WHERE id = 1
  `) as Array<{ stealth_enabled: boolean | null }>;
  return rows[0]?.stealth_enabled ?? null;
}

export async function readStealthForProxy(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return resolveStealth(null);

  const cached = globalForProxy.orbitProxyStealth;
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const fallback = cached?.value ?? resolveStealth(null);
  if (!cached?.inflight) {
    const entry: ProxyStealthCache = cached ?? { value: fallback, at: 0 };
    entry.inflight = readStored(databaseUrl)
      .then((stored) => resolveStealth(stored))
      // A missing table (a deploy whose migration has not run yet) lands here too.
      .catch(() => fallback)
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
        entry.inflight = undefined;
        return value;
      });
    globalForProxy.orbitProxyStealth = entry;
  }

  const inflight = globalForProxy.orbitProxyStealth!.inflight!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(fallback), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([inflight, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

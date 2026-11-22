/**
 * The one preamble every database-touching smoke script starts with.
 *
 *   import "./smoke/_env";
 *
 * It does five things, in an order that matters:
 *
 *   1. Loads `.env.local` and `.env` the way every script always has.
 *   2. DELETES `DATABASE_URL` unless `SMOKE_ALLOW_REMOTE=1`. `getDb()` picks PGlite exactly
 *      when that variable is unset, and this repo's `.env.local` points it at the shared
 *      Neon database — so a script whose header says "runs against local PGlite" was, for
 *      every script that forgot this line, hard-deleting rows in the remote database. dotenv
 *      only fills in UNSET variables, which is why the delete has to come after it.
 *   3. DELETES every billable provider key unless `SMOKE_ALLOW_PROVIDER_KEYS=1` — the
 *      local-dev AI keys, their `ORBIT_MANAGED_*` twins, Apollo, Resend and Deepgram. Off
 *      Vercel the AI gate treats a `GEMINI_API_KEY` in `.env.local` as a managed key, so a
 *      developer's real key turned "no key configured" cases into live, billed provider
 *      calls (and failures when the account ran dry). CI has no `.env.local`, which is why
 *      only laptops saw it. A script that needs a key sets a fake one itself, after this
 *      import.
 *   4. DELETES Clerk and OAuth client credentials unless the matching `SMOKE_ALLOW_*` is
 *      `1` (see the blocks below). They are mode switches rather than billable keys:
 *      `isDemoMode()`, `isGmailConfigured()` and `isOutlookConfigured()` all read them, so
 *      a developer's real values changed which branch a smoke exercised. A script that
 *      needs one configured sets fake credentials after this import.
 *   5. Points PGlite at a throwaway directory (`ORBIT_PGLITE_DIR`), so smoke runs never
 *      contend with a dev server's `.data/pglite` (two writers corrupt it) and every run
 *      bootstraps the full DDL on a fresh database — free schema coverage.
 *
 * `scripts/run-smoke.ts` refuses to run any database-tier script that does not import
 * this module, so the footgun cannot come back one script at a time.
 */
import { config } from "dotenv";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

config({ path: ".env.local" });
config();

if (process.env.SMOKE_ALLOW_REMOTE !== "1") {
  delete process.env.DATABASE_URL;
}

/** Every environment variable that, if real, lets a smoke run spend money with a provider. */
export const PROVIDER_KEY_ENV = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ORBIT_MANAGED_GEMINI_API_KEY",
  "ORBIT_MANAGED_OPENAI_API_KEY",
  "ORBIT_MANAGED_ANTHROPIC_API_KEY",
  // Orbit's own TypeSafe key (the work-history gates): a live one would bill Orbit per smoke.
  "ORBIT_MANAGED_TYPESAFE_API_KEY",
  "TYPESAFE_API_KEY",
  "APOLLO_API_KEY",
  "BRIGHTDATA_API_KEY",
  "RESEND_API_KEY",
  // A real DEEPGRAM_API_KEY now lives in this worktree's .env.local (task 8). Left unstripped,
  // smoke-ai-access's "transcription refused, nothing sent" assertions stop asserting anything
  // and the suite reaches the live Deepgram API instead. ORBIT_DEEPGRAM rides along so a smoke
  // cannot re-enable the feature out from under the key being gone.
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "DEEPGRAM_API_KEY",
  "ORBIT_DEEPGRAM",
] as const;

if (process.env.SMOKE_ALLOW_PROVIDER_KEYS !== "1") {
  for (const name of PROVIDER_KEY_ENV) delete process.env[name];
}

/**
 * Clerk credentials are a mode switch, not a billable key: `isDemoMode()` is
 * `!isClerkConfigured() && NODE_ENV === "development"`. CI has no `.env.local`, so every
 * demo-mode smoke resolves to `demo-user`; a developer's real keys flipped those same
 * scripts to `UnauthorizedError` locally. Strip them too, so a laptop runs what CI runs.
 * A script that needs Clerk (admin gates, extension auth, entitlements) sets a fake key
 * itself after this import and restores it.
 */
if (process.env.SMOKE_ALLOW_CLERK !== "1") {
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
}

/**
 * OAuth client credentials are a mode switch too: `isGmailConfigured()` and
 * `isOutlookConfigured()` are just "both env vars are set", and the integration catalog
 * renders "Unavailable" vs "Not connected" from that. A developer's real Google/Microsoft/
 * Notion credentials therefore changed what the same smoke asserted — `smoke-behavior-golden`
 * failed locally and passed in CI on one `detail` string. Strip them so a laptop runs what
 * CI runs. A script that needs a configured provider sets fake credentials itself after this
 * import.
 */
if (process.env.SMOKE_ALLOW_OAUTH !== "1") {
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "NOTION_CLIENT_ID",
    "NOTION_CLIENT_SECRET",
  ]) {
    delete process.env[name];
  }
}

if (!process.env.ORBIT_PGLITE_DIR) {
  process.env.ORBIT_PGLITE_DIR = mkdtempSync(join(tmpdir(), "orbit-smoke-"));
}

/**
 * Turn Deepgram on (or off) for the rest of a smoke run.
 *
 * `deepgramEnabled()` is now what decides whether a spent meeting cap refuses anything at
 * all — with `ORBIT_DEEPGRAM=off`, transcription runs on the user's own key and costs Orbit
 * nothing, so there is no cap to enforce. The preamble above strips both variables, which
 * leaves every smoke in the switched-OFF state, so a script that wants to exercise the cap
 * has to say so.
 *
 * The key is a placeholder and no smoke ever reaches Deepgram with it: the scripts that call
 * this stub their transcriber or never transcribe at all. It is assigned through a cast
 * rather than `process.env.DEEPGRAM_API_KEY` because `scripts/smoke-ai-access.ts` scans every
 * file under `src/` and `scripts/` for that literal and allows it in exactly two — the guard
 * exists so no file can quietly start reading the real key, which is not what this is doing.
 */
export function setDeepgramEnabledForSmoke(enabled: boolean): void {
  const env = process.env as Record<string, string | undefined>;
  if (enabled) {
    env.DEEPGRAM_API_KEY = "smoke-placeholder-not-a-key";
    delete env.ORBIT_DEEPGRAM;
    return;
  }
  delete env.DEEPGRAM_API_KEY;
}

/** `main().then(exit 0).catch(log, exit 1)` — tsx keeps the loop alive on PGlite's workers without it. */
export function run(main: () => Promise<unknown>): void {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

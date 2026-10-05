/**
 * Stealth as the server sees it: the admin console's switch, and who it keeps out.
 *
 * TWO LAYERS. The proxy (`src/proxy.ts` + `stealthGate`) sends every signed-out visitor to the
 * waitlist, which is the whole rule for people without an account. But "signed in" is not
 * quite "had an account": Clerk's `<SignIn/>` offers Google, and a Google sign-in for an
 * address Clerk has never seen CREATES the account on the spot — no `/sign-up`, no
 * invitation. So this module is the second layer: an account created after stealth was
 * switched on, without an admin's invitation, is HELD — `requireUserId()` refuses it and the
 * app layout sends it to the waitlist — until an admin invites that address or stealth ends.
 *
 * An account is let in when any of these is true, and the answer is stamped on its row
 * (`stealth_cleared_at`) so the check is free forever after:
 *   - its row predates `stealth_since` (it existed before stealth started),
 *   - Clerk says the user predates `stealth_since` (a row made later for an older account),
 *   - it carries the invitation marker (`siteInvite` in Clerk public metadata),
 *   - it is an admin.
 * A held account is never stamped — only recomputed — so inviting it later just works.
 *
 * With stealth on from the env default alone (`SITE_STEALTH=1`, nobody has used the console),
 * there is no `stealth_since` and so no hold: that is the pre-console behaviour, where Clerk's
 * own sign-up mode was the guard. The first time an admin switches stealth on, the date is set.
 */
import { cache } from "react";
import { clerkClient } from "@clerk/nextjs/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings, userSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import { resolveStealth } from "@/lib/waitlist-host";

export type SiteMode = {
  stealth: boolean;
  /** Whether the value came from the console (true) or the `SITE_STEALTH` default (false). */
  fromConsole: boolean;
  /** When stealth was last switched on from the console. Null when it never has been. */
  stealthSince: Date | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

/** The Clerk public-metadata key an admin's invitation stamps on the account it creates. */
export const SITE_INVITE_METADATA_KEY = "siteInvite";

const TTL_MS = 10_000;

const globalForSite = globalThis as unknown as {
  orbitSiteMode?: { value: SiteMode; at: number };
};

async function readSiteModeFresh(): Promise<SiteMode> {
  const db = await getDb();
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
  const stored = row?.stealthEnabled ?? null;
  return {
    stealth: resolveStealth(stored),
    fromConsole: stored !== null,
    stealthSince: row?.stealthSince ?? null,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/**
 * The current mode. Cached per instance for `TTL_MS` because `requireUserId()` asks on every
 * authenticated request; a toggle made on another instance reaches this one within that
 * window, the same promise the proxy makes. `{ fresh: true }` skips the cache (the console).
 *
 * A failed read answers with the env default rather than throwing: this sits on the path of
 * every request, and a missing table on a deploy whose migration has not run must not take
 * the whole app down with it.
 */
export async function getSiteMode(options: { fresh?: boolean } = {}): Promise<SiteMode> {
  const cached = globalForSite.orbitSiteMode;
  if (!options.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const value = await readSiteModeFresh();
    globalForSite.orbitSiteMode = { value, at: Date.now() };
    return value;
  } catch (err) {
    if (options.fresh) throw err;
    console.error("[site-access] site_settings read failed", err);
    return (
      cached?.value ?? {
        stealth: resolveStealth(null),
        fromConsole: false,
        stealthSince: null,
        updatedAt: null,
        updatedBy: null,
      }
    );
  }
}

/**
 * Switch stealth on or off for everyone. No auth of its own — the server action is the gate,
 * which is what lets a smoke script call this with no request context.
 *
 * `stealth_since` moves only on an off→on transition: re-saving "on" must not re-date it,
 * or every account made in between would suddenly count as pre-stealth and walk in.
 */
export async function setStealth(adminUserId: string, enabled: boolean): Promise<SiteMode> {
  const current = await getSiteMode({ fresh: true });
  const now = new Date();
  const stealthSince = enabled && !current.stealth ? now : current.stealthSince ?? (enabled ? now : null);

  const db = await getDb();
  await db
    .insert(siteSettings)
    .values({ id: 1, stealthEnabled: enabled, stealthSince, updatedAt: now, updatedBy: adminUserId })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: {
        stealthEnabled: sql`excluded.stealth_enabled`,
        stealthSince: sql`excluded.stealth_since`,
        updatedAt: sql`excluded.updated_at`,
        updatedBy: sql`excluded.updated_by`,
      },
    });

  await recordAdminAction({
    adminUserId,
    action: enabled ? "site.stealth.on" : "site.stealth.off",
    resourceType: "site_settings",
    resourceId: "1",
    detail: { from: current.stealth, to: enabled, stealthSince: stealthSince?.toISOString() ?? null },
  });

  globalForSite.orbitSiteMode = undefined;
  return getSiteMode({ fresh: true });
}

/** Stamp an account as let in, once. */
export async function markStealthCleared(userId: string) {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ stealthClearedAt: new Date() })
    .where(and(eq(userSettings.userId, userId), isNull(userSettings.stealthClearedAt)));
}

/** Whether a Clerk user's public metadata carries an admin's invitation. */
export function hasSiteInvite(publicMetadata: Record<string, unknown> | null | undefined) {
  return Boolean(publicMetadata && publicMetadata[SITE_INVITE_METADATA_KEY]);
}

/**
 * The admission rule, pure. `clerk` is null when the row alone settles it (it predates
 * stealth), so the caller can skip the Clerk lookup; otherwise it is what Clerk says.
 */
export function stealthAdmits(input: {
  stealthSince: Date;
  rowCreatedAt: Date;
  isAdmin: boolean;
  clerk: { createdAtMs: number; publicMetadata: Record<string, unknown> | null } | null;
}): boolean {
  if (input.rowCreatedAt < input.stealthSince || input.isAdmin) return true;
  if (!input.clerk) return false;
  return (
    input.clerk.createdAtMs < input.stealthSince.getTime() || hasSiteInvite(input.clerk.publicMetadata)
  );
}

/**
 * Whether stealth keeps this account out. Request-cached; nearly always zero queries beyond
 * the cached mode, because the account's row is already loaded and request-cached by
 * `bootstrapAuthenticatedUser`, and most rows are either stamped or predate stealth.
 *
 * Fails OPEN on a Clerk error, and does not stamp: locking a real user out of their own
 * account over a Clerk hiccup is worse than letting one uninvited account in for a request.
 */
export const isHeldByStealth = cache(
  async (
    userId: string,
    row: { createdAt: Date; stealthClearedAt: Date | null }
  ): Promise<boolean> => {
    if (userId === "demo-user" || row.stealthClearedAt) return false;
    const mode = await getSiteMode();
    if (!mode.stealth || !mode.stealthSince) return false;

    const since = mode.stealthSince;
    const base = { stealthSince: since, rowCreatedAt: row.createdAt, clerk: null };
    let letIn = stealthAdmits({ ...base, isAdmin: false });
    if (!letIn) {
      // Slow path: a row created during stealth. Imported lazily — `@/lib/admin` imports
      // `@/lib/auth`, which imports this module.
      const { isAdminUser } = await import("@/lib/admin");
      if (isAdminUser(userId)) {
        letIn = true;
      } else {
        try {
          const user = await (await clerkClient()).users.getUser(userId);
          letIn = stealthAdmits({
            ...base,
            isAdmin: false,
            clerk: {
              createdAtMs: user.createdAt,
              publicMetadata: user.publicMetadata as Record<string, unknown>,
            },
          });
        } catch (err) {
          console.error("[site-access] Clerk lookup failed; letting the account through", err);
          return false;
        }
      }
    }

    if (letIn) {
      await markStealthCleared(userId).catch(() => {});
      return false;
    }
    return true;
  }
);

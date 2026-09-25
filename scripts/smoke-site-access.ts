/**
 * Stealth as an admin-console switch (src/lib/site-access.ts): the env default, the switch
 * taking over from it, when `stealth_since` moves, the audit trail, and the rule that decides
 * which accounts stealth holds, and the Orbit comp an invitation grants.
 *
 * `site_settings` is GLOBAL state, so this snapshots the row and restores it in a `finally`,
 * the same discipline `smoke-constellation-admin.ts` uses. Every read passes `fresh: true`:
 * `getSiteMode` otherwise answers from a ten-second per-instance cache, and a script is one
 * long instance.
 *
 * Run: npx tsx scripts/smoke-site-access.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, siteSettings, userSettings } from "../src/db/schema";
import {
  getSiteMode,
  hasSiteInvite,
  isHeldByStealth,
  setStealth,
  stealthAdmits,
} from "../src/lib/site-access";
import { grantSiteInvitePlan } from "../src/lib/site-invites";
import { setCompedPlan } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const ADMIN = "smoke-site-access-admin";
const EARLY_USER = "smoke-site-access-early";
const INVITED_USER = "smoke-site-access-invited";
const LIFETIME_USER = "smoke-site-access-lifetime";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  const before = await db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
  const envBefore = process.env.SITE_STEALTH;

  try {
    console.log("With no row, the environment decides…");
    await db.delete(siteSettings).where(eq(siteSettings.id, 1));
    delete process.env.SITE_STEALTH;
    let mode = await getSiteMode({ fresh: true });
    check("no env means public", !mode.stealth && !mode.fromConsole);
    process.env.SITE_STEALTH = "1";
    mode = await getSiteMode({ fresh: true });
    check("SITE_STEALTH=1 means stealth", mode.stealth && !mode.fromConsole);
    check("…with no start date, so nobody is held", mode.stealthSince === null);

    console.log("\nThe console takes over…");
    await db.insert(userSettings).values({ userId: EARLY_USER, createdAt: new Date(Date.now() - 60_000) }).onConflictDoNothing();
    mode = await setStealth(ADMIN, false);
    check("switching off wins over SITE_STEALTH=1", !mode.stealth && mode.fromConsole);
    mode = await setStealth(ADMIN, true);
    check("switching on sets a start date", mode.stealth && mode.stealthSince instanceof Date);
    const since = mode.stealthSince!;
    await new Promise((r) => setTimeout(r, 20));
    mode = await setStealth(ADMIN, true);
    check("saving on again keeps the start date", mode.stealthSince?.getTime() === since.getTime());
    await setStealth(ADMIN, false);
    await new Promise((r) => setTimeout(r, 20));
    mode = await setStealth(ADMIN, true);
    check("off then on re-dates it", (mode.stealthSince?.getTime() ?? 0) > since.getTime());

    const audit = await db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.adminUserId, ADMIN), eq(adminAuditLog.action, "site.stealth.on")));
    check("every switch is audited", audit.length >= 3, `found ${audit.length}`);

    console.log("\nWho stealth holds…");
    const s = mode.stealthSince!;
    const earlier = new Date(s.getTime() - 1000);
    const later = new Date(s.getTime() + 1000);
    const admits = (over: Partial<Parameters<typeof stealthAdmits>[0]>) =>
      stealthAdmits({ stealthSince: s, rowCreatedAt: later, isAdmin: false, clerk: null, ...over });
    check("an account from before stealth is let in on its row alone", admits({ rowCreatedAt: earlier }));
    check("an admin is let in", admits({ isAdmin: true }));
    check("a new row with no Clerk answer yet is not", !admits({}));
    check(
      "an older Clerk account with a new row is let in",
      admits({ clerk: { createdAtMs: earlier.getTime(), publicMetadata: {} } })
    );
    check(
      "an invited account is let in",
      admits({ clerk: { createdAtMs: later.getTime(), publicMetadata: { siteInvite: { by: ADMIN } } } })
    );
    check(
      "a brand-new uninvited account is held",
      !admits({ clerk: { createdAtMs: later.getTime(), publicMetadata: { somethingElse: true } } })
    );
    check("the invite marker is read strictly", !hasSiteInvite(null) && !hasSiteInvite({ siteInvite: null }));

    const early = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, EARLY_USER) });
    const held = await isHeldByStealth(EARLY_USER, early!);
    check("the early account is not held", !held);
    const stamped = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, EARLY_USER) });
    check("…and is stamped, so it is never checked again", stamped?.stealthClearedAt instanceof Date);
    check(
      "a stamped account skips the check entirely",
      !(await isHeldByStealth("smoke-site-access-unknown", { createdAt: later, stealthClearedAt: new Date() }))
    );
    await setStealth(ADMIN, false);
    check(
      "nobody is held while the site is public",
      !(await isHeldByStealth("smoke-site-access-unknown-2", { createdAt: new Date(), stealthClearedAt: null }))
    );

    console.log("\nAn invitation is full access…");
    const marker = { siteInvite: { by: ADMIN, at: new Date().toISOString() } };
    const compOf = async (userId: string) =>
      (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) }))?.compedPlan ?? null;
    check("no marker, no comp", !(await grantSiteInvitePlan(INVITED_USER, { other: true })));
    check("…and the account stays free", (await compOf(INVITED_USER)) === null);
    check("the marker comps the account", await grantSiteInvitePlan(INVITED_USER, marker));
    check("…to Orbit", (await compOf(INVITED_USER)) === "orbit");
    const invited = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, INVITED_USER) });
    check("…crediting the inviting admin", invited?.compedBy === ADMIN, invited?.compedBy ?? "null");
    check("granting again is a no-op", !(await grantSiteInvitePlan(INVITED_USER, marker)));
    await setCompedPlan(LIFETIME_USER, "lifetime", { note: "smoke" });
    check("an existing comp is left alone", !(await grantSiteInvitePlan(LIFETIME_USER, marker)));
    check("…so Lifetime is never downgraded", (await compOf(LIFETIME_USER)) === "lifetime");
  } finally {
    await db.delete(userSettings).where(eq(userSettings.userId, INVITED_USER));
    await db.delete(userSettings).where(eq(userSettings.userId, LIFETIME_USER));
    await db.delete(siteSettings).where(eq(siteSettings.id, 1));
    if (before) await db.insert(siteSettings).values(before);
    await db.delete(userSettings).where(eq(userSettings.userId, EARLY_USER));
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));
    if (envBefore === undefined) delete process.env.SITE_STEALTH;
    else process.env.SITE_STEALTH = envBefore;
  }

  console.log("\nStealth's switch, hold rule and invite comp behave.");
});

/**
 * Exercises global surface visibility: the registry's internal consistency, the write path,
 * the admin exemption, and the guard that pages and actions call.
 *
 * SAFETY. `.env.local` sets DATABASE_URL, so despite the "local" feel of a tsx script this
 * writes to the SHARED Neon database — the same one production reads. `app_surface_flags`
 * is global by design, so a leaked row here would hide a real surface from every real user.
 * Everything below therefore snapshots the table first, only ever touches a key that was
 * not already hidden, restores in a `finally`, and asserts the restore actually happened.
 *
 * Run: npx tsx scripts/smoke-surface-visibility.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, appSurfaceFlags } from "../src/db/schema";
import {
  isSurfaceHiddenError,
  requireVisibleSurface,
  setSurfaceHidden,
} from "../src/lib/surface-visibility";
import {
  SURFACES,
  getSurface,
  surfaceForPathname,
  surfaceKeyForHref,
  surfaceKeyForSettingsId,
  surfacesOfKind,
} from "../src/lib/surfaces";
import { SETTINGS_SECTIONS } from "../src/components/settings/sections";

const ADMIN = "smoke-surface-admin";
const USER = "smoke-surface-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Reads the table directly, bypassing the request-scoped `cache()` on the real reader. */
async function hiddenKeysFresh(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .select({ surfaceKey: appSurfaceFlags.surfaceKey })
    .from(appSurfaceFlags);
  return new Set(rows.map((r) => r.surfaceKey));
}

function registryChecks() {
  console.log("\nregistry");

  const keys = SURFACES.map((s) => s.key);
  check("surface keys are unique", new Set(keys).size === keys.length);

  const pages = surfacesOfKind("page");
  check(
    "every page surface declares an href",
    pages.every((s) => Boolean(s.href))
  );
  check(
    "every page href resolves back to its own surface",
    pages.every((s) => surfaceForPathname(s.href as string)?.key === s.key),
    pages
      .filter((s) => surfaceForPathname(s.href as string)?.key !== s.key)
      .map((s) => s.href)
      .join(", ")
  );
  check(
    "every page href maps to its own key for the nav",
    pages.every((s) => surfaceKeyForHref(s.href as string) === s.key)
  );

  // Sub-routes must resolve to their parent page, or hiding Contacts would leave
  // /contacts/<id> wide open.
  check(
    "sub-routes resolve to their parent page",
    surfaceForPathname("/contacts/abc-123")?.key === "page.contacts" &&
      surfaceForPathname("/contacts/new")?.key === "page.contacts" &&
      surfaceForPathname("/outreach/xyz")?.key === "page.outreach"
  );
  check(
    "unclaimed paths resolve to nothing",
    surfaceForPathname("/onboarding") === null &&
      surfaceForPathname("/suspended") === null &&
      surfaceForPathname("") === null
  );
  // /recruiters is folded into the Contacts *tab* by `isNavActive`, but must stay its own
  // flag — otherwise it could never be hidden while Contacts stayed up.
  check(
    "recruiters is governed separately from contacts",
    surfaceForPathname("/recruiters")?.key === "page.recruiters"
  );

  // The settings registry is derived from SETTINGS_SECTIONS; drift in either direction
  // means the admin console and the settings page disagree about what exists.
  const settingsKeys = new Set(surfacesOfKind("settings").map((s) => s.key));
  check(
    "every settings section has a surface",
    SETTINGS_SECTIONS.every((s) => settingsKeys.has(surfaceKeyForSettingsId(s.id))),
    SETTINGS_SECTIONS.filter(
      (s) => !settingsKeys.has(surfaceKeyForSettingsId(s.id))
    )
      .map((s) => s.id)
      .join(", ")
  );
  check(
    "every settings surface has a section",
    surfacesOfKind("settings").every((s) =>
      SETTINGS_SECTIONS.some((sec) => sec.id === s.settingsId)
    )
  );

  // The escape hatches. If any of these ever loses `alwaysVisible`, a single click could
  // lock every user out of their own billing or data export.
  for (const key of [
    "page.dashboard",
    "page.settings",
    "settings.profile",
    "settings.plan",
    "settings.data",
  ]) {
    const surface = getSurface(key);
    check(
      `${key} is always visible`,
      surface?.alwaysVisible === true && Boolean(surface.reason)
    );
  }
}

async function main() {
  registryChecks();

  console.log("\nwrite path");
  const db = await getDb();
  const before = await hiddenKeysFresh();

  // Only ever touch something that is not already hidden, so a real toggle set by hand
  // cannot be clobbered by a test run.
  const target = surfacesOfKind("page").find(
    (s) => !s.alwaysVisible && !before.has(s.key)
  );
  if (!target) {
    throw new Error("No unhidden page surface available to test with.");
  }
  console.log(`  ..  using ${target.key} (was visible before this run)`);

  let wrote = false;
  try {
    await setSurfaceHidden(ADMIN, target.key, true);
    wrote = true;

    check("the flag row is written", (await hiddenKeysFresh()).has(target.key));

    // The guard a page or action calls. A plain user must be refused...
    let refused = false;
    try {
      await requireVisibleSurface(USER, target.key);
    } catch (err) {
      refused = isSurfaceHiddenError(err);
    }
    check("a hidden surface refuses an ordinary user", refused);

    // ...while an always-visible surface is never refused, even in the same breath.
    let dashboardOk = true;
    try {
      await requireVisibleSurface(USER, "page.dashboard");
    } catch {
      dashboardOk = false;
    }
    check("an always-visible surface is never refused", dashboardOk);

    // The admin exemption. ADMIN_USER_IDS is read at call time, not module scope, which is
    // what makes this settable here at all. No request context exists, so `isViewingAsUser`
    // resolves false and the operator is exempt — the normal case.
    const priorAdmins = process.env.ADMIN_USER_IDS;
    const priorClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    process.env.ADMIN_USER_IDS = ADMIN;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke";
    try {
      let adminOk = true;
      try {
        await requireVisibleSurface(ADMIN, target.key);
      } catch {
        adminOk = false;
      }
      check("an operator is exempt from hiding", adminOk);
    } finally {
      if (priorAdmins === undefined) delete process.env.ADMIN_USER_IDS;
      else process.env.ADMIN_USER_IDS = priorAdmins;
      if (priorClerk === undefined) {
        delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = priorClerk;
      }
    }

    // Unhiding is a plain delete, and hiding twice must not raise.
    await setSurfaceHidden(ADMIN, target.key, true);
    check("hiding an already-hidden surface is idempotent", true);
    await setSurfaceHidden(ADMIN, target.key, false);
    wrote = false;
    check("unhiding removes the row", !(await hiddenKeysFresh()).has(target.key));

    // The escape hatches must be refused at the write path too, not merely disabled in the
    // console's UI — the action is reachable by direct POST.
    for (const key of ["page.settings", "settings.plan"]) {
      let rejected = false;
      try {
        await setSurfaceHidden(ADMIN, key, true);
      } catch {
        rejected = true;
      }
      check(`${key} cannot be hidden`, rejected);
    }

    let unknownRejected = false;
    try {
      await setSurfaceHidden(ADMIN, "page.not-a-real-surface", true);
    } catch {
      unknownRejected = true;
    }
    check("an unknown surface key is rejected", unknownRejected);

    console.log("\naudit");
    const entries = await db
      .select({ action: adminAuditLog.action, resourceId: adminAuditLog.resourceId })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.adminUserId, ADMIN));
    check(
      "every toggle wrote an audit row",
      entries.some((e) => e.action === "product.surface.hide") &&
        entries.some((e) => e.action === "product.surface.show"),
      JSON.stringify(entries)
    );
  } finally {
    // Restore exactly. Anything hidden before this ran stays hidden; anything this run
    // added goes, whether the assertions passed or threw.
    if (wrote) {
      await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, target.key));
    }
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));

    const after = await hiddenKeysFresh();
    const leaked = [...after].filter((k) => !before.has(k));
    const lost = [...before].filter((k) => !after.has(k));
    if (leaked.length || lost.length) {
      throw new Error(
        `app_surface_flags was not restored — leaked: [${leaked}], lost: [${lost}]`
      );
    }
    console.log("\n  ok  app_surface_flags restored to its pre-run state");
  }

  console.log("\nAll surface visibility checks passed.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly, for the same
    // reason every sibling script does.
    process.exit(0);
  })
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });

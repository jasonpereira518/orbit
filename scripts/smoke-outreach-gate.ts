/**
 * The generation-2 Outreach release gate fails closed: without OUTREACH_NEXT=on only an admin
 * (not previewing as a user) gets through. A gate that opened on a missing env var would put a
 * half-built feature that sends real email in front of every paying user.
 *
 * Run: npx tsx scripts/smoke-outreach-gate.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { appSurfaceFlags, researchCreditAccounts, userSettings } from "../src/db/schema";
import { isOutreachNextEnabled, outreachNextFlagOn } from "../src/lib/outreach/gate";
import { OUTREACH_ALLOWANCES, OUTREACH_LIMITS } from "../src/lib/outreach/config";
import { loadResearchSettings } from "../src/lib/outreach/settings";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const prior = {
    flag: process.env.OUTREACH_NEXT,
    admins: process.env.ADMIN_USER_IDS,
    clerk: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    monthly: process.env.OUTREACH_CREDITS_PRO_MONTHLY,
  };
  try {
    delete process.env.OUTREACH_NEXT;
    delete process.env.ADMIN_USER_IDS;
    check("flag is off when unset", !outreachNextFlagOn());
    check("an ordinary user is refused", !(await isOutreachNextEnabled("smoke-gate-user")));

    process.env.OUTREACH_NEXT = "yes";
    check("only the exact value 'on' opens the flag", !outreachNextFlagOn());

    process.env.OUTREACH_NEXT = "on";
    check("the flag opens it for everyone", await isOutreachNextEnabled("smoke-gate-user"));

    delete process.env.OUTREACH_NEXT;
    process.env.ADMIN_USER_IDS = "smoke-gate-admin";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke";
    check("an admin gets through without the flag", await isOutreachNextEnabled("smoke-gate-admin"));
    check("a non-admin still does not", !(await isOutreachNextEnabled("smoke-gate-user")));

    check("Pro allowance defaults to 250", OUTREACH_ALLOWANCES.orbitMonthly === 250);
    check("Lifetime allowance defaults to 100", OUTREACH_ALLOWANCES.lifetimeOnce === 100);
    process.env.OUTREACH_CREDITS_PRO_MONTHLY = "300";
    check("allowances are env-configurable", OUTREACH_ALLOWANCES.orbitMonthly === 300);
    process.env.OUTREACH_CREDITS_PRO_MONTHLY = "-5";
    check("a nonsense override falls back", OUTREACH_ALLOWANCES.orbitMonthly === 250);
    check("LinkedIn notes never exceed 300", OUTREACH_LIMITS.linkedinNoteMaxLimit === 300);

    // Settings' research section used to check the gate alone, while every mutation behind it
    // also needs the plan and the Outreach page surface — so a free user inside the gate saw
    // the section, and merely opening Settings created a research-credit account for them.
    console.log("Settings shows research only to someone who could use it...");
    const db = await getDb();
    const FREE = "smoke-gate-settings-free";
    const PAID = "smoke-gate-settings-paid";
    await ensureUserSettings(FREE);
    await ensureUserSettings(PAID);
    await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, PAID));
    delete process.env.ADMIN_USER_IDS;
    process.env.OUTREACH_NEXT = "on";
    const creditAccount = async (userId: string) =>
      (await db.select().from(researchCreditAccounts).where(eq(researchCreditAccounts.userId, userId))).length > 0;
    check("a free user inside the gate sees no research section", (await loadResearchSettings(FREE)).enabled === false);
    check("…and viewing Settings opened no credit account for them", !(await creditAccount(FREE)));
    check("a paid user inside the gate sees it", (await loadResearchSettings(PAID)).enabled === true);
    await db.insert(appSurfaceFlags).values({ surfaceKey: "page.outreach", hiddenBy: "smoke-gate" }).onConflictDoNothing();
    try {
      check("…unless the Outreach page is switched off", (await loadResearchSettings(PAID)).enabled === false);
    } finally {
      await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, "page.outreach"));
    }
    delete process.env.OUTREACH_NEXT;
    check("…and nobody outside the gate sees it", (await loadResearchSettings(PAID)).enabled === false);
  } finally {
    for (const [key, name] of [
      ["flag", "OUTREACH_NEXT"],
      ["admins", "ADMIN_USER_IDS"],
      ["clerk", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
      ["monthly", "OUTREACH_CREDITS_PRO_MONTHLY"],
    ] as const) {
      if (prior[key] === undefined) delete process.env[name];
      else process.env[name] = prior[key];
    }
  }
  console.log("All outreach gate checks passed.");
}

run(main);

/**
 * Renders the Growth tabs (Acquisition, Activation, Retention, Features) — once the Beta, Launch
 * and Retain pages — against seeded data and walks the element tree.
 * They sit behind the admin gate in a browser, so this is the only way to run their loaders and
 * catch a column that does not exist before an operator opens the page.
 *
 * Run: npx tsx scripts/smoke-admin-product-pages.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import AdminAcquisitionPage from "../src/app/(clerk)/(admin)/admin/growth/page";
import AdminActivationPage from "../src/app/(clerk)/(admin)/admin/growth/activation/page";
import AdminRetentionPage from "../src/app/(clerk)/(admin)/admin/growth/retention/page";
import AdminFeaturesPage from "../src/app/(clerk)/(admin)/admin/growth/features/page";
import { GROWTH_TABS } from "../src/components/admin/admin-tabs";
import { ADMIN_NAV } from "../src/components/admin/admin-nav";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (node == null || typeof node === "boolean" || depth > 60) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) textOf(c, out, depth + 1);
    return out;
  }
  if (typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      try {
        const rendered = (el.type as (p: unknown) => unknown)(el.props ?? {});
        if (!(rendered instanceof Promise)) textOf(rendered, out, depth + 1);
      } catch {
        // client components and hooks cannot render here; their props' children are walked below
      }
    }
    if (el.props) for (const v of Object.values(el.props)) textOf(v, out, depth + 1);
  }
  return out;
}

/** Client components that use hooks cannot render outside React; their warnings are noise here. */
async function render(page: () => Promise<unknown>): Promise<string> {
  const original = console.error;
  console.error = () => {};
  try {
    return textOf(await page()).join(" ");
  } finally {
    console.error = original;
  }
}

run(async () => {
  const db = await getDb();
  const U = "smoke-prodpages-user";
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${U}`);
  await db.execute(sql`INSERT INTO user_settings (user_id, email, created_at, signup_utm_source, onboarding_path) VALUES (${U}, 'pp@example.test', now() - interval '10 days', 'reddit', 'capture')`);
  await db.execute(sql`DELETE FROM site_invites WHERE wave_id = 'w97'`);
  await db.execute(sql`INSERT INTO site_invites (email, wave_id, source, accepted_user_id) VALUES ('pp@example.test', 'w97', 'manual', ${U})`);

  const params = { searchParams: Promise.resolve({}) };
  console.log("navigation");
  check("the console links to Growth", ADMIN_NAV.some((n) => n.href === "/admin/growth"));
  for (const href of ["/admin/growth/activation", "/admin/growth/retention", "/admin/growth/features"]) {
    check(`Growth has a ${href} tab`, GROWTH_TABS.some((t) => t.href === href));
  }

  console.log("\nActivation");
  const activation = await render(() => AdminActivationPage(params));
  check("renders the wave table with the seeded wave", activation.includes("Invite waves") && activation.includes("w97"));
  check("shows the first cliff", activation.includes("The first cliff"));
  check("never names the account", !activation.includes("pp@example.test") && !activation.includes(U));

  console.log("\nAcquisition");
  process.env.ANALYTICS_SALT ??= "smoke-prodpages-salt";
  const acquisition = await render(() => AdminAcquisitionPage(params));
  check("renders sign-ups by first touch with the seeded source", acquisition.includes("Sign-ups by first touch") && acquisition.includes("reddit"));

  console.log("\nFeatures");
  const features = await render(() => AdminFeaturesPage(params));
  check("says what zeros mean for new surfaces", features.includes("not measured"));

  console.log("\nRetention");
  const retention = await render(() => AdminRetentionPage(params));
  check("renders retention and pools", retention.includes("Retention by signup month") && retention.includes("Going cold"));
  check("withholds a churn rate under 100 subscribers", retention.includes("withheld below"));

  await db.execute(sql`DELETE FROM site_invites WHERE wave_id = 'w97'`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${U}`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll product-page checks passed.");
});

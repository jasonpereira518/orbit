/**
 * Renders the Beta, Launch and Retain pages against seeded data and walks the element tree.
 * They sit behind the admin gate in a browser, so this is the only way to run their loaders and
 * catch a column that does not exist before an operator opens the page.
 *
 * Run: npx tsx scripts/smoke-admin-product-pages.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import AdminBetaPage from "../src/app/(clerk)/(admin)/admin/beta/page";
import AdminLaunchPage from "../src/app/(clerk)/(admin)/admin/launch/page";
import AdminRetainPage from "../src/app/(clerk)/(admin)/admin/retain/page";
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

  console.log("navigation");
  for (const href of ["/admin/beta", "/admin/launch", "/admin/retain"]) {
    check(`the console links to ${href}`, ADMIN_NAV.some((n) => n.href === href));
  }

  console.log("\nBeta");
  const beta = await render(AdminBetaPage);
  check("renders the wave table with the seeded wave", beta.includes("Invite waves") && beta.includes("w97"));
  check("explains how activation is judged", beta.includes("Activated means"));
  check("shows the first cliff", beta.includes("The first cliff"));
  check("never names the account", !beta.includes("pp@example.test") && !beta.includes(U));

  console.log("\nLaunch");
  const launch = await render(AdminLaunchPage);
  check("renders sign-ups by channel with the seeded source", launch.includes("Sign-ups by channel") && launch.includes("reddit"));
  check("says what zeros mean for new surfaces", launch.includes("not measured"));
  check("renders limits and conversion", launch.includes("Limits hit"));

  console.log("\nRetain");
  const retain = await render(AdminRetainPage);
  check("renders retention and pools", retain.includes("Retention by signup month") && retain.includes("Going cold"));
  check("withholds a churn rate under 100 subscribers", retain.includes("withheld below 100"));
  check("points at the money pages for margin", retain.includes("Costs and margin"));

  await db.execute(sql`DELETE FROM site_invites WHERE wave_id = 'w97'`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${U}`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll product-page checks passed.");
});

/**
 * Invokes the interest-list console page against seeded data.
 *
 * WHY THIS EXISTS. Same reason as `smoke-admin-render.ts`: the console is unreachable in a
 * browser without Clerk keys and an `ADMIN_USER_IDS` entry — `src/proxy.ts` 404s `/admin`
 * outright in demo mode — so there is no local way to click through it. Calling the page
 * function directly runs every loader and builds the whole element tree, which catches the
 * failures that actually happen here: a loader that throws, a column that was never
 * selected, a null dereference in the row mapping.
 *
 * The page is callable because it does not gate itself; the gate lives in
 * `(admin)/layout.tsx` and `scripts/smoke-admin-gate.ts` owns that half.
 *
 * Run: npx tsx scripts/smoke-interest-list-admin.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, userSettings } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";

const PREFIX = "smoke-il-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Flattens a rendered element tree to its visible text, for assertions. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      // Client components render in the browser, so their props are all this walk sees —
      // which is the right server-side contract to assert on anyway.
      // `action` and `subtitle` are walked too: the panel's filter tabs and the header's
      // export link live in those slots, so a walk that only followed `children` would
      // report them missing when they render perfectly well.
      if (
        key === "children" ||
        key === "value" ||
        key === "label" ||
        key === "title" ||
        key === "action" ||
        key === "subtitle" ||
        key === "hint"
      ) {
        textOf(value, out);
      }
    }
  }
  return out;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(userSettings).where(like(userSettings.email, `${PREFIX}%`));
}

async function main() {
  await cleanup();
  const db = await getDb();

  const mk = (email: string, extra: Record<string, unknown> = {}) => ({
    email,
    unsubscribeToken: generateUnsubscribeToken(),
    welcomePlanet: "jupiter",
    ...extra,
  });

  await db.insert(interestListSignups).values([
    mk(`${PREFIX}active@example.test`, {
      utmSource: "reddit",
      utmMedium: "social",
      createdAt: new Date("2026-08-10T09:00:00Z"),
    }),
    mk(`${PREFIX}unsubbed@example.test`, {
      unsubscribedAt: new Date("2026-08-12T09:00:00Z"),
      createdAt: new Date("2026-08-11T09:00:00Z"),
    }),
    mk(`${PREFIX}converted@example.test`, {
      followUpSentAt: new Date("2026-08-14T09:00:00Z"),
      createdAt: new Date("2026-08-13T09:00:00Z"),
    }),
  ]);
  await db.insert(userSettings).values({
    userId: `${PREFIX}user`,
    email: `${PREFIX}converted@example.test`,
  });

  const { default: Page } = await import(
    "../src/app/(admin)/admin/growth/interest-list/page"
  );

  // --- unfiltered
  const all = textOf(await Page({ searchParams: Promise.resolve({}) })).join(" ");
  check("renders every seeded signup", ["active", "unsubbed", "converted"].every((n) => all.includes(`${PREFIX}${n}@example.test`)));
  check("shows an absolute signup date", all.includes("10 Aug 2026"), all.slice(0, 400));
  check("labels the converted row", all.includes("Converted"));
  check("labels the unsubscribed row", all.includes("Unsubscribed"));
  check("surfaces the source from utm", all.includes("reddit · social"));
  check("shows the stored planet", all.toLowerCase().includes("jupiter"));
  check("offers the filter tabs", ["All", "Active", "Converted", "Unsubscribed"].every((f) => all.includes(f)));

  // --- filtered
  const active = textOf(
    await Page({ searchParams: Promise.resolve({ filter: "active" }) })
  ).join(" ");
  check("active filter keeps the active row", active.includes(`${PREFIX}active@example.test`));
  check(
    "active filter drops unsubscribed and converted",
    !active.includes(`${PREFIX}unsubbed@example.test`) &&
      !active.includes(`${PREFIX}converted@example.test`)
  );

  const converted = textOf(
    await Page({ searchParams: Promise.resolve({ filter: "converted" }) })
  ).join(" ");
  check(
    "converted filter isolates the account holder",
    converted.includes(`${PREFIX}converted@example.test`) &&
      !converted.includes(`${PREFIX}active@example.test`)
  );

  // A page far past the end must clamp, not render an empty table that looks like data loss.
  const far = textOf(
    await Page({ searchParams: Promise.resolve({ page: "999" }) })
  ).join(" ");
  check("an out-of-range page still renders rows", far.includes(`${PREFIX}`));

  // A junk page parameter must not throw.
  const junk = textOf(
    await Page({ searchParams: Promise.resolve({ page: "not-a-number", filter: "nonsense" }) })
  ).join(" ");
  check("junk query parameters fall back rather than throwing", junk.includes(`${PREFIX}`));

  await cleanup();
  console.log("\ninterest-list console: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});

/**
 * Invokes the admin roster page against seeded data.
 *
 * WHY THIS EXISTS. The console is unreachable in a browser without Clerk keys and an
 * `ADMIN_USER_IDS` entry — `src/proxy.ts` 404s `/admin` outright in demo mode — so there is
 * no local way to click through it. Calling the page function directly is the next best
 * thing: it runs every loader, builds the whole element tree, and therefore catches the
 * failures that actually happen here (a loader that throws, a column that is not selected,
 * a null dereference in the row mapping).
 *
 * WHAT IT DOES NOT COVER: client components render as elements, not as DOM, so this proves
 * the roster's props are well-formed but not that `CopyId` copies or that `LiveDot` pulses.
 * Those were verified in the browser against the app shell.
 *
 * `AdminUsersPage` is callable here precisely because it does not gate itself — the gate
 * lives in `(admin)/layout.tsx`. `scripts/smoke-admin-gate.ts` owns that half.
 *
 * Run: npx tsx scripts/smoke-admin-render.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { ensureUserSettings, setCompedPlan } from "../src/lib/user-settings";

const PREFIX = "smoke-render-";
const NAMED = `${PREFIX}named`;
const NAMELESS = `${PREFIX}nameless`;
const ALL = [NAMED, NAMELESS];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, ALL));
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

/** Flatten a React element tree to the strings it would render. */
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
      // Client components render in the browser, so their *props* are all this walk can
      // see. That is the right thing to assert on anyway: whether the roster hands
      // `CopyId` the whole id and `CompPlanButton` the resolved plan is exactly the
      // server-side contract, and the browser check covered the rest.
      if (
        key === "children" ||
        key === "value" ||
        key === "userId" ||
        key === "title" ||
        key === "currentPlan" ||
        key === "currentSource"
      ) {
        textOf(value, out);
      }
    }
  }
  return out;
}

async function main() {
  await cleanup();

  const db = await getDb();
  await ensureUserSettings(NAMED);
  await ensureUserSettings(NAMELESS);

  await db
    .update(userSettings)
    .set({
      email: "rosalind.thackeray@example.test",
      firstName: "Rosalind",
      lastName: "Thackeray",
      profileImageUrl: "https://img.clerk.test/rosalind.png",
      // Live right now.
      lastActiveAt: new Date(),
    })
    .where(eq(userSettings.userId, NAMED));

  // The account that predates the identity mirror: no name, no email, no recent activity.
  await db
    .update(userSettings)
    .set({ email: null, lastActiveAt: new Date(Date.now() - 86_400_000) })
    .where(eq(userSettings.userId, NAMELESS));

  await setCompedPlan(NAMED, "lifetime", { note: "render smoke", adminUserId: "op" });
  await db.insert(contacts).values({ userId: NAMED, fullName: "A Contact" });

  const { default: AdminUsersPage } = await import(
    "../src/app/(admin)/admin/users/page"
  );

  const tree = await AdminUsersPage({
    searchParams: Promise.resolve({ q: PREFIX }),
  });
  const text = textOf(tree).join(" | ");

  // The presence dots are painted client-side, so what the server owes them is the
  // `initialLive` set on the provider — that is what makes the first paint correct instead
  // of every row flashing idle until the first poll returns.
  const initialLive = (tree as { props?: { initialLive?: string[] } }).props?.initialLive;

  check("the page renders without throwing", tree != null);
  check("it shows the mirrored full name", text.includes("Rosalind Thackeray"), text);
  check("it shows the email beneath the name", text.includes("rosalind.thackeray@example.test"));
  check("the copyable ID carries the full user id", text.includes(NAMED));
  check("the plan control receives the resolved plan", text.includes("lifetime"), text);
  check(
    "and knows the plan came from a comp, not a payment",
    text.includes("comp"),
    text
  );
  check(
    "the first paint is seeded with the live account",
    Array.isArray(initialLive) && initialLive.includes(NAMED),
    JSON.stringify(initialLive)
  );
  check(
    "and does not claim the idle one is live",
    Array.isArray(initialLive) && !initialLive.includes(NAMELESS)
  );

  // The fallback chain is the part that breaks silently: an account with neither name nor
  // email must render its id, not an empty cell.
  check(
    "an account with no name and no email falls back to its id",
    text.includes(NAMELESS)
  );

  /* ------------------------------------------- filters the new columns introduced */

  const liveOnly = await AdminUsersPage({
    searchParams: Promise.resolve({ q: PREFIX, state: "live" }),
  });
  const liveText = textOf(liveOnly).join(" | ");
  check("the 'active now' filter keeps the live account", liveText.includes("Rosalind"));
  check(
    "the 'active now' filter drops the idle one",
    !liveText.includes(NAMELESS),
    liveText
  );

  // Sorting by Account must not throw on rows where the name is null — the SQL coalesces
  // through name → email → id, and a null in the middle arm is the case that breaks it.
  const sorted = await AdminUsersPage({
    searchParams: Promise.resolve({ q: PREFIX, sort: "email", dir: "asc" }),
  });
  check("sorting by Account survives null names and emails", sorted != null);

  await cleanup();
  console.log("\nAll admin render checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });

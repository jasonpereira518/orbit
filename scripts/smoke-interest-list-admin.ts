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
import "./smoke/_env";

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
  // Plain data handed to a client component (the roster's `rows`) is not a React element
  // and has no `props` — walk its own values instead, or the table's contents are invisible
  // to this check even though they render.
  const el = node as { props?: Record<string, unknown> };
  if (!el.props) {
    if (node instanceof Date) {
      out.push(node.toISOString());
      return out;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      textOf(value, out);
    }
    return out;
  }
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
        key === "hint" ||
        // The table's column headings live in `head`, not in its children.
        key === "head" ||
        // The roster table is now a client component handed a `rows` array, so the walk
        // has to descend into it to see any row at all.
        key === "rows" ||
        key === "createdAtLabel" ||
        key === "source" ||
        key === "status" ||
        key === "planet" ||
        // The row-action controls are a client component, so its props are all this walk
        // can see — which is the right server-side contract to assert on anyway.
        key === "email" ||
        key === "unsubscribed"
      ) {
        textOf(value, out);
      }
    }
  }
  return out;
}

type RowProp = { id: string; email: string; status: string };

/** Finds the `rows` array handed to the client table, wherever it sits in the tree. */
function findRows(node: unknown): RowProp[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(findRows);
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    const candidate = el.props.rows;
    if (
      Array.isArray(candidate) &&
      candidate.every((r) => r && typeof r === "object" && "email" in r && "status" in r)
    ) {
      return candidate as RowProp[];
    }
    return Object.values(el.props).flatMap(findRows);
  }
  return [];
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
  check("renders the signup trend panel", all.includes("Signups by week"));
  check("renders the source rollup panel", all.includes("Where they come from"));
  check("offers a search box", all.includes("Search"));
  check("links to the broadcast composer", all.includes("Broadcasts"));
  check("links to the email preview", all.includes("Preview emails"));
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

  // --- the row contract the removal controls depend on
  //
  // The table and its buttons are a client component now, so the column header and the
  // dialogs render in the browser and are deliberately NOT asserted here — this walk can
  // only see the props crossing the boundary. Those props ARE the thing worth checking:
  // every row must carry its own id, its own address and the right status, because a row
  // wired to its neighbour's values is what deletes the wrong person.
  const tree = await Page({ searchParams: Promise.resolve({}) });
  const rows = findRows(tree);
  check("the table is handed one row per signup", rows.length === 3, `got ${rows.length}`);
  check(
    "every row carries a distinct id and its own address",
    new Set(rows.map((r) => r.id)).size === 3 &&
      new Set(rows.map((r) => r.email)).size === 3
  );
  const statusByEmail = Object.fromEntries(rows.map((r) => [r.email, r.status]));
  check(
    "each row's status matches its data",
    statusByEmail[`${PREFIX}unsubbed@example.test`] === "unsubscribed" &&
      statusByEmail[`${PREFIX}converted@example.test`] === "converted" &&
      statusByEmail[`${PREFIX}active@example.test`] === "active",
    JSON.stringify(statusByEmail)
  );

  // --- correlated-subquery regression
  //
  // With one account among several signups, a broken correlation in the `converted` EXISTS
  // marks EVERY row converted (it collapses to `lower(u.email) = u.email`). That empties the
  // broadcast audience and makes the console lie about the whole list, while still passing
  // any check that only looks at the one genuinely-converted row — so it is asserted by
  // counting, not by spot-checking.
  const summary = await (await import("../src/lib/admin-interest-list")).getInterestListSummary();
  check(
    "exactly one seeded row is converted, not all of them",
    summary.converted === 1,
    `converted=${summary.converted}`
  );
  const audience = await (await import("../src/lib/broadcasts")).audienceFor();
  const audienceEmails = audience.filter((a) => a.email.startsWith(PREFIX)).map((a) => a.email);
  check(
    "the broadcast audience is the mailable subscribers, not zero and not everyone",
    audienceEmails.length === 1 && audienceEmails[0] === `${PREFIX}active@example.test`,
    JSON.stringify(audienceEmails)
  );

  // --- the integration that matters: an admin removal must actually stop the mail.
  const {
    unsubscribeInterestListRow,
  } = await import("../src/lib/admin-interest-list");
  const { sweepInterestListFollowUps } = await import(
    "../src/lib/interest-list-follow-up"
  );
  const target = (
    await db
      .select()
      .from(interestListSignups)
      .where(like(interestListSignups.email, `${PREFIX}active%`))
  )[0];
  // Backdate it past the follow-up delay so it would otherwise be due today.
  await db
    .update(interestListSignups)
    .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
    .where(like(interestListSignups.email, `${PREFIX}active%`));

  const beforeRemoval = await sweepInterestListFollowUps();
  check(
    "a due signup is eligible for the follow-up before removal",
    beforeRemoval.eligible >= 1,
    JSON.stringify(beforeRemoval)
  );
  // The sweep above claimed then released it (no Resend key), so it is still pending.
  await unsubscribeInterestListRow(target.id);
  const afterRemoval = await sweepInterestListFollowUps();
  check(
    "removing them from the console takes them out of the mailer",
    afterRemoval.eligible === 0,
    JSON.stringify(afterRemoval)
  );

  const searched = textOf(
    await Page({ searchParams: Promise.resolve({ q: "unsubbed" }) })
  ).join(" ");
  check(
    "search narrows the table to the match",
    searched.includes(`${PREFIX}unsubbed@example.test`) &&
      !searched.includes(`${PREFIX}active@example.test`)
  );
  const noMatch = textOf(
    await Page({ searchParams: Promise.resolve({ q: "zzz-no-such-address" }) })
  ).join(" ");
  check("a search with no matches says so", noMatch.includes("No signups match"));

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

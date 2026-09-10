/**
 * Invokes the feedback console against seeded data.
 *
 * WHY THIS EXISTS. Same reason as `smoke-interest-list-admin.ts`: the console is unreachable
 * in a browser without Clerk keys and an `ADMIN_USER_IDS` entry — `src/proxy.ts` 404s
 * `/admin` outright in demo mode — so there is no local way to click through it. Calling the
 * page functions directly runs every loader and builds the whole element tree.
 *
 * The load-bearing assertion is the LAST one: no screenshot bytes may appear anywhere in the
 * rendered tree. `loadFeedbackDetail` deliberately does not select `inline_data`, and the
 * gallery renders an API route instead — but that is exactly the property that erodes the
 * first time somebody adds a column to a select, and nothing else would notice.
 *
 * Run: npx tsx scripts/smoke-feedback-admin.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import AdminFeedbackDetailPage from "../src/app/(admin)/admin/feedback/[feedbackId]/page";
import AdminFeedbackPage from "../src/app/(admin)/admin/feedback/page";
import { getDb } from "../src/db";
import { adminAuditLog, feedback, feedbackScreenshots, userSettings } from "../src/db/schema";
import {
  getFeedbackSummary,
  loadFeedbackDetail,
  loadFeedbackList,
  setFeedbackStatus,
  unresolvedFeedbackCount,
} from "../src/lib/admin-feedback";

const USER = "smoke-fb-admin-user";
const ADMIN = "smoke-fb-admin-operator";
/** Seeded into `inline_data` so the deep scan has something unmistakable to hunt for. */
const BYTES_SENTINEL = "SENTINELSCREENSHOTBYTESDONOTLEAK";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Flattens a rendered element tree to its visible text. Mirrors the interest-list walk. */
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
  if (!el.props) {
    if (node instanceof Date) {
      out.push(node.toISOString());
      return out;
    }
    for (const value of Object.values(node as Record<string, unknown>)) textOf(value, out);
    return out;
  }
  for (const [key, value] of Object.entries(el.props)) {
    if (
      key === "children" ||
      key === "value" ||
      key === "label" ||
      key === "title" ||
      key === "action" ||
      key === "subtitle" ||
      key === "hint" ||
      key === "head" ||
      key === "rows" ||
      key === "alt" ||
      key === "src" ||
      key === "status" ||
      key === "id"
    ) {
      textOf(value, out);
    }
  }
  return out;
}

/**
 * Everything in the tree, props included — a stricter net than `textOf`.
 *
 * `textOf` only follows the keys that render, which is right for "does this appear on the
 * page" but wrong for "did these bytes escape into the payload at all". A leak through an
 * unlisted prop is still a leak.
 */
function deepScan(node: unknown, out: string[] = [], seen = new WeakSet<object>()): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof node !== "object") return out;
  // React elements carry back-references (`_owner` and friends), so an unguarded walk
  // recurses until the stack gives out.
  if (seen.has(node)) return out;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) deepScan(child, out, seen);
    return out;
  }
  if (node instanceof Date) return out;
  for (const value of Object.values(node as Record<string, unknown>)) {
    deepScan(value, out, seen);
  }
  return out;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(feedbackScreenshots).where(eq(feedbackScreenshots.userId, USER));
  await db.delete(feedback).where(eq(feedback.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(adminAuditLog).where(like(adminAuditLog.action, "feedback.%"));
}

async function main() {
  console.log("Feedback console\n");
  await cleanup();
  const db = await getDb();

  await db.insert(userSettings).values({ userId: USER, email: "reporter@example.test" });

  const [withShot] = await db
    .insert(feedback)
    .values({
      userId: USER,
      kind: "freeform",
      category: "bug",
      area: "graph",
      text: "the graph goes blank when I filter to one cohort",
      context: { route: "/graph", plan: "free" },
    })
    .returning();

  await db.insert(feedbackScreenshots).values({
    feedbackId: withShot.id,
    userId: USER,
    position: 0,
    note: "blank panel right here",
    storage: "inline",
    inlineData: BYTES_SENTINEL,
    contentType: "image/webp",
    byteSize: BYTES_SENTINEL.length,
  });

  const [resolved] = await db
    .insert(feedback)
    .values({
      userId: USER,
      kind: "freeform",
      category: "idea",
      area: "chat",
      text: "let me pin a thread",
      status: "resolved",
      statusChangedAt: new Date(),
      statusChangedBy: ADMIN,
      resolutionNote: "shipped",
    })
    .returning();

  const summary = await getFeedbackSummary();
  check("summary counts the new entry", summary.new === 1, String(summary.new));
  check("summary counts the resolved one", summary.resolved === 1, String(summary.resolved));
  check("summary counts entries with screenshots", summary.withScreenshots === 1);
  check("unresolved count excludes resolved", (await unresolvedFeedbackCount()) === 1);

  const all = await loadFeedbackList({ page: 1, filter: "all", q: "" });
  check("the list returns both entries", all.total === 2, String(all.total));
  check(
    "each row carries its own screenshot count",
    all.rows.find((r) => r.id === withShot.id)?.screenshotCount === 1 &&
      all.rows.find((r) => r.id === resolved.id)?.screenshotCount === 0
  );
  check("the submitter email is joined in", all.rows[0].submitterEmail === "reporter@example.test");

  const newOnly = await loadFeedbackList({ page: 1, filter: "new", q: "" });
  check("the status filter narrows the list", newOnly.total === 1);

  const searched = await loadFeedbackList({ page: 1, filter: "all", q: "cohort" });
  check("search matches the body text", searched.total === 1 && searched.rows[0].id === withShot.id);

  // An underscore is a LIKE wildcard; unescaped it would match any single character and
  // quietly return rows that do not contain the term at all.
  const wildcard = await loadFeedbackList({ page: 1, filter: "all", q: "grap_" });
  check("a LIKE wildcard in the term is escaped", wildcard.total === 0);

  const overshoot = await loadFeedbackList({ page: 999, filter: "all", q: "" });
  check("?page=999 clamps to the last page", overshoot.page === 1 && overshoot.rows.length === 2);

  const detail = await loadFeedbackDetail(withShot.id);
  check("detail loads", detail !== null);
  check("detail carries the screenshot metadata", detail!.screenshots.length === 1);
  check("detail carries the per-shot note", detail!.screenshots[0].note === "blank panel right here");
  check(
    "detail NEVER selects the bytes",
    !JSON.stringify(detail).includes(BYTES_SENTINEL)
  );
  check(
    "an id that does not exist returns null",
    (await loadFeedbackDetail("00000000-0000-0000-0000-000000000000")) === null
  );

  console.log("");

  const listTree = await AdminFeedbackPage({ searchParams: Promise.resolve({}) });
  const listText = textOf(listTree).join(" ");
  check("the list page renders the excerpt", listText.includes("goes blank when I filter"));
  check("the list page renders the area", listText.includes("graph"));
  check("the list page renders the status", listText.includes("resolved"));

  const detailTree = await AdminFeedbackDetailPage({
    params: Promise.resolve({ feedbackId: withShot.id }),
  });
  const detailText = textOf(detailTree).join(" ");
  check("the detail page renders the full text", detailText.includes("blank when I filter to one cohort"));
  check("the detail page renders the per-shot note", detailText.includes("blank panel right here"));
  check(
    "the gallery points at the serving route, not at bytes",
    detailText.includes("/api/feedback/screenshots/")
  );

  // THE assertion this file exists for.
  const everything = [...deepScan(listTree), ...deepScan(detailTree)].join(" ");
  check(
    "no screenshot bytes appear anywhere in either rendered tree",
    !everything.includes(BYTES_SENTINEL)
  );

  console.log("");

  const moved = await setFeedbackStatus({ id: withShot.id, status: "triaged", adminUserId: ADMIN });
  check("status moves", moved?.from === "new");
  const [after] = await db.select().from(feedback).where(eq(feedback.id, withShot.id));
  check("...and records who and when", after.statusChangedBy === ADMIN && after.statusChangedAt !== null);
  check("the unresolved count still counts triaged", (await unresolvedFeedbackCount()) === 1);

  await setFeedbackStatus({ id: withShot.id, status: "resolved", adminUserId: ADMIN, resolutionNote: "fixed" });
  check("resolving drops the unresolved count", (await unresolvedFeedbackCount()) === 0);

  // Reopening must not erase the note that explains why it was closed.
  await setFeedbackStatus({ id: withShot.id, status: "new", adminUserId: ADMIN });
  const [reopened] = await db.select().from(feedback).where(eq(feedback.id, withShot.id));
  check("reopening keeps the resolution note", reopened.resolutionNote === "fixed");

  check("a status move on a missing id returns null",
    (await setFeedbackStatus({
      id: "00000000-0000-0000-0000-000000000000",
      status: "resolved",
      adminUserId: ADMIN,
    })) === null
  );

  await cleanup();
  console.log("\nAll feedback console checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

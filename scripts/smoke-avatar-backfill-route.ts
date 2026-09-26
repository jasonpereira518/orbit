/**
 * The avatar backfill's route handler: the client loop calls it instead of the Server Action
 * so a batch's external lookups no longer hold the tab's one-at-a-time action queue. It must
 * be the same operation behind a different door — same result, same auth — and, being a
 * cookie-authenticated POST, it must refuse a cross-site Origin the way actions do.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-avatar-backfill-route.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { POST } from "../src/app/api/contacts/avatar-backfill/route";
import { backfillContactAvatars } from "../src/actions/contacts";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const post = (headers: Record<string, string>, body: unknown) =>
  POST(
    new Request("https://orbit.test/api/contacts/avatar-backfill", {
      method: "POST",
      headers: { "content-type": "application/json", host: "orbit.test", ...headers },
      body: JSON.stringify(body),
    })
  );

run(async () => {
  const env = process.env as Record<string, string | undefined>;

  const foreign = await post({ origin: "https://evil.example" }, { skipIds: [] });
  check("a cross-site Origin is refused", foreign.status === 403, String(foreign.status));

  // No session and not a local dev server: `requireUserId()` inside the action throws.
  env.NODE_ENV = "test";
  const signedOut = await post({ origin: "https://orbit.test" }, { skipIds: [] });
  check("an unauthenticated call fails without running the backfill", signedOut.status === 500, String(signedOut.status));

  // Demo mode resolves to demo-user, as the in-app caller would be.
  env.NODE_ENV = "development";
  env.ORBIT_DEMO_DATA = "off";
  // The runner shares one PGlite per shard, and other scripts leave `demo-user` contacts
  // behind. Left in play, the first call would attempt (and stamp as checked) their lookups
  // and the second would find nothing, so the two answers differ by run order alone. Skipping
  // them makes both calls answer from the same state.
  const db = await getDb();
  const leftovers = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, "demo-user"));
  const skipIds = ["00000000-0000-4000-8000-000000000000", ...leftovers.map((c) => c.id)];
  const viaRoute = await post({ origin: "https://orbit.test" }, { skipIds });
  const routeBody = await viaRoute.json();
  const direct = await backfillContactAvatars({ skipIds });
  check("same-origin succeeds", viaRoute.status === 200, String(viaRoute.status));
  check(
    "the route returns exactly what the action returns",
    JSON.stringify(routeBody) === JSON.stringify(direct),
    `${JSON.stringify(routeBody)} vs ${JSON.stringify(direct)}`
  );
  /**
   * The no-body call cannot pass skipIds — that is the whole point of it — so it runs the
   * real backfill over whatever contacts are in the database. Leave the leftovers in place
   * and this check depends on shard order and on the network, which is how it came to fail
   * in CI and pass on every laptop.
   *
   * The failure is not in the route. When the backfill actually saves a photo,
   * `backfillContactAvatars` calls `revalidatePath("/contacts")`, and outside a request
   * that throws `Invariant: static generation store missing` — which the route turns into
   * the 500 this check then reports. In production the route runs inside a real request and
   * revalidatePath is exactly right, so there is nothing to fix there; the test has to stop
   * driving a save.
   *
   * Clearing this user's contacts first makes the call assert what it claims to assert —
   * that a missing body means `skipIds: []` rather than a crash — with nothing to look up,
   * no network, and no revalidate.
   */
  await db.delete(contacts).where(eq(contacts.userId, "demo-user"));
  const noBody = await POST(
    new Request("https://orbit.test/api/contacts/avatar-backfill", { method: "POST", headers: { host: "orbit.test" } })
  );
  check("a missing body means nothing to skip, not an error", noBody.status === 200, String(noBody.status));

  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAvatar backfill route checks passed.");
});

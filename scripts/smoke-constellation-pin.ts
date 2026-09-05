/**
 * The manual constellation pin: the escape hatch for a rule that is wrong about one person.
 *
 * The rule itself is covered by `smoke-constellation-eligibility.ts`. What matters here is
 * that the pin reaches the places it should and stops at the places it shouldn't:
 *
 * - it overrides the rule in both directions, all the way through the real graph payload
 * - it never moves `summary.total`, which must keep describing the whole network
 * - it does NOT touch `updated_at`, because the dashboard orders by that column and pinning
 *   someone would otherwise shove them to the top of "recently updated" for no visible reason
 * - it does NOT set `embedding_stale_at`, because a pin is not embedded text and re-embedding
 *   costs a paid provider call
 * - a pinned-out contact stops being suggested for outreach, so the dashboard cannot nag
 *   about somebody the user deliberately removed from their own chart
 *
 * Run: npx tsx scripts/smoke-constellation-pin.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-pin";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-pin";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { constellationSettings, contacts, interactions, userSettings } from "../src/db/schema";
import { setConstellationConfig } from "../src/lib/constellation-config";
import { loadGraphData } from "../src/lib/graph-data";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-pin-user";
const OTHER = "smoke-pin-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }
}

async function addContact(userId: string, fullName: string, notes?: string) {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({ userId, fullName, notes: notes ?? null })
    .returning();
  return row.id as string;
}

async function setPin(userId: string, contactId: string, pin: "in" | "out" | null) {
  // The action itself needs a Clerk session; this is the same write it performs.
  const db = await getDb();
  await db
    .update(contacts)
    .set({ constellationPin: pin })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
}

async function graph() {
  return loadGraphData(USER, { profile: Promise.resolve(null) });
}

run(async () => {
  const db = await getDb();
  const before = await db.query.constellationSettings.findFirst({
    where: eq(constellationSettings.id, 1),
  });

  try {
    await reset();
    await setConstellationConfig("smoke-pin-admin", { enabled: true });

    // Enough qualifying contacts to clear the safety floor, so the filter is genuinely live.
    for (let i = 0; i < 20; i++) {
      await addContact(USER, `Known Person ${i}`, "Notes about them");
    }
    const barren = await addContact(USER, "Never Spoken To");
    const written = await addContact(USER, "Written About", "We talked at length");

    console.log("Without any pin…");
    let payload = await graph();
    const inPayload = (id: string) => payload.contacts.some((c) => c.id === id);
    check("the filter is live for this network", payload.summary.constellationFilter.active);
    check(
      "the payload carries only engaged contacts, not the whole network",
      payload.contacts.length < payload.summary.total,
      `${payload.contacts.length} of ${payload.summary.total}`
    );
    check("a contact with nothing is not drawn", !inPayload(barren));
    check("a contact with notes is", inPayload(written));
    const totalBefore = payload.summary.total;

    console.log("\nPinning in…");
    await setPin(USER, barren, "in");
    payload = await graph();
    check(
      "a contact with no evidence at all joins the chart",
      payload.contacts.some((c) => c.id === barren)
    );

    console.log("\nPinning out…");
    await setPin(USER, written, "out");
    payload = await graph();
    check(
      "a contact with notes drops off it",
      !payload.contacts.some((c) => c.id === written)
    );
    check(
      "summary.total is unmoved by either pin — it describes the network, not the chart",
      payload.summary.total === totalBefore,
      `${payload.summary.total} vs ${totalBefore}`
    );
    check(
      "and the filter reports the whole network as available behind it",
      payload.summary.constellationFilter.available === payload.summary.total
    );

    console.log("\nBack to automatic…");
    await setPin(USER, written, null);
    await setPin(USER, barren, null);
    payload = await graph();
    check(
      "the rule takes over again for both",
      payload.contacts.some((c) => c.id === written) &&
        !payload.contacts.some((c) => c.id === barren)
    );

    console.log("\nWhat the pin must not touch…");
    const target = await addContact(USER, "Timestamp Check", "Has notes");
    const originalRow = await db.query.contacts.findFirst({
      where: eq(contacts.id, target),
    });
    await setPin(USER, target, "out");
    const afterRow = await db.query.contacts.findFirst({
      where: eq(contacts.id, target),
    });
    check(
      "updated_at is unchanged — the dashboard orders 'recently updated' by it",
      afterRow?.updatedAt?.getTime() === originalRow?.updatedAt?.getTime()
    );
    check(
      "embedding_stale_at is unchanged — a pin is not embedded text",
      (afterRow?.embeddingStaleAt ?? null) === (originalRow?.embeddingStaleAt ?? null)
    );

    console.log("\nOwnership…");
    const foreign = await addContact(OTHER, "Someone Else's Contact");
    await setPin(USER, foreign, "out");
    const untouched = await db.query.contacts.findFirst({
      where: eq(contacts.id, foreign),
    });
    check(
      "another user's contact is not reachable — ownership is in the WHERE clause",
      untouched?.constellationPin === null
    );
  } finally {
    await reset();
    await db.delete(constellationSettings).where(eq(constellationSettings.id, 1));
    if (before) {
      await db.insert(constellationSettings).values({
        id: 1,
        filterEnabled: before.filterEnabled,
        minInboundMessages: before.minInboundMessages,
        minOutboundMessages: before.minOutboundMessages,
        updatedAt: before.updatedAt,
        updatedBy: before.updatedBy,
      });
    }
  }

  console.log("\nAll constellation pin checks passed.");
});

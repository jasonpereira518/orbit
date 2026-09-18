/**
 * Model-derived timeline events are not touches: they do not raise the recency count, do
 * not make someone "met in person", and are not the profile's last touch.
 * Run: npx tsx scripts/smoke-ai-derived-interactions.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-ai-derived";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-ai-derived";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { getClosenessCohort } from "../src/lib/closeness-cohort";
import { AI_DERIVED_SOURCE, isLoggedTouch, latestLoggedTouch } from "../src/lib/interaction-provenance";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-ai-derived-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman" }).returning();
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);
  await db.insert(interactions).values([
    { userId: USER, contactId: c.id, interactionType: "note", source: "capture", interactionDate: day(3), externalId: "smoke-ai-note" },
    { userId: USER, contactId: c.id, interactionType: "linkedin_message", source: "linkedin_messages", direction: "in", interactionDate: day(4), externalId: "smoke-ai-msg" },
    { userId: USER, contactId: c.id, interactionType: "meeting", source: AI_DERIVED_SOURCE, interactionDate: day(1), externalId: `li-event:${c.id}:meeting:a` },
    { userId: USER, contactId: c.id, interactionType: "in_person", source: AI_DERIVED_SOURCE, interactionDate: day(2), externalId: `li-event:${c.id}:in_person:b` },
  ]);

  for (const label of ["fresh cohort", "stored cohort"] as const) {
    console.log(`\n${label}…`);
    const cohort = await getClosenessCohort(USER);
    const signals = cohort.constellationSignals.get(c.id);
    check("recent touches count the note and the message only", cohort.touchCounts.get(c.id) === 2, String(cohort.touchCounts.get(c.id)));
    check("a model-read meeting does not make them met", signals?.meetingInteractions === 0, JSON.stringify(signals));
    check("the message still counts as inbound", signals?.linkedInInbound === 1 && signals?.noteInteractions === 1, JSON.stringify(signals));
    check("they have still interacted", cohort.interactedIds.has(c.id));
  }

  console.log("\nlast touch…");
  const newestFirst = [
    { id: "ai", source: AI_DERIVED_SOURCE },
    { id: "note", source: "capture" },
  ];
  check("the newest real touch, skipping derived rows", latestLoggedTouch(newestFirst)?.id === "note");
  check("null source counts as real", latestLoggedTouch([{ id: "x", source: null }])?.id === "x");
  check("only derived rows means none", latestLoggedTouch([{ id: "ai", source: AI_DERIVED_SOURCE }]) === null);
  check("row check agrees", !isLoggedTouch({ source: AI_DERIVED_SOURCE }) && isLoggedTouch({ source: "linkedin_messages" }));
  // The smoke runner shares one PGlite across scripts.
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
});

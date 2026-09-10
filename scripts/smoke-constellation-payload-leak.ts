/**
 * The default constellation payload must carry NOTHING about the people it isn't drawing.
 *
 * "Filtered" is easy to get almost right: drop the contacts from `contacts` but leave their
 * ids in a cluster's `contactIds`, their employer in the company dropdown, or their tag in
 * the tag list — and the payload still hauls the whole network across the wire while looking
 * filtered. Those leaks are invisible in the UI, so only a test like this catches them.
 *
 * So this asserts the strong form: serialize the whole engaged payload and prove that no
 * non-engaged contact's id or distinguishing strings appear anywhere in it. Scalar counts
 * (`summary.total`, `constellationFilter.available`) are the deliberate exception — the chip
 * has to be able to say "74 of 114" without loading the other 40.
 *
 * Run: npx tsx scripts/smoke-constellation-payload-leak.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-leak";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-leak";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  constellationSettings,
  contacts,
  contactTags,
  interactions,
  tags,
  userSettings,
} from "../src/db/schema";
import { setConstellationConfig } from "../src/lib/constellation-config";
import { loadGraphData } from "../src/lib/graph-data";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-leak-user";
const ENGAGED = 12;
const STRANGERS = 40;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contactTags);
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

run(async () => {
  const db = await getDb();
  const before = await db.query.constellationSettings.findFirst({
    where: eq(constellationSettings.id, 1),
  });

  try {
    await reset();
    await setConstellationConfig("smoke-leak-admin", { enabled: true });

    // Engaged: notes, at a company nobody else works for.
    for (let i = 0; i < ENGAGED; i++) {
      await db.insert(contacts).values({
        userId: USER,
        fullName: `Known Person ${i}`,
        company: "KnownCo",
        notes: "We have spoken at length.",
      });
    }

    // Strangers: no notes, no interactions, no rating, no follow-up, no tags — and every
    // distinguishing string unique to them, so a leak anywhere is detectable by substring.
    const strangerIds: string[] = [];
    for (let i = 0; i < STRANGERS; i++) {
      const [row] = await db
        .insert(contacts)
        .values({
          userId: USER,
          fullName: `Zzstranger Uniquename${i}`,
          company: `StrangerCorp${i}`,
          school: `StrangerSchool${i}`,
          title: `StrangerTitle${i}`,
          email: `stranger${i}@strangerdomain.example`,
        })
        .returning();
      strangerIds.push(row.id as string);
    }

    const engaged = await loadGraphData(USER, { profile: Promise.resolve(null) });
    const json = JSON.stringify(engaged);

    console.log(
      `\n${engaged.summary.total} contacts · ${engaged.contacts.length} drawn · ` +
        `${(json.length / 1024).toFixed(1)} KB payload`
    );

    check(
      "only the engaged contacts are shipped",
      engaged.contacts.length === ENGAGED,
      `${engaged.contacts.length}`
    );
    check(
      "but the network's real size is still reported",
      engaged.summary.total === ENGAGED + STRANGERS
    );

    // The strong assertion: nothing about a stranger survives anywhere in the payload.
    const leakedIds = strangerIds.filter((id) => json.includes(id));
    check("no stranger's id appears anywhere in the payload", leakedIds.length === 0,
      `${leakedIds.length} leaked, e.g. ${leakedIds[0]}`);
    check(
      "no stranger's name, company, school, title or email appears either",
      !json.includes("Zzstranger") &&
        !json.includes("StrangerCorp") &&
        !json.includes("StrangerSchool") &&
        !json.includes("StrangerTitle") &&
        !json.includes("strangerdomain"),
      json.match(/Stranger\w+/)?.[0]
    );
    check(
      "cluster membership lists carry no stranger ids",
      engaged.clusters.every((c) => c.contactIds.every((id) => !strangerIds.includes(id)))
    );
    check(
      "and cluster counts describe what is drawn, not the whole network",
      engaged.clusters.every((c) => c.count === c.contactIds.length)
    );

    // Weight: the strangers outnumber the engaged 40:12, so the saving should be large.
    const all = await loadGraphData(USER, {
      profile: Promise.resolve(null),
      scope: "all",
    });
    const allJson = JSON.stringify(all);
    const saved = 1 - json.length / allJson.length;
    console.log(
      `  engaged ${(json.length / 1024).toFixed(1)} KB · all ` +
        `${(allJson.length / 1024).toFixed(1)} KB — ${(saved * 100).toFixed(0)}% lighter`
    );
    check(
      "the default payload is a fraction of the full one",
      saved > 0.5,
      `${(saved * 100).toFixed(0)}% saved`
    );
    check("and the full scope really does carry everyone", all.contacts.length === ENGAGED + STRANGERS);
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

  console.log("\nAll constellation payload checks passed.");
});

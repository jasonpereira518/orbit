/**
 * Radar's Follow up hooks against a real database (Radar revision PR 3):
 *   - an open thread the person owes, read from `relationship_digests.open_threads`, is a
 *     follow-up quoting that thread; a thread *they* owe is not;
 *   - the latest real encounter 7–21 days ago, with nothing on record since, is a reach-out;
 *     one followed up since is not;
 *   - an action item owed by the other side is not a loop for the person to close.
 * Every card the run writes carries a proof that names its source row.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-follow-up.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, recommendations, relationshipDigests, userSettings } from "../src/db/schema";
import { claimRadarLease, runRadarForUser } from "../src/lib/radar/run";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertInteraction, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("radar-follow-up");
const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    await ensureUserSettings(USER);
    await db.update(userSettings).set({ compedPlan: "orbit", radarEnabledAt: NOW }).where(eq(userSettings.userId, USER));

    // Theo asked for an intro (the person owes it), and separately owes the person a reply.
    const theo = await insertContact(db, USER, 1, { lastInteractionAt: ago(12) });
    const theoMeeting = await insertInteraction(db, USER, theo.id, { interactionType: "meeting", interactionDate: ago(100) });
    await db.insert(relationshipDigests).values({
      contactId: theo.id,
      userId: USER,
      openThreads: [
        { key: "k1", text: "Asked for an intro to someone on the Stripe platform team", owedBy: "me", sinceIso: ago(6).toISOString(), interactionId: theoMeeting!.id, excerpt: "could you intro me to someone at Stripe?" },
        { key: "k2", text: "Said they would send the hiring rubric", owedBy: "them", sinceIso: ago(2).toISOString(), interactionId: theoMeeting!.id, excerpt: "I'll send the rubric" },
      ],
    });

    // Mia: coffee ten days ago and nothing since. Finn: coffee ten days ago, then a message.
    const mia = await insertContact(db, USER, 2, { lastInteractionAt: ago(10) });
    await insertInteraction(db, USER, mia.id, { interactionType: "in_person", interactionDate: ago(10) });
    const finn = await insertContact(db, USER, 3, { lastInteractionAt: ago(3) });
    await insertInteraction(db, USER, finn.id, { interactionType: "in_person", interactionDate: ago(10) });

    // Tom owes the person something; nothing for the person to close.
    const tom = await insertContact(db, USER, 4, { lastInteractionAt: ago(5) });
    const tomNote = await insertInteraction(db, USER, tom.id, { interactionType: "meeting", interactionDate: ago(100) });
    await db.insert(actionItems).values({
      userId: USER,
      contactId: tom.id,
      interactionId: tomNote!.id,
      text: "Tom sends the term sheet",
      itemHash: "smoke-radar-follow-up-tom",
      owedBy: "them",
      createdAt: ago(5),
    });

    await claimRadarLease(USER, NOW);
    const stats = await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });
    t.check("the run succeeds", stats.ok, JSON.stringify(stats));
    t.check("nothing it built was unproven", stats.unproven === 0, String(stats.unproven));

    const cards = await db
      .select({ contactId: recommendations.contactId, kind: recommendations.kind, reasons: recommendations.reasons, evidence: recommendations.evidence })
      .from(recommendations)
      .where(and(eq(recommendations.userId, USER), eq(recommendations.status, "pending")));
    const cardFor = (id: string) => cards.find((c) => c.contactId === id);

    const theoCard = cardFor(theo.id);
    t.check("an open thread the person owes is a follow-up", theoCard?.kind === "follow_up", JSON.stringify(theoCard));
    t.check("quoting the thread they owe, not the one Theo owes", theoCard?.reasons.some((r) => r.code === "open_thread" && r.label.includes("Stripe platform")) === true && !JSON.stringify(theoCard?.reasons).includes("rubric"));
    const theoProof = theoCard?.evidence.find((e) => e.code === "open_thread")?.proof;
    t.check("proven by a quote from the digest row", theoProof?.type === "quote" && theoProof.table === "relationship_digests" && theoProof.id === theo.id, JSON.stringify(theoProof));

    const miaCard = cardFor(mia.id);
    t.check("met ten days ago with nothing since: reach out", miaCard?.kind === "reach_out" && miaCard.reasons.some((r) => r.code === "met_recently"), JSON.stringify(miaCard));
    t.check("proven by the encounter itself", miaCard?.evidence.some((e) => e.code === "met_recently" && e.proof?.type === "record" && e.proof.table === "interactions") === true);
    t.check("followed up since: no card", cardFor(finn.id) === undefined, JSON.stringify(cardFor(finn.id)));
    t.check("an item the other side owes makes no follow-up", cardFor(tom.id)?.kind !== "follow_up", JSON.stringify(cardFor(tom.id)));
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("radar follow-up hooks");
});

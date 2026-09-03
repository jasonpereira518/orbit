/**
 * `resolveUnresolvedMentionForUser`/`dismissUnresolvedMentionForUser` — the lib functions
 * behind `src/actions/unresolved-mentions.ts`'s "use server" wrappers. Exercises the
 * cross-tenant ownership guard (added in a fix round on Task 3) and the idempotent
 * already-resolved/already-dismissed no-op path, neither of which had any coverage before.
 *
 * Writes to the local PGlite file. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-unresolved-mentions-resolve.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-unresolved-mentions";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-unresolved-mentions";
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactionMentions, interactions, noteBatches, unresolvedMentions } from "../src/db/schema";
import { emptyNoteBatchResult } from "../src/lib/note-batches";
import { hashSourceNote, buildSuggestionItemHash } from "../src/lib/suggested-reminder-utils";
import { dismissUnresolvedMentionForUser, resolveUnresolvedMentionForUser } from "../src/lib/unresolved-mentions";

const USER = "smoke-unresolved-mentions-user";
const OTHER_USER = "smoke-unresolved-mentions-other-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER)); // cascades unresolvedMentions
  await db.delete(noteBatches).where(eq(noteBatches.userId, OTHER_USER));
  await db.delete(contacts).where(eq(contacts.userId, USER)); // cascades interactions, interactionMentions
  await db.delete(contacts).where(eq(contacts.userId, OTHER_USER));
}

async function seedPendingMention(sourceText: string, mentionText: string) {
  const db = await getDb();
  const [sarah] = await db.insert(contacts).values({ userId: USER, fullName: "Sarah Chen" }).returning();
  const [interaction] = await db
    .insert(interactions)
    .values({ userId: USER, contactId: sarah.id, rawNotes: sourceText, interactionDate: new Date(2026, 7, 1, 12) })
    .returning();
  const sourceHash = hashSourceNote(sourceText);
  const [batch] = await db
    .insert(noteBatches)
    .values({
      userId: USER,
      sourceHash,
      sourceText,
      entryPoint: "capture",
      anchorDate: new Date(2026, 7, 1, 12),
      anchorBasis: "note",
      status: "saved",
      result: emptyNoteBatchResult(),
    })
    .returning();
  const [mention] = await db
    .insert(unresolvedMentions)
    .values({
      userId: USER,
      noteBatchId: batch.id,
      interactionId: interaction.id,
      nearContactId: sarah.id,
      mentionText,
      context: `chatting with ${mentionText}`,
      sourceHash,
      itemHash: buildSuggestionItemHash(sourceHash, "mention", mentionText),
      status: "pending",
    })
    .returning();
  return { sarah, interaction, batch, mention };
}

async function main() {
  await reset();
  const db = await getDb();

  const { sarah, interaction, mention } = await seedPendingMention("Coffee with Sarah Chen. Raj should join next time.", "Raj");
  const [ownerTarget] = await db.insert(contacts).values({ userId: USER, fullName: "Raj Patel" }).returning();
  const [foreignContact] = await db.insert(contacts).values({ userId: OTHER_USER, fullName: "Someone Else" }).returning();

  // 1. Ownership guard: a contactId belonging to a different user is refused.
  let refused = false;
  try {
    await resolveUnresolvedMentionForUser(USER, mention.id, foreignContact.id);
  } catch {
    refused = true;
  }
  check("resolve refuses a contactId owned by a different user", refused);
  const stillPending = await db.query.unresolvedMentions.findFirst({ where: eq(unresolvedMentions.id, mention.id) });
  check("  the mention row is untouched by the refused attempt", stillPending?.status === "pending");

  // 2. Happy path: the owner's real contact resolves the mention.
  const resolved = await resolveUnresolvedMentionForUser(USER, mention.id, ownerTarget.id);
  check("resolve succeeds for the owner's own contact", resolved.alreadyResolved === false);
  check("  and reports the near-contact for dual-profile revalidation", resolved.nearContactId === sarah.id, String(resolved.nearContactId));
  const afterResolve = await db.query.unresolvedMentions.findFirst({ where: eq(unresolvedMentions.id, mention.id) });
  check("  row is now resolved with resolvedContactId set", afterResolve?.status === "resolved" && afterResolve.resolvedContactId === ownerTarget.id, JSON.stringify(afterResolve));
  const links = await db.query.interactionMentions.findMany({ where: eq(interactionMentions.userId, USER) });
  check("  a matching interactionMentions row now exists", links.length === 1 && links[0].interactionId === interaction.id && links[0].contactId === ownerTarget.id && links[0].matchedBy === "user_pick", JSON.stringify(links));

  // 3. Idempotent re-call: a second resolve on the same (now non-pending) mention is a no-op.
  const secondCall = await resolveUnresolvedMentionForUser(USER, mention.id, ownerTarget.id);
  check("resolving an already-resolved mention returns alreadyResolved", secondCall.alreadyResolved === true);
  const linksAfterSecond = await db.query.interactionMentions.findMany({ where: eq(interactionMentions.userId, USER) });
  check("  and does not insert a second interactionMentions row", linksAfterSecond.length === 1, String(linksAfterSecond.length));

  // 4. Dismiss: a fresh pending row.
  const { mention: mention2 } = await seedPendingMention("Lunch with Sarah Chen again. Dana asked about pricing.", "Dana");
  const dismissed = await dismissUnresolvedMentionForUser(USER, mention2.id);
  check("dismiss succeeds on a fresh pending row", dismissed.alreadyResolved === false);
  const afterDismiss = await db.query.unresolvedMentions.findFirst({ where: eq(unresolvedMentions.id, mention2.id) });
  check("  row is now dismissed", afterDismiss?.status === "dismissed", JSON.stringify(afterDismiss));

  // 5. Idempotent re-call: dismissing an already-dismissed mention is a no-op.
  const secondDismiss = await dismissUnresolvedMentionForUser(USER, mention2.id);
  check("dismissing an already-dismissed mention returns alreadyResolved", secondDismiss.alreadyResolved === true);

  await reset();
  console.log("\nsmoke-unresolved-mentions-resolve: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * The four lookups chat gained so a multi-step question has somewhere to go.
 *
 * `smoke-tool-registry.ts` proves the security boundary — what each surface is allowed to
 * see. This proves the other half: that the answers are right. A tool that returns an empty
 * array passes every check in that file.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-chat-lookup-tools.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions, reminders, userGoals } from "../src/db/schema";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { isToolError, runTool, type OrbitTool } from "../src/lib/tools/registry";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-chat-lookup-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const tool = (name: string) => ORBIT_TOOLS.find((t) => t.name === name) as OrbitTool;
const call = (name: string, args: unknown) =>
  runTool(tool(name), USER, args, { surface: "chat" });

async function main() {
  const db = await getDb();
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);

  const [dana] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Dana Wu",
      company: "Stripe",
      title: "Staff Engineer",
      closenessTier: "inner",
      relationshipScore: 82,
      lastInteractionAt: new Date("2026-09-01T10:00:00Z"),
    })
    .returning();
  const [ravi] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Ravi Patel",
      company: "Stripe",
      title: "Recruiter",
      closenessTier: "outer",
      relationshipScore: 20,
      lastInteractionAt: new Date("2026-03-01T10:00:00Z"),
    })
    .returning();
  await db.insert(contacts).values({
    userId: USER,
    fullName: "Mia Fabre",
    company: "Unrelated Ltd",
    closenessTier: "mid",
  });

  const madeUp = "00000000-0000-4000-8000-000000000000";

  // --- get_timeline --------------------------------------------------------------------

  const dates = ["2026-02-10", "2026-05-20", "2026-08-30"];
  for (const day of dates) {
    await db.insert(interactions).values({
      userId: USER,
      contactId: dana.id,
      interactionType: "meeting",
      aiSummary: `Talked about the ${day} roadmap`,
      rawNotes: `Longer note from ${day}`,
      interactionDate: new Date(`${day}T10:00:00Z`),
    });
  }

  const all = (await call("get_timeline", { contactId: dana.id, limit: 10 })) as {
    total: number;
    name: string;
    entries: Array<{ at: string | null; notes?: string | null }>;
  };
  check("get_timeline returns every entry for the person", all.total === 3 && all.entries.length === 3, JSON.stringify(all.total));
  check("newest first", all.entries[0]?.at?.startsWith("2026-08-30") === true, String(all.entries[0]?.at));
  check("and names the person, so an answer can say who", all.name === "Dana Wu", all.name);

  const capped = (await call("get_timeline", { contactId: dana.id, limit: 2 })) as {
    total: number;
    entries: unknown[];
  };
  check(
    "the total is the real count, not the length of the capped list",
    capped.total === 3 && capped.entries.length === 2,
    `${capped.total} / ${capped.entries.length}`
  );

  const ranged = (await call("get_timeline", {
    contactId: dana.id,
    since: "2026-04-01",
    until: "2026-06-30",
    limit: 10,
  })) as { total: number; entries: Array<{ at: string | null }> };
  check(
    "since/until scope the range, count included",
    ranged.total === 1 && ranged.entries[0]?.at?.startsWith("2026-05-20") === true,
    JSON.stringify(ranged)
  );

  const notMine = await call("get_timeline", { contactId: madeUp, limit: 10 });
  check("a contact that is not the user's is refused, not answered", isToolError(notMine), JSON.stringify(notMine));

  // --- get_goals -----------------------------------------------------------------------

  await db.insert(userGoals).values([
    { userId: USER, text: "Break into climate tech", active: 1 },
    { userId: USER, text: "Find a design co-founder", active: 1 },
    { userId: USER, text: "Something I already did", active: 0 },
  ]);
  const goals = (await call("get_goals", {})) as { goals: string[] };
  check(
    "get_goals returns the active goals",
    goals.goals.length === 2 && goals.goals.includes("Break into climate tech"),
    JSON.stringify(goals)
  );
  check(
    "and leaves the inactive one out",
    !goals.goals.includes("Something I already did"),
    JSON.stringify(goals)
  );

  // --- find_path_to --------------------------------------------------------------------

  const toStripe = (await call("find_path_to", { target: "Stripe", limit: 8 })) as {
    alreadyKnown: unknown[];
    introducers: Array<{ contactId: string; name: string; via: string | null }>;
  };
  check(
    "find_path_to finds the people at the company",
    toStripe.introducers.length === 2,
    JSON.stringify(toStripe.introducers.map((i) => i.name))
  );
  check(
    "ranked by how well the user knows them — inner circle first",
    toStripe.introducers[0]?.contactId === dana.id,
    toStripe.introducers.map((i) => i.name).join(", ")
  );
  check(
    "and says which organisation each one is the way in through",
    toStripe.introducers.every((i) => i.via === "Stripe"),
    JSON.stringify(toStripe.introducers.map((i) => i.via))
  );
  check("nobody is 'already known' when the target is a company", toStripe.alreadyKnown.length === 0);

  const toDana = (await call("find_path_to", { target: "Dana Wu", limit: 8 })) as {
    alreadyKnown: Array<{ contactId: string }>;
    introducers: Array<{ contactId: string }>;
  };
  check(
    "a target who IS a contact comes back as already known",
    toDana.alreadyKnown.some((c) => c.contactId === dana.id),
    JSON.stringify(toDana.alreadyKnown)
  );
  check(
    "and is not also offered as their own introducer",
    !toDana.introducers.some((c) => c.contactId === dana.id),
    JSON.stringify(toDana.introducers)
  );

  const nowhere = (await call("find_path_to", { target: "Zzyzx Holdings", limit: 8 })) as {
    introducers: unknown[];
  };
  check("no path is an empty answer, not an error", Array.isArray(nowhere.introducers) && nowhere.introducers.length === 0);

  // --- list_open_commitments -----------------------------------------------------------

  const [sourceNote] = await db
    .insert(interactions)
    .values({
      userId: USER,
      contactId: dana.id,
      interactionType: "note",
      rawNotes: "Said I would send the deck.",
      interactionDate: new Date("2026-09-02T10:00:00Z"),
    })
    .returning();
  await db.insert(reminders).values([
    { userId: USER, contactId: dana.id, title: "Send Dana the deck", dueDate: new Date("2026-01-05T10:00:00Z") },
    { userId: USER, contactId: ravi.id, title: "Ask Ravi about the role", dueDate: null },
    { userId: USER, contactId: dana.id, title: "Already handled", status: "completed", dueDate: new Date("2026-01-04T10:00:00Z") },
  ]);
  await db.insert(actionItems).values([
    { userId: USER, contactId: dana.id, interactionId: sourceNote.id, text: "Introduce Dana to Mia", status: "open", itemHash: `smoke-open-${Date.now()}` },
    { userId: USER, contactId: ravi.id, interactionId: sourceNote.id, text: "Nothing left to do here", status: "done", itemHash: `smoke-done-${Date.now()}` },
  ]);

  const owed = (await call("list_open_commitments", { limit: 25 })) as Array<{
    kind: string;
    text: string;
    contactId: string;
    sourceId: string | null;
  }>;
  const texts = owed.map((o) => o.text);
  check("an overdue reminder is something the user owes", texts.includes("Send Dana the deck"), JSON.stringify(texts));
  check("so is one with no date at all", texts.includes("Ask Ravi about the role"), JSON.stringify(texts));
  check("and an action item taken from a note", texts.includes("Introduce Dana to Mia"), JSON.stringify(texts));
  check("what is already done is not owed", !texts.includes("Already handled") && !texts.includes("Nothing left to do here"), JSON.stringify(texts));
  check(
    "the overdue one comes first — it is the most owed",
    owed[0]?.text === "Send Dana the deck",
    JSON.stringify(texts)
  );
  check(
    "an action item points back at the note it came from, so an answer can cite it",
    owed.find((o) => o.kind === "action_item")?.sourceId === sourceNote.id,
    JSON.stringify(owed.find((o) => o.kind === "action_item"))
  );

  const danaOnly = (await call("list_open_commitments", { contactId: dana.id, limit: 25 })) as Array<{
    contactId: string;
  }>;
  check(
    "contactId narrows it to one person",
    danaOnly.length > 0 && danaOnly.every((o) => o.contactId === dana.id),
    JSON.stringify(danaOnly.map((o) => o.contactId))
  );

  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-lookup-tool checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

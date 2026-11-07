/**
 * The one-off migration of legacy chat proposals (`scripts/lib/legacy-chat-proposals.ts`, run by
 * `scripts/migrate-legacy-chat-proposals.ts`): every legacy kind becomes its catalog write, a
 * waiting card then commits through the catalog, a done card keeps its link, an unknown kind
 * is left alone, a dry run writes nothing, and a second run finds nothing to do.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-chat-legacy-proposals.ts
 */
import "./smoke/_env";
// `commitProposedAction` goes through `requireUserId()`. With no Clerk keys AND
// NODE_ENV=development, that resolves to demo mode's `demo-user`.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, interactions } from "../src/db/schema";
import type { StoredProposedAction } from "../src/lib/chat-proposed-actions";
import { commitProposedAction } from "../src/actions/chat-actions";
import { migrateLegacyAction, migrateLegacyChatProposals } from "./lib/legacy-chat-proposals";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** A row as the legacy code stored it — a shape the current type no longer describes. */
const legacy = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: randomUUID(), args, preview: `legacy ${String(args.kind)}`, status: "proposed", ...extra }) as unknown as StoredProposedAction;

async function main() {
  const db = await getDb();
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  const [ada] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace" }).returning();
  const reminderId = randomUUID();

  console.log("each legacy kind maps onto its catalog write");
  {
    const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
      [{ kind: "log_interaction", contactId: ada!.id, text: "Coffee" }, "log_note", { contactId: ada!.id, text: "Coffee" }],
      [
        { kind: "create_reminder", contactId: null, title: "Renew", description: null, dueDate: null },
        "create_reminder",
        { title: "Renew" },
      ],
      [{ kind: "schedule_follow_up", contactId: ada!.id, days: 5 }, "schedule_follow_up", { contactId: ada!.id, days: 5 }],
      [
        { kind: "update_contact", contactId: ada!.id, fields: { title: "Countess", howMet: "Babbage" } },
        "update_contact",
        { contactId: ada!.id, title: "Countess", how_met: "Babbage" },
      ],
      [
        { kind: "create_contact", fullName: "Grace Hopper", fields: { company: "Navy" } },
        "create_contact",
        { full_name: "Grace Hopper", company: "Navy" },
      ],
      [{ kind: "complete_reminder", reminderId }, "complete_reminder", { reminderId }],
      [{ kind: "snooze_reminder", reminderId, days: 3 }, "snooze_reminder", { reminderId, days: 3 }],
    ];
    for (const [args, tool, input] of cases) {
      const out = migrateLegacyAction(legacy(args));
      check(
        `${String(args.kind)} → ${tool}`,
        out?.args.tool === tool && JSON.stringify(out.args.input) === JSON.stringify(input) && out.args.kind === "tool",
        JSON.stringify(out?.args)
      );
    }
    const kept = migrateLegacyAction(legacy({ kind: "update_contact", contactId: ada!.id, fields: { title: "x" } }));
    check("the card keeps its preview, gains its tier and contact", kept?.preview === "legacy update_contact" && kept.tier === "confirm" && kept.contactId === ada!.id);
    const tool = { id: randomUUID(), args: { kind: "tool", tool: "log_note", input: {} }, preview: "x", status: "proposed" } as StoredProposedAction;
    check("a catalog proposal is returned as it is", migrateLegacyAction(tool) === tool);
    check("an unknown legacy kind is not converted", migrateLegacyAction(legacy({ kind: "send_email" })) === null);
  }

  console.log("the migration over stored rows");
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const waiting = legacy({ kind: "log_interaction", contactId: ada!.id, text: "Talked about the engine" });
  const doneUpdate = legacy({ kind: "update_contact", contactId: ada!.id, fields: { company: "Analytical" } }, { status: "done", resultId: ada!.id });
  const unknown = legacy({ kind: "send_email", to: "x@example.com" }, { status: "dismissed" });
  const [msg] = await db
    .insert(chatMessages)
    .values({ threadId: thread!.id, userId: USER, role: "assistant", content: "x", proposedActions: [waiting, doneUpdate, unknown] })
    .returning();
  const read = async () => (await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, msg!.id) }))?.proposedActions ?? [];

  const dry = await migrateLegacyChatProposals({ dry: true });
  check("a dry run counts the row", dry.messagesRewritten === 1 && dry.proposalsConverted === 2 && dry.unknown === 1, JSON.stringify(dry));
  check("…and writes nothing", (await read())[0]?.args.kind !== "tool");

  const run = await migrateLegacyChatProposals();
  check("the run rewrites the row", run.messagesRewritten === 1 && run.proposalsConverted === 2 && run.conflicts === 0, JSON.stringify(run));
  const [w, d, u] = await read();
  check("the waiting card is a catalog proposal now, still waiting", w?.args.tool === "log_note" && w.status === "proposed" && w.id === waiting.id);
  check("the done card keeps its status, result and View link, with no Undo", d?.status === "done" && d.resultId === ada!.id && d.href === `/contacts/${ada!.id}` && d.undo === null, JSON.stringify(d));
  // jsonb does not keep key order, so this compares the fields rather than the serialisation.
  const unknownArgs = u?.args as unknown as { kind?: string; to?: string } | undefined;
  check(
    "the unknown kind is left as it was",
    u?.id === unknown.id && u.status === "dismissed" && unknownArgs?.kind === "send_email" && unknownArgs.to === "x@example.com" && u.tier === undefined,
    JSON.stringify(u)
  );

  const again = await migrateLegacyChatProposals();
  check("a second run rewrites nothing", again.messagesRewritten === 0 && again.proposalsConverted === 0, JSON.stringify(again));

  console.log("a migrated card commits through the catalog");
  const res = await commitProposedAction(msg!.id, waiting.id);
  check("it commits", res.ok === true, JSON.stringify(res));
  const note = await db.query.interactions.findFirst({ where: eq(interactions.contactId, ada!.id) });
  check("the note is on Ada's timeline, keyed to the card", note?.rawNotes === "Talked about the engine" && note.externalId === `chat:${msg!.id}:${waiting.id}`, JSON.stringify(note && { notes: note.rawNotes, ext: note.externalId }));
  const settled = (await read())[0];
  check("the card is done, with the catalog's Undo", settled?.status === "done" && settled.undo?.tool === "delete_interaction", JSON.stringify(settled));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll legacy proposal migration checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

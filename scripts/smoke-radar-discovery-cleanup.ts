/**
 * The one-off cleanup for contacts Radar's removed arXiv/GitHub discovery inserted
 * (`scripts/cleanup-radar-discovery-contacts.ts`): it finds only the two shapes discovery
 * wrote, deletes only untouched ones, and discovery itself is gone from the run.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, reminders } from "../src/db/schema";
import { deleteDiscoveryContacts, findDiscoveryContacts } from "./cleanup-radar-discovery-contacts";
import { checker } from "./smoke/check";

const t = checker();

run(async () => {
  t.check("the discovery module is deleted", !existsSync("src/lib/radar/signals/discovery.ts"));
  t.check("and the run no longer calls it", !/discoverNewPeople/.test(readFileSync("src/lib/radar/run.ts", "utf8")));

  const db = await getDb();
  const USER = `smoke-radar-discovery-${randomUUID()}`;
  const since = new Date(Date.now() - 60_000);
  const add = async (over: Partial<typeof contacts.$inferInsert>) => {
    const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Someone", ...over }).returning();
    return c!.id;
  };
  const arxiv = await add({ fullName: "Ada Paper", title: "Researcher · Scaling laws for agents", company: "Academic / Research", website: "https://arxiv.org/abs/1" });
  const github = await add({ fullName: "octocat", title: "Builder · octocat/agent-harness", website: "https://github.com/octocat/agent-harness" });
  const reminded = await add({ fullName: "Kept Researcher", title: "Researcher · Kept", company: "Academic / Research", website: "https://arxiv.org/abs/2" });
  await db.insert(reminders).values({ userId: USER, contactId: reminded, title: "Follow up", dueDate: new Date() });
  const emailed = await add({ fullName: "Mailed Builder", title: "Builder · x/y", website: "https://github.com/x/y", email: "b@example.com" });
  const realPerson = await add({ fullName: "Real Builder", title: "Builder · at Acme", company: "Acme", website: "https://acme.com", source: "manual" });
  const lookalike = await add({ fullName: "No Site", title: "Researcher · Thing", company: "Academic / Research" });

  const matches = (await findDiscoveryContacts(since)).filter((m) => m.userId === USER);
  const byId = new Map(matches.map((m) => [m.id, m]));
  t.check("finds the four discovery-shaped rows", matches.length === 4 && [arxiv, github, reminded, emailed].every((id) => byId.has(id)), `${matches.length}`);
  t.check("never a contact with a source, a company, or no website", !byId.has(realPerson) && !byId.has(lookalike));
  t.check("untouched arXiv and GitHub rows are deletable", byId.get(arxiv)?.deletable === true && byId.get(github)?.deletable === true);
  t.check("one with a reminder is kept", byId.get(reminded)?.deletable === false && byId.get(reminded)!.keepReasons.includes("reminders"));
  t.check("one the user gave an email is kept", byId.get(emailed)?.deletable === false && byId.get(emailed)!.keepReasons.includes("email"));

  const deleted = await deleteDiscoveryContacts(matches);
  const left = new Set((await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, USER))).map((r) => r.id));
  t.check(
    "--apply deletes only the untouched two",
    deleted.length === 2 && !left.has(arxiv) && !left.has(github) && [reminded, emailed, realPerson, lookalike].every((id) => left.has(id)),
    `${deleted.length} deleted`
  );

  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  t.done("radar discovery cleanup smoke");
});

/**
 * The handle-name sweep (`src/lib/contact-name-sweep.ts`) against a throwaway PGlite: renames,
 * what it stores, that it looks at a contact once, that a person's edit settles a guess, that
 * it stays inside one account, and that the model cap holds.
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { isHandle } from "../src/lib/contact-name-guess";
import { NAME_SWEEP_AI_CAP, runNameSweep, type NameSweepDeps } from "../src/lib/contact-name-sweep";
import { updateContactForUser } from "../src/lib/contact-writes";
import { checker } from "./smoke/check";

const t = checker();
const USER = `smoke-names-${randomUUID()}`;
const OTHER = `smoke-names-other-${randomUUID()}`;

async function main() {
  const db = await getDb();
  const add = (userId: string, fullName: string, email: string | null) =>
    db
      .insert(contacts)
      .values({ userId, fullName, email })
      .returning()
      .then((r) => r[0]!.id);

  const ids = {
    doe: await add(USER, "john.doe", "john.doe@x.com"),
    book: await add(USER, "jsmith42", "jsmith42@acme.com"),
    ai: await add(USER, "jdoe_dev", "jdoe_dev@x.com"),
    none: await add(USER, "zq9", "zq9@x.com"),
    real: await add(USER, "Priya Raman", "priya@x.com"),
    other: await add(OTHER, "john.doe", "john.doe@x.com"),
  };

  let aiCalls = 0;
  const deps: Partial<NameSweepDeps> = {
    providerIndex: async () => new Map([["jsmith42@acme.com", { first: "Jane", last: "Smithers", full: "Jane Smithers" }]]),
    askAi: async (_u, c) => {
      aiCalls++;
      return c.fullName === "jdoe_dev" ? { first: "Jordan", last: "Doe", full: "Jordan Doe" } : null;
    },
  };

  const stats = await runNameSweep(USER, { deps });
  const row = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0]!;

  const doe = await row(ids.doe);
  t.check("john.doe → John Doe, settled", doe.fullName === "John Doe" && doe.firstName === "John" && doe.lastName === "Doe" && doe.nameGuess?.weak === false && doe.nameGuess.from === "john.doe", JSON.stringify(doe.nameGuess));
  const book = await row(ids.book);
  t.check("address book name applied", book.fullName === "Jane Smithers" && book.nameGuess?.source === "address_book" && !book.nameGuess.weak);
  const ai = await row(ids.ai);
  t.check("model guess applied, weak", ai.fullName === "Jordan Doe" && ai.nameGuess?.source === "ai" && ai.nameGuess.weak === true);
  const none = await row(ids.none);
  t.check("no guess keeps the handle, weak, source none", none.fullName === "zq9" && none.nameGuess?.source === "none" && none.nameGuess.weak === true);
  const real = await row(ids.real);
  t.check("a real name is never touched", real.fullName === "Priya Raman" && real.nameGuess === null);
  const other = await row(ids.other);
  t.check("another account's contacts are untouched", other.fullName === "john.doe" && other.nameGuess === null);
  t.check("stats add up", stats.checked === 4 && stats.renamed === 3 && stats.weak === 1 && stats.none === 1, JSON.stringify(stats));
  t.check("the model was asked only for what nothing else read", aiCalls === 2, `asked ${aiCalls}`);

  const again = await runNameSweep(USER, { deps });
  t.check("a second pass is a no-op", again.checked === 0 && aiCalls === 2, JSON.stringify(again));

  // A person (or a better source) renaming the contact settles the guess.
  await updateContactForUser(USER, ids.ai, { fullName: "Jordan Doe-Ray" }, { skipRevalidate: true, skipSummary: true, skipCloseness: true, skipEmbedding: true });
  t.check("a name edit clears weak", (await row(ids.ai)).nameGuess?.weak === false);
  await updateContactForUser(USER, ids.none, { fullName: "zq9", title: "CTO" }, { skipRevalidate: true, skipSummary: true, skipCloseness: true, skipEmbedding: true });
  t.check("saving the same name leaves the guess open", (await row(ids.none)).nameGuess?.weak === true);

  // The SQL prefilter and `isHandle` agree.
  const probe = ["a.b", "x_y", "abc123", "", "me@x.com", "Ann Lee", "Cher", "Anne-Marie"];
  const probeUser = `smoke-names-probe-${randomUUID()}`;
  for (const n of probe) await add(probeUser, n, null);
  const probeStats = await runNameSweep(probeUser, { deps: { providerIndex: async () => new Map(), askAi: async () => null } });
  t.check("SQL candidates match isHandle", probeStats.checked === probe.filter((n) => isHandle(n)).length, JSON.stringify(probeStats));

  // The model cap: more unreadable handles than calls, and the rest wait for the next pass.
  const capUser = `smoke-names-cap-${randomUUID()}`;
  for (let i = 0; i < NAME_SWEEP_AI_CAP + 5; i++) await add(capUser, `zz${i}x`, null);
  let capCalls = 0;
  const capStats = await runNameSweep(capUser, { deps: { providerIndex: async () => new Map(), askAi: async () => (capCalls++, null) } });
  t.check("model calls stop at the cap", capCalls === NAME_SWEEP_AI_CAP, `called ${capCalls}`);
  t.check("the rest are left for the next pass", capStats.checked === NAME_SWEEP_AI_CAP && capStats.more, JSON.stringify(capStats));

  for (const u of [USER, OTHER, probeUser, capUser]) await db.delete(contacts).where(eq(contacts.userId, u));
  t.done("contact name sweep smoke tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

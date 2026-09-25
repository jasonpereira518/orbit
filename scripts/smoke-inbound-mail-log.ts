import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import {
  clearInboundLogToken,
  hashInboundLogToken,
  logInboundMail,
  mintInboundLogToken,
  userForInboundToken,
  type InboundMessage,
} from "../src/lib/connectors/inbound-mail";

/**
 * The BCC address end to end: mint, resolve, log, and — the one that matters — do it twice.
 *
 * A person BCCs a thread and later forwards the same message, or their client retries. The
 * Message-ID is the only thing that makes those one interaction instead of three, so the
 * re-send check is the reason this script exists.
 */
const USER = "inbound-mail-user";
const DOMAIN = "inbound.orbit.example";
const SELF = "jason@example.com";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const MESSAGE: InboundMessage = {
  messageId: "unique-msg-1@mail.example.com",
  sentAt: new Date("2026-03-10T15:00:00Z"),
  from: { email: SELF, name: "Jason" },
  to: [{ email: "ada@example.com", name: "Ada Lovelace" }],
  cc: [],
  subject: "Following up",
  snippet: "Good to meet you",
};

run(async () => {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER });

  console.log("minting");
  const token = await mintInboundLogToken(USER);
  check("a token comes back", token.length > 0);
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, USER));
  check("the column holds the HASH, never the token", row?.inboundLogToken === hashInboundLogToken(token));
  check("the plaintext is nowhere in the row", JSON.stringify(row).includes(token) === false);
  check("it resolves back to the user", (await userForInboundToken(token)) === USER);
  check("an unknown token resolves to nobody", (await userForInboundToken("not-a-token")) === null);

  console.log("\nlogging a message");
  const first = await logInboundMail(MESSAGE, { token, domain: DOMAIN, self: [SELF] });
  check("it logged", first.ok === true, JSON.stringify(first));
  check("one interaction", first.ok && first.interactionsLogged === 1, JSON.stringify(first));
  check("the counterparty became a contact", first.ok && first.contactsCreated === 1);

  const people = await db.select().from(contacts).where(eq(contacts.userId, USER));
  check("the contact is Ada, not the user", people.length === 1 && people[0].email === "ada@example.com", JSON.stringify(people.map((p) => p.email ?? "")));

  const logged = await db.select().from(interactions).where(eq(interactions.userId, USER));
  check("the interaction is an email", logged[0]?.interactionType === "email", String(logged[0]?.interactionType));
  check("its source names the connector", logged[0]?.source === "inbound_mail", String(logged[0]?.source));

  console.log("\nthe same message again is not a second interaction");
  const second = await logInboundMail(MESSAGE, { token, domain: DOMAIN, self: [SELF] });
  check("the re-send is accepted", second.ok === true);
  const after = await db.select().from(interactions).where(eq(interactions.userId, USER));
  check("still exactly one interaction", after.length === 1, String(after.length));
  const stillPeople = await db.select().from(contacts).where(eq(contacts.userId, USER));
  check("still exactly one contact", stillPeople.length === 1, String(stillPeople.length));

  console.log("\nrefusals");
  const unknown = await logInboundMail(MESSAGE, { token: "nobody", domain: DOMAIN, self: [SELF] });
  check("an unknown token is refused", !unknown.ok && unknown.reason === "unknown-token");
  const selfOnly = await logInboundMail(
    { ...MESSAGE, messageId: "m2@x", to: [{ email: SELF }] },
    { token, domain: DOMAIN, self: [SELF] }
  );
  check("a note to self is refused", !selfOnly.ok && selfOnly.reason === "not-loggable");

  console.log("\nrotation");
  const rotated = await mintInboundLogToken(USER);
  check("a new token is different", rotated !== token);
  check("the old token stops resolving", (await userForInboundToken(token)) === null);
  check("the new token resolves", (await userForInboundToken(rotated)) === USER);
  await clearInboundLogToken(USER);
  check("clearing stops the address entirely", (await userForInboundToken(rotated)) === null);

  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll inbound mail log checks passed.");
});

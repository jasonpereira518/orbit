/**
 * The BCC logging address's parsing rules.
 *
 * Pure tier: every function here is a pure mapping, so none of it needs a database. The
 * properties worth pinning are the ones that decide WHO an email is about — getting those
 * wrong writes a stranger into someone's network, or writes the user in as their own contact.
 */
import {
  counterpartsOf,
  hashInboundLogToken,
  inboundLogAddress,
  toNetworkEvent,
  tokenFromRecipients,
  type InboundMessage,
} from "../src/lib/connectors/inbound-mail";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const DOMAIN = "inbound.orbit.example";
const SELF = "jason@example.com";
const LOG = inboundLogAddress("tok123", DOMAIN);

const BASE: InboundMessage = {
  messageId: "CAF=abc123@mail.example.com",
  sentAt: new Date("2026-03-10T15:00:00Z"),
  from: { email: SELF, name: "Jason" },
  to: [{ email: "ada@example.com", name: "Ada Lovelace" }],
  cc: [],
  subject: "Following up on the role",
  snippet: "Great speaking today —",
};

console.log("the address and its token");
check("the address has the log- prefix", LOG === `log-tok123@${DOMAIN}`, LOG);
check("the token is recovered from an envelope recipient", tokenFromRecipients([LOG], DOMAIN) === "tok123");
check(
  "the token is recovered when the address sits among others",
  tokenFromRecipients(["ada@example.com", { email: LOG }], DOMAIN) === "tok123"
);
check("case does not matter", tokenFromRecipients([LOG.toUpperCase()], DOMAIN) === "tok123");
check("another domain is refused", tokenFromRecipients(["log-tok123@evil.example"], DOMAIN) === null);
check("a non-log address on our domain is refused", tokenFromRecipients([`hello@${DOMAIN}`], DOMAIN) === null);
check("an empty token is refused", tokenFromRecipients([`log-@${DOMAIN}`], DOMAIN) === null);
check("the stored value is a hash, not the token", hashInboundLogToken("tok123") !== "tok123");
check("hashing is stable", hashInboundLogToken("tok123") === hashInboundLogToken("tok123"));

console.log("\nwho the message is with");
{
  const people = counterpartsOf(BASE, { self: [SELF], domain: DOMAIN });
  check("the counterparty is found", people.length === 1 && people[0].email === "ada@example.com");
  check("their name is carried", people[0]?.name === "Ada Lovelace");
}
{
  const people = counterpartsOf(
    { ...BASE, to: [{ email: "ada@example.com" }, { email: LOG }], cc: [{ email: SELF }] },
    { self: [SELF], domain: DOMAIN }
  );
  check("the log address is never a contact", !people.some((p) => (p.email ?? "").includes("log-")), JSON.stringify(people));
  check("the user is never their own contact", !people.some((p) => p.email === SELF));
  check("only the real counterparty remains", people.length === 1, JSON.stringify(people));
}
{
  const people = counterpartsOf(
    { ...BASE, to: [{ email: "Ada@example.com" }], cc: [{ email: "ada@example.com" }] },
    { self: [SELF], domain: DOMAIN }
  );
  check("the same person in To and Cc collapses to one", people.length === 1, JSON.stringify(people));
}
{
  const people = counterpartsOf(
    { ...BASE, from: { email: "grace@example.com" }, to: [{ email: SELF }] },
    { self: [SELF], domain: DOMAIN }
  );
  check("a received message counts its sender", people.length === 1 && people[0].email === "grace@example.com");
}

console.log("\nwhat becomes an interaction");
{
  const event = toNetworkEvent(BASE, { self: [SELF], domain: DOMAIN, receivedAt: new Date() });
  check("an ordinary message logs", event !== null);
  check("it is keyed on the Message-ID", event?.externalIdBase === `mail:${BASE.messageId}`, String(event?.externalIdBase));
  check("it is an email", event?.type === "email");
  check("the subject becomes the summary", event?.summary === "Following up on the role");
  check("the sent time wins over receipt", event?.timestamp.toISOString() === "2026-03-10T15:00:00.000Z");
}
{
  const received = new Date("2026-05-01T00:00:00Z");
  const event = toNetworkEvent({ ...BASE, sentAt: null }, { self: [SELF], domain: DOMAIN, receivedAt: received });
  check("a missing date falls back to receipt", event?.timestamp.toISOString() === received.toISOString());
}
{
  const event = toNetworkEvent({ ...BASE, messageId: null }, { self: [SELF], domain: DOMAIN, receivedAt: new Date() });
  check("no Message-ID means no log (it could not be deduped)", event === null);
}
{
  const event = toNetworkEvent(
    { ...BASE, to: [{ email: LOG }] },
    { self: [SELF], domain: DOMAIN, receivedAt: new Date() }
  );
  check("a note to self logs nothing", event === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll inbound mail checks passed.");
process.exit(0);

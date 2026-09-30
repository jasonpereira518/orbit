/**
 * The outbox's MIME builder: multi-recipient headers, Bcc kept out of the shared message,
 * HTML alternative, fixed Message-ID, and no header smuggling.
 * Run: npx tsx scripts/smoke-email-mime.ts
 */
import { buildMime, newRfcMessageId, withBccHeader } from "../src/lib/email/mime";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const base = {
  from: { name: "Jason P", email: "me@x.org" },
  to: ["a@x.org", "b@x.org"],
  cc: ["c@x.org"],
  bcc: ["hidden@x.org"],
  subject: "Café plans",
  bodyText: "Hi there",
  bodyHtml: null,
  messageId: "<fixed-id@orbit.mail>",
};

const plain = buildMime(base);
const [head, body] = plain.split("\r\n\r\n");
check("To lists every address", /^To: a@x\.org, b@x\.org$/m.test(head!), head);
check("Cc present", /^Cc: c@x\.org$/m.test(head!));
check("Bcc is not written by buildMime", !/hidden@x\.org/.test(plain));
check("Message-ID is the fixed id", /^Message-ID: <fixed-id@orbit\.mail>$/m.test(head!));
check("non-ascii subject is an encoded-word", /^Subject: =\?UTF-8\?B\?/m.test(head!));
check("From carries the display name", /^From: "Jason P" <me@x\.org>$/m.test(head!));
check("plain body follows the blank line", body === "Hi there");

const html = buildMime({ ...base, bodyHtml: "<p>Hi <b>there</b></p>" }, "BOUNDARY");
check("html uses multipart/alternative", /^Content-Type: multipart\/alternative; boundary="BOUNDARY"$/m.test(html));
check("text part precedes html part", html.indexOf("text/plain") < html.indexOf("text/html"));
check("closing boundary present", html.includes("--BOUNDARY--"));

const inj = buildMime({ ...base, subject: "Hi\r\nBcc: evil@x.org" });
check("subject CR/LF cannot start a header", !/^Bcc:/m.test(inj));

const reply = buildMime({ ...base, inReplyTo: "<orig@x.org>", references: "<root@x.org> <orig@x.org>" });
check("In-Reply-To set", /^In-Reply-To: <orig@x\.org>$/m.test(reply));
check("References carries the chain", /^References: <root@x\.org> <orig@x\.org>$/m.test(reply));

const id = newRfcMessageId();
check(
  "generated ids are angle-bracketed and unique",
  /^<[0-9a-f-]{36}@orbit\.mail>$/.test(id) && id !== newRfcMessageId(),
  id
);

const gmailRaw = withBccHeader(plain, ["hidden@x.org"]);
const gmailHead = gmailRaw.split("\r\n\r\n")[0]!;
check("Gmail variant carries Bcc in the header block", /^Bcc: hidden@x\.org$/m.test(gmailHead));
check("Gmail variant body unchanged", gmailRaw.split("\r\n\r\n")[1] === "Hi there");
check("no Bcc list, no Bcc header", withBccHeader(plain, []) === plain);

console.log("\nAll MIME checks passed.");

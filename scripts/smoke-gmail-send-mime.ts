/**
 * Exercises the outbound MIME builder — specifically the From header, which decides
 * what a recruiter sees.
 *
 * No network. Sending itself needs real OAuth; this covers everything up to the wire.
 *
 * Run: npx tsx scripts/smoke-gmail-send-mime.ts
 */
import { buildMimeMessage, formatAddress } from "../src/lib/gmail-send";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

console.log("\naddress formatting");
check(
  "bare address when no display name",
  formatAddress(null, "jason@example.com") === "jason@example.com",
  formatAddress(null, "jason@example.com")
);
check(
  "ascii display names are quoted",
  formatAddress("Jason Pereira", "jason@example.com") ===
    '"Jason Pereira" <jason@example.com>',
  formatAddress("Jason Pereira", "jason@example.com")
);
check(
  "a comma in the name cannot split the header",
  formatAddress("Pereira, Jason", "jason@example.com") ===
    '"Pereira, Jason" <jason@example.com>'
);
check(
  "embedded quotes are escaped, not left to terminate the string",
  formatAddress('Jason "JP" Pereira', "jason@example.com") ===
    '"Jason \\"JP\\" Pereira" <jason@example.com>',
  formatAddress('Jason "JP" Pereira', "jason@example.com")
);

const nonAscii = formatAddress("José Álvarez", "jose@example.com");
check(
  "non-ascii names use an encoded-word",
  nonAscii.startsWith("=?UTF-8?B?") && nonAscii.endsWith("<jose@example.com>"),
  nonAscii
);
check(
  "an encoded-word is not wrapped in quotes",
  !nonAscii.includes('"'),
  nonAscii
);

console.log("\nMIME message");
const mime = buildMimeMessage({
  to: "sarah.chen@stripe.test",
  from: { name: "Jason Pereira", email: "jason@example.com" },
  subject: "Backend role — following up",
  body: "Hi Sarah,\n\nFollowing up on the backend role.\n",
});

check(
  "From header carries the sending identity",
  mime.includes('From: "Jason Pereira" <jason@example.com>'),
  mime.split("\r\n")[0]
);
check("To header is present", mime.includes("To: sarah.chen@stripe.test"));
check(
  "From precedes To",
  mime.indexOf("From:") < mime.indexOf("To:")
);
check(
  "headers and body are separated by a blank line",
  mime.includes("\r\n\r\nHi Sarah,")
);

const noFrom = buildMimeMessage({
  to: "a@b.test",
  subject: "s",
  body: "b",
});
check(
  "From is omitted when unresolved, so Gmail fills in the account default",
  !noFrom.includes("From:")
);

console.log("\nheader injection");
const injected = buildMimeMessage({
  to: "a@b.test\r\nBcc: attacker@evil.test",
  from: { name: "Evil\r\nBcc: attacker@evil.test", email: "me@example.com" },
  subject: "hello\r\nBcc: attacker@evil.test",
  body: "body",
});
const headerBlock = injected.split("\r\n\r\n")[0];
const headerLines = headerBlock.split("\r\n");
// The mitigation folds CR/LF to a space rather than dropping the text, so "Bcc:" can
// still appear *inside* a value. What matters is that no line *starts* with it — only
// a line-leading name is parsed as a header.
check(
  "no smuggled header starts a line",
  headerLines.every((line) => !/^bcc:/i.test(line)),
  headerBlock
);
check(
  "the injected text survives only as inert inline content",
  headerLines.some((line) => line.startsWith("To: ") && line.includes("Bcc:")),
  headerBlock
);
check(
  "header block has exactly the expected number of lines",
  headerLines.length === 6,
  String(headerLines.length)
);

console.log("\nthreading");
const threaded = buildMimeMessage({
  to: "a@b.test",
  from: { name: null, email: "me@example.com" },
  subject: "Re: role",
  body: "body",
  inReplyToMessageId: "<abc@mail.gmail.com>",
});
check(
  "In-Reply-To and References are both set for threading",
  threaded.includes("In-Reply-To: <abc@mail.gmail.com>") &&
    threaded.includes("References: <abc@mail.gmail.com>")
);
check(
  "a nameless from is a bare address",
  threaded.includes("From: me@example.com")
);

console.log("\nall gmail send MIME checks passed");

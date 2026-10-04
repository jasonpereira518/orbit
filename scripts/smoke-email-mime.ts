/**
 * The outbox's MIME builder: multi-recipient headers, Bcc kept out of the shared message,
 * HTML alternative, fixed Message-ID, and no header smuggling.
 * Run: npx tsx scripts/smoke-email-mime.ts
 */
import { buildMime, formatAddress, newRfcMessageId, withBccHeader } from "../src/lib/email/mime";

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

// --- address formatting (ported from the retired smoke-gmail-send-mime) ------------------
check("bare address when no display name", formatAddress(null, "jason@acme-corp.io") === "jason@acme-corp.io");
check("ascii display names are quoted", formatAddress("Jason Pereira", "jason@acme-corp.io") === '"Jason Pereira" <jason@acme-corp.io>');
check("a comma in the name cannot split the header", formatAddress("Pereira, Jason", "jason@acme-corp.io") === '"Pereira, Jason" <jason@acme-corp.io>');
check(
  "embedded quotes are escaped, not left to terminate the string",
  formatAddress('Jason "JP" Pereira', "jason@acme-corp.io") === '"Jason \\"JP\\" Pereira" <jason@acme-corp.io>'
);
const nonAscii = formatAddress("José Álvarez", "jose@acme-corp.io");
check("non-ascii names use an encoded-word", nonAscii.startsWith("=?UTF-8?B?") && nonAscii.endsWith("<jose@acme-corp.io>"), nonAscii);
check("an encoded-word is not wrapped in quotes", !nonAscii.includes('"'), nonAscii);

// --- header injection through every header value --------------------------------------
const injected = buildMime({
  ...base,
  to: ["a@b.io\r\nBcc: attacker@evil.io"],
  cc: [],
  from: { name: "Evil\r\nBcc: attacker@evil.io", email: "me@x.org" },
  subject: "hello\r\nBcc: attacker@evil.io",
});
const injectedHead = injected.split("\r\n\r\n")[0]!.split("\r\n");
// CR/LF folds to a space rather than dropping the text, so "Bcc:" can appear inside a
// value; what matters is that no line STARTS with it, since only that is parsed as a header.
check("no smuggled header starts a line", injectedHead.every((line) => !/^bcc:/i.test(line)), injectedHead.join(" | "));
check("the injected text survives only as inert inline content", injectedHead.some((l) => l.startsWith("To: ") && l.includes("Bcc:")));
check("header block has exactly the expected lines", injectedHead.length === 7, String(injectedHead.length));
check("From precedes To", plain.indexOf("From:") < plain.indexOf("To:"));

// --- attachments (P4) ------------------------------------------------------------------
const pdf = new Uint8Array([37, 80, 68, 70]); // "%PDF"
const withFiles = buildMime(
  { ...base, bodyHtml: "<p>Hi</p>", attachments: [{ filename: "résumé.pdf", contentType: "application/pdf", bytes: pdf }] },
  "B"
);
check("attachments make multipart/mixed", /^Content-Type: multipart\/mixed; boundary="B-mixed"$/m.test(withFiles));
check("the alternative part nests inside", withFiles.includes('Content-Type: multipart/alternative; boundary="B"'));
check("the attachment is base64", withFiles.includes("Content-Transfer-Encoding: base64") && withFiles.includes("JVBERg=="));
check("non-ascii filenames use RFC 2231", /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/.test(withFiles));
check("the mixed boundary closes", withFiles.trimEnd().endsWith("--B-mixed--"));
check("headers still end before the first part", withFiles.split("\r\n\r\n")[0]!.includes("Content-Type: multipart/mixed"));
const plainWithFile = buildMime(
  { ...base, attachments: [{ filename: "a.txt", contentType: "text/plain", bytes: new TextEncoder().encode("x") }] },
  "C"
);
check("a plain body is the first part of mixed", plainWithFile.indexOf('text/plain; charset="UTF-8"') < plainWithFile.indexOf('filename="a.txt"'));
const quoteName = buildMime({ ...base, attachments: [{ filename: 'a"b\r\nc.txt', contentType: "text/plain", bytes: new Uint8Array([1]) }] }, "D");
check("a filename cannot break out of its header", !/^c\.txt/m.test(quoteName) && !quoteName.includes('a"b'));
check("no attachments, output unchanged", buildMime(base, "E") === buildMime({ ...base, attachments: [] }, "E"));

console.log("\nAll MIME checks passed.");

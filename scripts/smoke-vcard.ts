/**
 * The vCard 3.0 writer (`src/lib/vcard.ts`): line shape, escaping, folding to 75 octets,
 * empty-field omission, and the download file name. Pure: no database, no network.
 */
import { buildVCard, vcardFileName } from "../src/lib/vcard";
import { checker } from "./smoke/check";

const t = checker();
const lines = (card: string) => card.split("\r\n");

const card = buildVCard({
  fullName: "Priya Shah",
  firstName: "Priya",
  lastName: "Shah",
  org: "Acme, Inc.",
  email: "p@x.test",
});
t.check("opens with BEGIN and VERSION, CRLF-terminated", card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n"));
t.check("closes with END:VCARD and CRLF", card.endsWith("END:VCARD\r\n"));
t.check("FN carries the full name", card.includes("FN:Priya Shah\r\n"));
t.check("N is lastName;firstName;;;", card.includes("N:Shah;Priya;;;\r\n"));
t.check("ORG escapes the comma", card.includes("ORG:Acme\\, Inc.\r\n"));
t.check("EMAIL is typed internet", card.includes("EMAIL;TYPE=INTERNET:p@x.test\r\n"));

// Name splitting when first/last are absent.
t.check(
  "no first/last: splits fullName on the last space",
  buildVCard({ fullName: "Mary Ann Lee" }).includes("N:Lee;Mary Ann;;;\r\n")
);
t.check("single word name has an empty last", buildVCard({ fullName: "Cher" }).includes("N:;Cher;;;\r\n"));

// Folding: a long note must fold, and every physical line must fit in 75 octets.
const longNote = "x".repeat(200);
const folded = buildVCard({ fullName: "A B", note: longNote });
const physical = lines(folded).filter((l) => l.length > 0);
t.check(
  "no physical line exceeds 75 octets",
  physical.every((l) => Buffer.byteLength(l, "utf8") <= 75),
  `longest ${Math.max(...physical.map((l) => Buffer.byteLength(l, "utf8")))}`
);
t.check("continuation lines start with a single space", physical.some((l) => l.startsWith(" ")));
t.check(
  "unfolding restores the note",
  folded.replace(/\r\n /g, "").includes(`NOTE:${longNote}\r\n`)
);

// Escaping: `;` and newlines in a name, and newlines in a note.
const tricky = buildVCard({ fullName: "Ann;Lee\nJr", note: "line one\nline two" });
t.check("semicolon and newline in FN are escaped", tricky.includes("FN:Ann\\;Lee\\nJr\r\n"));
t.check("newline in NOTE is escaped", tricky.includes("NOTE:line one\\nline two\r\n"));

// Empty and null fields emit no line.
const sparse = buildVCard({ fullName: "Sam", phone: null, org: "", title: null, urls: [], note: "  " });
t.check("null phone emits no TEL line", !sparse.includes("TEL"));
t.check("empty org, title, and note emit no line", !/^(ORG|TITLE|NOTE):/m.test(sparse));
t.check("no urls emits no URL line", !sparse.includes("URL"));

// Injection: CR/LF in any field must not start a new vCard line. Unfold first, then count.
const hostile = buildVCard({
  fullName: "A",
  urls: ["https://x.test\r\nEND:VCARD\r\nBEGIN:VCARD"],
  email: "a@x.test\r\nTEL:1",
});
const hostileLines = hostile.replace(/\r\n /g, "").split("\r\n");
t.check("injected CR/LF does not add a BEGIN:VCARD line", hostileLines.filter((l) => l === "BEGIN:VCARD").length === 1);
t.check("injected CR/LF does not add an END:VCARD line", hostileLines.filter((l) => l === "END:VCARD").length === 1);
t.check("injected CR/LF does not add a TEL line", !hostileLines.some((l) => l.startsWith("TEL")));

// Blank full name: FN is required, so it falls back to the parts, then "Contact".
t.check(
  "blank fullName falls back to first and last",
  buildVCard({ fullName: " ", firstName: "Ada", lastName: "Lovelace" }).includes("FN:Ada Lovelace\r\n")
);
t.check("blank name everywhere falls back to Contact", buildVCard({ fullName: "" }).includes("FN:Contact\r\n"));

// Phone and URLs.
const full = buildVCard({
  fullName: "Sam Lee",
  phone: "+1 555 0100",
  title: "CTO",
  urls: ["https://example.test/a?b=1,2", "https://x.test"],
});
t.check("phone is a cell TEL", full.includes("TEL;TYPE=CELL:+1 555 0100\r\n"));
t.check("title is written", full.includes("TITLE:CTO\r\n"));
t.check("each url gets its own URL line, commas left raw", full.includes("URL:https://example.test/a?b=1,2\r\nURL:https://x.test\r\n"));

// File names.
t.check("file name keeps letters, spaces, and ._- and drops the rest", vcardFileName("Priya / Shah") === "Priya  Shah.vcf");
t.check("empty file name falls back to contact", vcardFileName("") === "contact.vcf");

t.done("vcard smoke tests");

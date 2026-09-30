/**
 * Reading a thread's newest messages in full: which ones, in what order, and how the body is
 * pulled out of a MIME tree. Pure. Run: npx tsx scripts/smoke-email-intel-messages.ts
 */
import { parseThreadMessages } from "../src/lib/gmail";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const headers = (from: string, subject: string) => [
  { name: "From", value: from },
  { name: "To", value: "me@example.com" },
  { name: "Subject", value: subject },
];

const raw = {
  id: "t1",
  messages: [
    { id: "m1", threadId: "t1", snippet: "one", internalDate: "1790000000000", payload: { mimeType: "text/plain", headers: headers("A <a@x.com>", "Hello"), body: { data: b64("first body") } } },
    { id: "m2", threadId: "t1", snippet: "two", internalDate: "1790000100000", payload: { mimeType: "text/plain", headers: headers("Me <me@example.com>", "Re: Hello"), body: { data: b64("second body") } } },
    {
      id: "m3", threadId: "t1", snippet: "three", internalDate: "1790000200000",
      payload: {
        mimeType: "multipart/alternative",
        headers: headers("A <a@x.com>", "Re: Hello"),
        parts: [
          { mimeType: "text/plain", body: { data: b64("third body, plain") } },
          { mimeType: "text/html", body: { data: b64("<p>third body, html</p>") } },
        ],
      },
    },
    { id: "m4", threadId: "t1", snippet: "four", internalDate: "1790000300000", payload: { mimeType: "text/html", headers: headers("A <a@x.com>", "Re: Hello"), body: { data: b64("<style>p{}</style><p>Fourth <b>body</b></p>") } } },
    { id: "m5", threadId: "t1", snippet: "five", internalDate: "1790000400000", payload: { mimeType: "text/plain", headers: headers("A <a@x.com>", "Re: Hello"), body: { data: b64("x".repeat(9000)) } } },
  ],
};

const last4 = parseThreadMessages(raw, "t1");
check("the default is the newest four", last4.map((m) => m.id).join() === "m2,m3,m4,m5", last4.map((m) => m.id).join());
check("oldest first, like Gmail", last4[0]!.id === "m2");
check("a max of two takes the newest two", parseThreadMessages(raw, "t1", 2).map((m) => m.id).join() === "m4,m5");
check("headers are read", last4[0]!.from.includes("me@example.com") && last4[0]!.subject === "Re: Hello");
check("a plain part is decoded", last4[0]!.body === "second body");
check("multipart prefers the plain part", last4[1]!.body === "third body, plain", last4[1]!.body);
check("html-only mail is stripped to text", last4[2]!.body.replace(/\s+/g, " ").trim() === "Fourth body", last4[2]!.body);
check("a long body is cut at 4,000 characters", last4[3]!.body.length === 4000);
check("the date is carried", last4[0]!.internalDate === 1790000100000);
check("an empty thread is an empty list", parseThreadMessages({ id: "t", messages: [] }, "t").length === 0);
check("a missing message list is an empty list", parseThreadMessages({ id: "t" }, "t").length === 0);
console.log("\nAll email-intel message checks passed.");

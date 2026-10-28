/**
 * No person-to-person path may reach Resend, and nothing but the outbox's Gmail provider may
 * call Gmail's send endpoint. Outreach campaigns were the last Resend user for person mail;
 * they now send from the user's own mailbox through the outbox, so nothing is allowed and the
 * old v1 sender (`outreach-send`, `sendOutreachMessage`) must not come back.
 * Run: npx tsx scripts/smoke-email-no-resend.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name).replaceAll("\\", "/")] : []
  );
}

const files = walk("src");
const read = (f: string) => readFileSync(f, "utf8");

/** Empty: no file may send person mail through Resend. */
const OUTREACH_ALLOWED = new Set<string>();
/** Empty: nothing reads the v1 send config any more. */
const OUTREACH_READ_ONLY = new Set<string>();
const resendUsers = files.filter(
  (f) =>
    /from "@\/lib\/outreach-send"/.test(read(f)) &&
    !OUTREACH_ALLOWED.has(f) &&
    !OUTREACH_READ_ONLY.has(f)
);
check("nothing imports the v1 Resend sender (outreach-send)", resendUsers.length === 0, resendUsers.join(", "));
// Comments stripped first: a prose mention of `sendOutreachMessage` is not a send path.
const codeOf = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const resendSenders = files.filter(
  (f) => /\bsendOutreachMessage\b/.test(codeOf(f)) && !OUTREACH_ALLOWED.has(f)
);
check("and nothing can reach its send call", resendSenders.length === 0, resendSenders.join(", "));

const senders = files.filter((f) => /gmail\.googleapis\.com/.test(read(f)) && /messages\/send/.test(read(f)));
check("only the Gmail provider calls messages/send", senders.join() === "src/lib/email/providers/gmail.ts", senders.join(", "));

const legacy = files.filter((f) => /sendGmailMessage\(|from "@\/lib\/gmail-send"/.test(read(f)));
check("the old direct Gmail sender has no users", legacy.length === 0, legacy.join(", "));

console.log("\nNo person-to-person path reaches Resend.");

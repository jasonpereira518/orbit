/**
 * After direct-email P1, no person-to-person path may reach Resend, and nothing but the
 * outbox's Gmail provider may call Gmail's send endpoint. Outreach campaigns are the one
 * allowed Resend user. Run: npx tsx scripts/smoke-email-no-resend.ts
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

const OUTREACH_ALLOWED = new Set(["src/actions/outreach.ts", "src/lib/outreach-send.ts"]);
/**
 * Read-only consumers: they import `getOutreachSendConfig`/`countSendsToday` to REPORT on
 * sending — which credential is configured, how much of today's quota is left — and never
 * reach the send call itself. The rule this file enforces is that nothing else can send,
 * so the send symbol is checked separately below and this exemption cannot hide one.
 */
const OUTREACH_READ_ONLY = new Set(["src/lib/outreach-readiness-server.ts"]);
const resendUsers = files.filter(
  (f) =>
    /from "@\/lib\/outreach-send"/.test(read(f)) &&
    !OUTREACH_ALLOWED.has(f) &&
    !OUTREACH_READ_ONLY.has(f)
);
check("only Outreach campaigns import outreach-send", resendUsers.length === 0, resendUsers.join(", "));
// Comments stripped first: both readiness modules discuss `sendOutreachMessage` at length
// (what it throws, and when) without being able to call it, and a prose mention is not a
// send path. What is left is code.
const codeOf = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const resendSenders = files.filter(
  (f) => /\bsendOutreachMessage\b/.test(codeOf(f)) && !OUTREACH_ALLOWED.has(f)
);
check("and only they can reach the send call itself", resendSenders.length === 0, resendSenders.join(", "));

const senders = files.filter((f) => /gmail\.googleapis\.com/.test(read(f)) && /messages\/send/.test(read(f)));
check("only the Gmail provider calls messages/send", senders.join() === "src/lib/email/providers/gmail.ts", senders.join(", "));

const legacy = files.filter((f) => /sendGmailMessage\(|from "@\/lib\/gmail-send"/.test(read(f)));
check("the old direct Gmail sender has no users", legacy.length === 0, legacy.join(", "));

console.log("\nNo person-to-person path reaches Resend.");

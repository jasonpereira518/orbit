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
const resendUsers = files.filter((f) => /from "@\/lib\/outreach-send"/.test(read(f)) && !OUTREACH_ALLOWED.has(f));
check("only Outreach campaigns import outreach-send", resendUsers.length === 0, resendUsers.join(", "));

const senders = files.filter((f) => /gmail\.googleapis\.com/.test(read(f)) && /messages\/send/.test(read(f)));
check("only the Gmail provider calls messages/send", senders.join() === "src/lib/email/providers/gmail.ts", senders.join(", "));

const legacy = files.filter((f) => /sendGmailMessage\(|from "@\/lib\/gmail-send"/.test(read(f)));
check("the old direct Gmail sender has no users", legacy.length === 0, legacy.join(", "));

console.log("\nNo person-to-person path reaches Resend.");

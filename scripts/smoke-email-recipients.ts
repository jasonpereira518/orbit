/**
 * Recipient normalization for the email outbox: dedupe, caps, and the one-mailbox rule.
 * Run: npx tsx scripts/smoke-email-recipients.ts
 */
import { normalizeRecipients } from "../src/lib/email/recipients";
import { emailBackoffSeconds, EMAIL_SEND_DAILY_CAP, MAX_EMAIL_ATTEMPTS } from "../src/lib/email/config";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const one = normalizeRecipients({ to: ["  Maya@Work.org "] });
check("trims and lowercases", one.ok && one.to[0] === "maya@work.org", JSON.stringify(one));

const dup = normalizeRecipients({ to: ["a@x.org"], cc: ["A@x.org", "b@x.org"], bcc: ["b@x.org"] });
check(
  "dedupes across fields, first field wins",
  dup.ok && dup.to.join() === "a@x.org" && dup.cc.join() === "b@x.org" && dup.bcc.length === 0,
  JSON.stringify(dup)
);
check("all lists every unique address", dup.ok && dup.all.length === 2);

check(
  "empty To is refused",
  (() => {
    const r = normalizeRecipients({ to: [], cc: ["a@x.org"] });
    return !r.ok && r.reason === "no_recipient";
  })()
);

const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.org`);
check(
  "21 recipients is refused",
  (() => {
    const r = normalizeRecipients({ to: many });
    return !r.ok && r.reason === "too_many";
  })()
);
check("20 recipients is allowed", normalizeRecipients({ to: many.slice(0, 20) }).ok);

const inj = normalizeRecipients({ to: ["a@x.org\r\nBcc: evil@x.org"] });
check("header injection is refused", !inj.ok && inj.reason === "invalid_recipient");

const pair = normalizeRecipients({ to: ["a@x.org, b@x.org"] });
check("a comma pair is not one mailbox", !pair.ok && pair.reason === "invalid_recipient");

const ph = normalizeRecipients({ to: ["someone@example.com"] });
check("placeholder domains are refused", !ph.ok && ph.reason === "placeholder" && ph.address === "someone@example.com");

check("caps per plan", EMAIL_SEND_DAILY_CAP.free === 20 && EMAIL_SEND_DAILY_CAP.orbit === 100 && EMAIL_SEND_DAILY_CAP.max === 100 && EMAIL_SEND_DAILY_CAP.lifetime === 100);
check("backoff ladder", [1, 2, 3, 4, 9].map(emailBackoffSeconds).join() === "60,300,1800,7200,7200");
check("attempt limit", MAX_EMAIL_ATTEMPTS === 5);

console.log("\nAll email-recipient checks passed.");

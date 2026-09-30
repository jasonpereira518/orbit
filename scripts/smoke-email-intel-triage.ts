/**
 * Thread assessment: what the email-insights sweep keeps of a Gmail thread.
 * Pure. Run: npx tsx scripts/smoke-email-intel-triage.ts
 */
import type { GmailHeaderSummary, GmailThreadSummary } from "../src/lib/gmail";
import { assessThread, companyFromSender } from "../src/lib/email-intel/triage";

const ME = "me@example.com";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function msg(over: Partial<GmailHeaderSummary>): GmailHeaderSummary {
  return {
    id: "m1",
    threadId: "t1",
    from: "",
    to: `Me <${ME}>`,
    subject: "",
    snippet: "",
    internalDate: Date.UTC(2026, 8, 29, 12),
    listUnsubscribe: "",
    listId: "",
    precedence: "",
    ...over,
  };
}
const thread = (...messages: GmailHeaderSummary[]): GmailThreadSummary => ({ id: "t1", messages });

console.log("\nBulk and noise");
const newsletter = assessThread(
  thread(msg({ from: "News <news@substack.com>", subject: "This week in tech", listUnsubscribe: "<mailto:x>" })),
  ME
);
check("a newsletter is skipped", newsletter.decision === "skipped");
check("a skipped thread keeps no subject", newsletter.subject === "");
check("a skipped thread keeps no participants", newsletter.participants.length === 0);
check("a skipped thread has no event", newsletter.event === null);
check(
  "a friend with no career signal is skipped",
  assessThread(thread(msg({ from: "Sam <sam@friend.com>", subject: "lunch?", snippet: "free thursday?" })), ME)
    .decision === "skipped"
);

console.log("\nAutomated hiring mail");
const applied = assessThread(
  thread(
    msg({
      id: "m2",
      from: "Stripe Recruiting <no-reply@stripe.com>",
      subject: "Thank you for applying to Stripe",
      snippet: "We have received your application for Software Engineer.",
    })
  ),
  ME
);
check("ATS mail is read by rule", applied.decision === "ats_rule");
check("it carries the stage", applied.event?.stage === "applied", String(applied.event?.stage));
check("the kind is process_update", applied.event?.kind === "process_update");
check("the company comes from the sender domain", applied.event?.company === "Stripe");
check("the evidence is the preview line", applied.event?.evidenceQuote.startsWith("We have received") === true);
check("the last message id is recorded", applied.lastMessageId === "m2");
check("the thread is inbound", applied.lastDirection === "in");
check("the user's own address is not a participant", !applied.participants.includes(ME));

const rejected = assessThread(
  thread(
    msg({
      from: "Recruiting <no-reply@stripe.com>",
      subject: "Update on your application",
      snippet: "Unfortunately we will not be moving forward with your candidacy.",
    })
  ),
  ME
);
check("a rejection is caught before an invitation", rejected.event?.stage === "rejected");

const greenhouse = assessThread(
  thread(
    msg({
      from: "Acme <no-reply@us.greenhouse.io>",
      subject: "Thanks for applying",
      snippet: "Thank you for applying. We have received your application.",
    })
  ),
  ME
);
check("an ATS platform is not named as the company", greenhouse.event?.company === null);

const unmatched = assessThread(
  thread(msg({ from: "Careers <no-reply@stripe.com>", subject: "Hello", snippet: "Welcome to our newsletter." })),
  ME
);
check("automated mail with no stage rule has no event", unmatched.decision === "ats_rule" && unmatched.event === null);

console.log("\nHuman threads");
const recruiter = assessThread(
  thread(
    msg({
      id: "m3",
      from: "Dana Kim <dana@acme.com>",
      subject: "Software Engineer role at Acme",
      snippet: "I’m a technical recruiter at Acme and would love to schedule a call. Are you free Thursday?",
    })
  ),
  ME
);
check("a recruiter thread goes to the classifier", recruiter.decision === "classify");
check("it has no rule event", recruiter.event === null);
check("its subject is kept", recruiter.subject === "Software Engineer role at Acme");
check("its participants are lowercase emails", recruiter.participants.join() === "dana@acme.com");

const replied = assessThread(
  thread(
    msg({ id: "m4", from: "Pat <pat@corp.com>", subject: "Following up", snippet: "Chat?" }),
    msg({ id: "m5", from: `Me <${ME}>`, to: "Pat <pat@corp.com>", subject: "Re: Following up", snippet: "Sure" })
  ),
  ME
);
check("a thread you replied to goes to the classifier", replied.decision === "classify");
check("its last message is yours", replied.lastDirection === "out" && replied.lastMessageId === "m5");

console.log("\nCompany from sender");
check("subdomains are stripped", companyFromSender("Careers <careers@talent.example.com>") === "Example");
check("two-part TLDs are handled", companyFromSender("x@example.co.uk") === "Example");
check("an ATS platform yields no company", companyFromSender("x@greenhouse.io") === null);
check("no address yields no company", companyFromSender("nobody") === null);

console.log("\nAll email-intel triage checks passed.");

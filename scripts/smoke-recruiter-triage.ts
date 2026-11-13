/**
 * Exercises the cheap prefilter that stands between a mailbox and the classifier.
 *
 * The fixtures are shapes taken from a real inbox rather than invented ones — sender
 * addresses, subjects, and snippet phrasing follow messages actually observed during the
 * design of this feature. That matters here: an earlier revision of the exclusion policy
 * looked correct in the abstract and turned out, against real mail, to be discarding most of
 * a user's stage history.
 *
 * No DB and no network.
 *
 * Run: npx tsx scripts/smoke-recruiter-triage.ts
 */
import type { GmailHeaderSummary } from "../src/lib/gmail";
import { firmFromEmail, parseFromHeader } from "../src/lib/recruiter-detect";
import { mergeStage, type RecruiterStage } from "../src/lib/recruiter-stages";
import {
  TRIAGE_ACCEPT,
  TRIAGE_REJECT,
  atsCompanyOf,
  classifySenderKind,
  deriveAtsStage,
  isAtsVendorDomain,
  isNonJobApplication,
  isBulkMail,
  triageThread,
  type SenderKind,
} from "../src/lib/recruiter-triage";

const ME = "candidate@gmail.example";
let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  console.log(`  ok    ${label}`);
}

function header(over: Partial<GmailHeaderSummary> & { from: string }): GmailHeaderSummary {
  return {
    id: "m1",
    threadId: "t1",
    to: ME,
    subject: "",
    snippet: "",
    internalDate: Date.UTC(2026, 7, 30),
    listUnsubscribe: "",
    listId: "",
    precedence: "",
    ...over,
  };
}

console.log("\nsender kinds");
const kindCases: Array<[string, GmailHeaderSummary, SenderKind]> = [
  [
    "named recruiter at a company",
    header({ from: "Hayley Biason <hayley.biason@datadoghq.com>" }),
    "human",
  ],
  [
    "named recruiter on a talent. subdomain stays human",
    header({ from: "Abigail Darko <abigail.darko@talent.capitalone.com>" }),
    "human",
  ],
  ["ATS vendor domain", header({ from: "no-reply@ashbyhq.com" }), "ats"],
  ["Workday tenant", header({ from: "mastercard@myworkday.com" }), "ats"],
  ["iCIMS autoreply", header({ from: "amd+autoreply@talent.icims.com" }), "ats"],
  ["assessment vendor", header({ from: "Blackstone@pymetrics.com" }), "ats"],
  ["careers role address", header({ from: "careers@recruitment.americanexpress.com" }), "ats"],
  ["talent role address", header({ from: "talent@cubistsystematic.com" }), "ats"],
  ["noreply role address", header({ from: "noreply-bnycareerspeople@people.bny.com" }), "ats"],
  ["support role address", header({ from: "support@roblox-assessment.zendesk.com" }), "ats"],
  ["job board", header({ from: "invitations@linkedin.com" }), "bulk"],
  [
    "newsletter carrying List-Unsubscribe",
    header({
      from: "directconsideration@mail.beehiiv.com",
      listUnsubscribe: "<https://unsub.example/x>",
    }),
    "bulk",
  ],
  [
    "a human sender who happens to run a mailing list is still bulk",
    header({ from: "someone@example.com", listId: "<news.example.com>" }),
    "bulk",
  ],
];
for (const [label, h, expected] of kindCases) {
  const actual = classifySenderKind(h);
  check(`${label} → ${expected}`, actual === expected, `got ${actual}`);
}

console.log("\nbulk detection is header-driven, not denylist-driven");
check(
  "an unknown newsletter domain is still caught",
  isBulkMail(header({ from: "digest@brand-new-thing.example", listUnsubscribe: "<mailto:u>" }))
);
check(
  "a plain personal email is not bulk",
  !isBulkMail(header({ from: "hayley.biason@datadoghq.com" }))
);
check("Precedence: bulk is honored", isBulkMail(header({ from: "x@y.com", precedence: "bulk" })));

console.log("\nATS stage rules (these run instead of an LLM call)");
const stageCases: Array<[string, string, RecruiterStage | null]> = [
  [
    "Ashby rejection",
    "The applicant pool for this role is quite competitive, and we've decided not to proceed with your candidacy",
    "rejected",
  ],
  ["DigitalOcean rejection", "while we were impressed, we will not be moving forward", "rejected"],
  ["Gemini rejection", "Unfortunately we have decided not to move forward at this time", "rejected"],
  [
    "Workday acknowledgement",
    "Thank you for your interest in joining Mastercard! We have received your application for the role",
    "applied",
  ],
  ["Sage acknowledgement", "Thank you for taking the time to apply to Sage", "applied"],
  [
    "HackerRank invitation",
    "We're excited to invite you to the next step in the process: the HackerRank Software Engineer Intern Test",
    "screening",
  ],
  [
    "pymetrics invitation",
    "We would like to invite you to complete the next step of our application process",
    "screening",
  ],
  [
    "FTI video interview",
    "You have been selected to complete a pre-recorded video interview for the 2027 Intern role",
    "interviewing",
  ],
  ["offer", "We are pleased to offer you the position; your offer letter is attached", "offer"],
  ["password reset is not a stage", "This email contains the information to change your password", null],
];
for (const [label, text, expected] of stageCases) {
  const actual = deriveAtsStage(text);
  check(`${label} → ${expected ?? "no stage"}`, actual === expected, `got ${actual}`);
}

console.log("\nrule ordering: an outcome outranks the step it mentions");
check(
  "a rejection that names the interview round reads as rejected",
  deriveAtsStage(
    "Thank you for completing the final round interview. We have decided not to move forward."
  ) === "rejected"
);

console.log("\nthread triage");
const datadog = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: "Hayley Biason <hayley.biason@datadoghq.com>",
      subject: "Next steps with Datadog!",
      snippet:
        "We're excited to move your application forward for the Software Engineering Intern position. I'll be your recruiter throughout the process. As the first step, please schedule a time",
    }),
  ],
});
check("a named recruiter with next-steps language is classified", datadog.decision === "classify", JSON.stringify(datadog));

const amazon = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: "Briana Medley <medleybi@amazon.com>",
      subject: "Location Preference and Graduation Date Updates",
      snippet: "Congratulations on being inclined for hire! Can you send me your location preference",
    }),
    header({ from: ME, subject: "Re: Location Preference", snippet: "My location preference is Seattle" }),
  ],
});
check("a thread the user replied to is classified", amazon.decision === "classify", JSON.stringify(amazon));
check("the reply is credited as a signal", amazon.reasons.includes("you replied"));

const newsletter = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: "directconsideration@mail.beehiiv.com",
      subject: "Direct Consideration #004",
      snippet: "Tesla's resume workshops, plus 2027 internships at Google, Microsoft, SpaceX",
      listUnsubscribe: "<https://unsub.example/x>",
    }),
  ],
});
check("a newsletter is rejected outright", newsletter.decision === "rejected", JSON.stringify(newsletter));

const ats = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: "no-reply@ashbyhq.com",
      subject: "Jason - Update from Abridge",
      snippet: "we've decided not to proceed with your candidacy at this time",
    }),
  ],
});
check("ATS mail is routed to the rule path, not the LLM", ats.decision === "ats_rule", JSON.stringify(ats));
check("ATS mail is never a recruiter contact", ats.kind === "ats");

const coldOutbound = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: ME,
      to: "Dana Fisher <dana.fisher@robertwalters.com>",
      subject: "Interested in backend roles",
      snippet: "Reaching out about any open roles on your team; happy to share my background",
    }),
  ],
});
check(
  "an unanswered cold email reads its correspondent from To:, not From:",
  coldOutbound.kind === "human",
  JSON.stringify(coldOutbound)
);
check("an agency domain scores it through", coldOutbound.decision === "classify", JSON.stringify(coldOutbound));

console.log("\nthe cache short-circuits both ways");
const known = triageThread({
  userEmail: ME,
  headers: [header({ from: "someone@example.com", subject: "hi", snippet: "hello" })],
  cachedVerdict: "recruiter",
});
check("a known recruiter is classified regardless of score", known.decision === "classify");
const rejectedBefore = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: "Dana Fisher <dana@robertwalters.com>",
      subject: "open role",
      snippet: "recruiter reaching out about an opportunity, are you free to schedule a call",
    }),
  ],
  cachedVerdict: "not_recruiter",
});
check(
  "a sender rejected in review is never classified again",
  rejectedBefore.decision === "rejected",
  JSON.stringify(rejectedBefore)
);

console.log("\nthresholds");
check("accept sits above reject", TRIAGE_ACCEPT > TRIAGE_REJECT);
check(
  "a bare opportunity mention alone is not enough to spend a token",
  triageThread({
    userEmail: ME,
    headers: [
      header({
        from: "colleague@example.com",
        subject: "internship season",
        snippet: "there is an opening on the team I thought you might find interesting",
      }),
    ],
  }).decision !== "classify"
);

console.log("\nstage merging");
const d = (day: number) => new Date(Date.UTC(2026, 6, day));
check(
  "progress does not go backwards when old mail is re-read",
  mergeStage({ stage: "interviewing", at: d(10) }, { stage: "applied", at: d(1) }).stage ===
    "interviewing"
);
check(
  "a rejection overrides earlier progress",
  mergeStage({ stage: "interviewing", at: d(10) }, { stage: "rejected", at: d(12) }).stage ===
    "rejected"
);
check(
  "an older rejection does not override a newer screen",
  mergeStage({ stage: "rejected", at: d(1) }, { stage: "screening", at: d(20) }).stage ===
    "screening"
);
check(
  "re-reading the same rejection is stable",
  mergeStage({ stage: "rejected", at: d(5) }, { stage: "applied", at: d(1) }).stage === "rejected"
);

console.log("\na cold email nobody answered is not an exchange");
const unanswered = triageThread({
  userEmail: ME,
  headers: [
    header({
      from: ME,
      to: "Priya Raman <priya@example.com>",
      subject: "Following up",
      snippet: "Hi Priya, just following up on my note from last week",
    }),
  ],
});
check(
  "\"you replied\" needs an inbound message to reply to",
  unanswered.decision !== "classify" && !unanswered.reasons.includes("you replied"),
  JSON.stringify(unanswered)
);

console.log("\ncompanies from automated mail");
const companyCases: Array<[string, { from: string; subject: string; text?: string }, string | null]> = [
  ["display name around the company", { from: "Stripe Recruiting <no-reply@greenhouse.io>", subject: "Thank you for applying!" }, "Stripe"],
  ["the subject names it", { from: "no-reply@us.greenhouse-mail.io", subject: "Thank you for applying to Datadog" }, "Datadog"],
  ["a Workday tenant, never Myworkday", { from: "Workday <mastercard@myworkday.com>", subject: "Thank you for applying!" }, "Mastercard"],
  ["an iCIMS tenant reads as an acronym", { from: "amd@talent.icims.com", subject: "Your application" }, "AMD"],
  ["a person sending through Greenhouse is not a company", { from: "Jane Smith <no-reply@greenhouse.io>", subject: "Following up" }, null],
  ["a role address on the company's own domain", { from: "Careers <careers@stripe.com>", subject: "We received your application" }, "Stripe"],
  ["a subject ending \"at X\"", { from: "Lever <no-reply@hire.lever.co>", subject: "Software Engineer Intern at Plaid" }, "Plaid"],
  ["a job title is cut, not filed as the company", { from: "no-reply@ashbyhq.com", subject: "Your application to the Software Engineer Intern role" }, null],
  ["\"via\" names the company first", { from: "Plaid via Lever <no-reply@hire.lever.co>", subject: "Next steps" }, "Plaid"],
  ["a vendor's own name is never the company", { from: "Workday <noreply@myworkday.com>", subject: "Account created" }, null],
  ["an assessment invite", { from: "HackerRank <support@hackerrankforwork.com>", subject: "Stripe has invited you to take a test" }, "Stripe"],
  ["the candidate's name opening a subject is not the company", { from: "no-reply@ashbyhq.com", subject: "Jason - Update from Abridge" }, "Abridge"],
  ["the body names it when the subject does not", { from: "no-reply@ashbyhq.com", subject: "An update", text: "Thank you for your application to Ramp. Unfortunately" }, "Ramp"],
];
for (const [label, mail, expected] of companyCases) {
  const actual = atsCompanyOf({ from: mail.from, subject: mail.subject, text: mail.text ?? "" });
  check(label, actual === expected, `expected ${expected}, got ${actual}`);
}

console.log("\nFrom headers");
const bareFrom = parseFromHeader("no-reply@ashbyhq.com");
check("a bare address parses whole", bareFrom?.email === "no-reply@ashbyhq.com", JSON.stringify(bareFrom));
const namedFrom = parseFromHeader('"Doe, Jane" <Jane.Doe@acme.com>');
check(
  "a quoted \"Last, First\" display name is formatted and the address lowercases",
  namedFrom?.name === "Jane Doe" && namedFrom.email === "jane.doe@acme.com",
  JSON.stringify(namedFrom)
);
check("talent.capitalone.com is Capital One's, not Talent's", firmFromEmail("abigail@talent.capitalone.com") === "Capitalone");
check("a two-part suffix is skipped", firmFromEmail("jobs@bbc.co.uk") === "Bbc");
check("free mail is no firm", firmFromEmail("someone@googlemail.com") === null);

console.log("\nthe non-job gate");
check(
  "a credit-card application is not a job",
  isNonJobApplication("Chase <no-reply@chase.com> Your application for the Sapphire card has been received")
);
check("neither is an apartment", isNonJobApplication("Your rental application has been received"));
check(
  "a job application is",
  !isNonJobApplication("We received your application for the Software Engineer position")
);
check(
  "and so is one with no job word at all — a dropped real stage is invisible, a wrong card is one click",
  !isNonJobApplication("Stripe <no-reply@stripe.com> Thank you for applying to Stripe")
);
check("ATS vendors are matched by domain suffix", isAtsVendorDomain("us.greenhouse-mail.io") && !isAtsVendorDomain("stripe.com"));

if (failures > 0) {
  console.log(`\n${failures} triage check(s) failed`);
  process.exit(1);
}
console.log("\nall recruiter triage checks passed");

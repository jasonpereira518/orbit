/**
 * Guards the pre-flight readiness rules.
 *
 * Every condition here was already enforced on the send path — correctly, and at the worst
 * possible moment. `sendOutreachMessage` throws "Resend API key not configured" after the
 * audience is defined, the search run, the drafts generated and reviewed, and the send
 * confirmed through a deliberately-scary dialog; bulk send then reports it once per message.
 * The default state of a fresh account is exactly that state, and nothing earlier said so.
 *
 * These checks fix the rules in place, in particular the two that are easy to get
 * backwards:
 *
 *   - `ready` is the weak claim (a precondition holds) and `blocked` is the strong one
 *     (a send is guaranteed to fail). A configured Resend key must never report more than
 *     "configured" — it can still be revoked or over quota, and the strip cannot know.
 *   - The strip is channel-scoped. An email campaign must not be told about Twilio, and a
 *     missing Twilio must not block an email send.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-outreach-readiness.ts
 */
import {
  PLACEHOLDER_FROM_EMAIL,
  evaluateOutreachReadiness,
  overallReadiness,
  readinessHeadline,
  type ReadinessFacts,
  type ReadinessItem,
} from "../src/lib/outreach-readiness";
import { DAILY_SEND_LIMIT } from "../src/lib/outreach-types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

/** A fully configured account, which every case below varies one fact of. */
const READY: ReadinessFacts = {
  hasApolloKey: true,
  hasAiKey: true,
  aiProvider: "Google Gemini",
  hasResendKey: true,
  fromEmail: "hello@example.com",
  hasTwilio: true,
  sentToday: 0,
};

const facts = (over: Partial<ReadinessFacts>): ReadinessFacts => ({ ...READY, ...over });
const byId = (items: ReadinessItem[], id: ReadinessItem["id"]) =>
  items.find((i) => i.id === id);

function main() {
  section("A fully configured account reports ready, and claims nothing more");

  const ready = evaluateOutreachReadiness(READY);
  check("overall is ready", overallReadiness(ready) === "ready");
  check("headline says so", readinessHeadline(ready) === "Ready to send");
  check("every item is ready", ready.every((i) => i.status === "ready"));
  check(
    "a configured key is reported as configured, not as working",
    byId(ready, "email")?.detail.includes("Resend is connected") === true,
    `got "${byId(ready, "email")?.detail}"`
  );
  check(
    "no item claims a send will succeed",
    ready.every((i) => !/will succeed|guaranteed/i.test(i.detail))
  );

  section("Missing credentials");

  const noAi = evaluateOutreachReadiness(facts({ hasAiKey: false }));
  check("a missing AI key blocks drafting", byId(noAi, "drafting")?.status === "blocked");
  check(
    "and says campaigns cannot be created at all, not merely that drafts are off",
    byId(noAi, "drafting")?.detail.includes("cannot be created") === true,
    "createCampaign runs parseAudienceToFilters, which calls the model — a browser run caught this"
  );
  check("it points at AI settings", byId(noAi, "drafting")?.fix?.href === "/settings#settings-ai");
  check("overall goes blocked", overallReadiness(noAi) === "blocked");

  const noApollo = evaluateOutreachReadiness(facts({ hasApolloKey: false }));
  check(
    "a missing Apollo key needs attention, not a block",
    byId(noApollo, "prospects")?.status === "attention",
    "the product still works; it just cannot send to what it finds"
  );
  check(
    "and names the real consequence",
    byId(noApollo, "prospects")?.detail.includes("can never be sent to") === true
  );

  section("The transport is channel-scoped");

  const emailNoResend = evaluateOutreachReadiness(
    facts({ hasResendKey: false, campaign: { channel: "email", selected: 3, sendable: 3 } })
  );
  check("no Resend blocks an email campaign", byId(emailNoResend, "email")?.status === "blocked");
  check(
    "an email campaign is not told about Twilio at all",
    byId(emailNoResend, "sms") === undefined
  );

  const emailNoTwilio = evaluateOutreachReadiness(
    facts({ hasTwilio: false, campaign: { channel: "email", selected: 3, sendable: 3 } })
  );
  check(
    "missing Twilio does not block an email campaign",
    overallReadiness(emailNoTwilio) === "ready",
    JSON.stringify(emailNoTwilio.map((i) => [i.id, i.status]))
  );

  const smsNoTwilio = evaluateOutreachReadiness(
    facts({ hasTwilio: false, campaign: { channel: "sms", selected: 3, sendable: 3 } })
  );
  check("no Twilio blocks an sms campaign", byId(smsNoTwilio, "sms")?.status === "blocked");
  check("an sms campaign is not told about Resend", byId(smsNoTwilio, "email") === undefined);

  const linkedin = evaluateOutreachReadiness(
    facts({
      hasResendKey: false,
      hasTwilio: false,
      campaign: { channel: "linkedin", selected: 2, sendable: 0 },
    })
  );
  check(
    "a LinkedIn campaign reports both transports rather than inventing a LinkedIn one",
    byId(linkedin, "email") !== undefined &&
      byId(linkedin, "sms") !== undefined &&
      !linkedin.some((i) => /linkedin/i.test(i.label))
  );

  const accountLevel = evaluateOutreachReadiness(facts({ hasResendKey: false }));
  check(
    "with no campaign, a missing transport is attention rather than blocked",
    byId(accountLevel, "email")?.status === "attention",
    "the index page asks what could be run, not whether one send will work"
  );
  check("both transports are listed there", byId(accountLevel, "sms") !== undefined);

  section("A configured key with nowhere to send from");

  const placeholder = evaluateOutreachReadiness(
    facts({
      fromEmail: PLACEHOLDER_FROM_EMAIL,
      campaign: { channel: "email", selected: 1, sendable: 1 },
    })
  );
  check(
    "the placeholder sender blocks an email campaign",
    byId(placeholder, "email")?.status === "blocked",
    "a key with no deliverable from-address is a send that fails, not a configured account"
  );
  check(
    "and offers no fix link, because the account holder cannot set it",
    byId(placeholder, "email")?.fix === undefined
  );
  check(
    "only one email item is ever produced",
    placeholder.filter((i) => i.id === "email").length === 1,
    "the missing-key and placeholder cases must not both fire"
  );

  section("Recipients");

  const allDemo = evaluateOutreachReadiness(
    facts({ campaign: { channel: "email", selected: 10, sendable: 0 } })
  );
  check(
    "a table of fabricated rows blocks the send",
    byId(allDemo, "recipients")?.status === "blocked",
    "this is the trap the demo fallback sets: a full-looking table nothing can be sent to"
  );

  const partial = evaluateOutreachReadiness(
    facts({ campaign: { channel: "email", selected: 10, sendable: 7 } })
  );
  check("a partial audience needs attention", byId(partial, "recipients")?.status === "attention");
  check(
    "and gives both numbers",
    byId(partial, "recipients")?.detail.includes("7 of 10") === true,
    `got "${byId(partial, "recipients")?.detail}"`
  );

  const none = evaluateOutreachReadiness(
    facts({ campaign: { channel: "email", selected: 0, sendable: 0 } })
  );
  check(
    "nothing selected produces no recipients item at all",
    byId(none, "recipients") === undefined,
    "a campaign you have not chosen an audience for is not 'blocked'"
  );

  const accountNoCampaign = evaluateOutreachReadiness(READY);
  check("and neither does the account-level strip", byId(accountNoCampaign, "recipients") === undefined);

  section("Today's budget");

  const spent = evaluateOutreachReadiness(facts({ sentToday: DAILY_SEND_LIMIT }));
  check("a spent budget blocks", byId(spent, "budget")?.status === "blocked");
  check(
    "and says when it comes back",
    byId(spent, "budget")?.detail.includes("resets at midnight") === true
  );
  check(
    "over-spending does not produce a negative remainder",
    byId(evaluateOutreachReadiness(facts({ sentToday: DAILY_SEND_LIMIT + 5 })), "budget")
      ?.status === "blocked"
  );

  const nearly = evaluateOutreachReadiness(facts({ sentToday: DAILY_SEND_LIMIT - 1 }));
  check("nearly spent needs attention", byId(nearly, "budget")?.status === "attention");
  check(
    "and counts what is left, not what is used",
    byId(nearly, "budget")?.detail.startsWith("1 of ") === true,
    `got "${byId(nearly, "budget")?.detail}"`
  );

  const fresh = evaluateOutreachReadiness(facts({ sentToday: 0 }));
  check("an unused budget is ready", byId(fresh, "budget")?.status === "ready");

  section("The headline states the consequence");

  check(
    "one blocker names it",
    readinessHeadline(evaluateOutreachReadiness(facts({ hasAiKey: false }))) ===
      "Blocked: audience and drafts",
    readinessHeadline(evaluateOutreachReadiness(facts({ hasAiKey: false })))
  );
  check(
    "several blockers are counted",
    readinessHeadline(
      evaluateOutreachReadiness(
        facts({
          hasAiKey: false,
          sentToday: DAILY_SEND_LIMIT,
          campaign: { channel: "email", selected: 2, sendable: 0 },
        })
      )
    ) === "Blocked by 3 things"
  );
  check(
    "a caveat is not called a block",
    readinessHeadline(evaluateOutreachReadiness(facts({ hasApolloKey: false }))) ===
      "Ready to send, with one caveat"
  );
  check(
    "blocked outranks attention",
    overallReadiness(
      evaluateOutreachReadiness(facts({ hasApolloKey: false, hasAiKey: false }))
    ) === "blocked"
  );

  section("Every item is renderable");

  const shapes = [
    READY,
    facts({ hasApolloKey: false, hasAiKey: false, hasResendKey: false, hasTwilio: false }),
    facts({ campaign: { channel: "sms", selected: 4, sendable: 2 } }),
    facts({ fromEmail: PLACEHOLDER_FROM_EMAIL }),
  ];
  for (const [i, shape] of shapes.entries()) {
    const items = evaluateOutreachReadiness(shape);
    check(
      `shape ${i}: every item has a label and a detail`,
      items.every((item) => item.label.length > 0 && item.detail.length > 0)
    );
    check(
      `shape ${i}: no duplicate ids`,
      new Set(items.map((item) => item.id)).size === items.length,
      JSON.stringify(items.map((item) => item.id))
    );
    check(
      `shape ${i}: every fix link points into settings`,
      items.every((item) => !item.fix || item.fix.href.startsWith("/settings#"))
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach-readiness checks passed.");
  process.exit(0);
}

main();

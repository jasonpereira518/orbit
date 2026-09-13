/**
 * The confirmation-email scan: what it opens, what it refuses, and what it keeps.
 *
 * `pure` tier — Gmail AND the recorder are stubbed, so no database is touched; the write
 * itself is followed to a real row in `smoke-event-discovery-store`. The recorder stub is not
 * optional: this script has no `_env` preamble, so reaching the real one would write to
 * whatever `DATABASE_URL` points at when it is run by hand.
 *
 * This path reads a user's mail under a Google RESTRICTED scope, so the assertions that matter
 * most are the refusals:
 *
 *   - A forged `From: lu.ma` must not get a link fetched. Anyone can send the user an email;
 *     `Authentication-Results` is added by Google on receipt and cannot be.
 *   - Only known platform hosts are followed, even inside a genuine, signed Luma email — a
 *     tracking redirector or an unsubscribe footer is not an event.
 *   - Nothing but a subject, a sender domain and a date is ever kept.
 */
import {
  buildEventMailQuery,
  classifyEventMail,
  domainOf,
  scanGmailForEvents,
  senderIsAuthentic,
  EVENT_MAIL_SENDERS,
} from "../src/lib/events/discovery/from-gmail";
import type { GmailScanDeps } from "../src/lib/events/discovery/from-gmail";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const DKIM_OK = "mx.google.com; dkim=pass header.d=lu.ma; spf=pass";
const DKIM_FAIL = "mx.google.com; dkim=fail header.d=lu.ma; spf=softfail";

/** Every candidate a scan tried to write, captured instead of written. No database here. */
const recorded: Array<{ url: string | null }> = [];

function deps(over: Partial<GmailScanDeps> = {}): GmailScanDeps {
  return {
    record: async (_userId, candidates) => {
      recorded.push(...candidates.map((c) => ({ url: c.url })));
      return { created: candidates.length, attached: 0, suppressed: 0, enrichQueued: 0, notAttending: 0 };
    },
    listPage: async () => ({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: null }),
    headers: async () => [
      {
        id: "m1",
        threadId: "t1",
        from: "Luma <invites@lu.ma>",
        subject: "You're in: AI Tinkerers SF",
        snippet: "",
        internalDate: Date.parse("2026-06-01T00:00:00Z"),
        to: "",
        listUnsubscribe: "",
        listId: "",
        precedence: "",
      },
    ],
    links: async () => [
      {
        id: "m1",
        threadId: "t1",
        from: "Luma <invites@lu.ma>",
        subject: "You're in: AI Tinkerers SF",
        snippet: "",
        internalDate: Date.parse("2026-06-01T00:00:00Z"),
        to: "",
        listUnsubscribe: "",
        listId: "",
        precedence: "",
        authenticationResults: DKIM_OK,
        links: [
          "https://click.luma-mail.com/track/abc",
          "https://lu.ma/ai-tinkerers?tk=GUESTTOKEN",
          "https://lu.ma/unsubscribe",
        ],
      },
    ],
    ...over,
  };
}

async function main() {
  console.log("\nthe query never leaves the platforms");
  {
    const query = buildEventMailQuery(1_700_000_000);
    check("every sender domain is named", EVENT_MAIL_SENDERS.every((d) => query.includes(`from:${d}`)), query);
    check("and bounded by date", query.includes("after:1700000000"));
    // Nothing else in the mailbox is ever even listed, let alone opened.
    check("nothing else is listed", /^\(from:[^)]+\) after:\d+$/.test(query), query);
  }

  console.log("\nsender authenticity");
  {
    check("a passing DKIM for the sender's own domain", senderIsAuthentic(DKIM_OK, "lu.ma"));
    check("a failing one is refused", !senderIsAuthentic(DKIM_FAIL, "lu.ma"));
    check("no header at all is refused", !senderIsAuthentic("", "lu.ma"));
    // A message can carry several DKIM results; only the SENDER's own signature counts.
    check(
      "a mailing list's signature does not vouch for the sender",
      !senderIsAuthentic("dkim=pass header.d=relay.example.com", "lu.ma")
    );
    check(
      "a subdomain sender is covered by its parent's signature",
      senderIsAuthentic("dkim=pass header.d=lu.ma", "mail.lu.ma")
    );
    check("the domain is read off the From header", domainOf("Luma <invites@lu.ma>") === "lu.ma");
  }

  console.log("\nsubject classification");
  {
    check("a registration confirmation", classifyEventMail("x@lu.ma", "You're in: AI Tinkerers")?.rsvpHint === "going");
    check("a waitlist notice", classifyEventMail("x@lu.ma", "You're on the waitlist")?.rsvpHint === "waitlist");
    check("a cancellation", classifyEventMail("x@partiful.com", "Rooftop Dinner was cancelled")?.rsvpHint === "cancelled");
    // A host notification is evidence the user RUNS this one.
    check("a host notification", classifyEventMail("x@lu.ma", "New registration for your event")?.roleHint === "hosted");
    check("an ordinary sender is not classified at all", classifyEventMail("jane@example.com", "You're in!") === null);
    // Unknown is fine: `attended` is the right default far more often than not.
    check("an unrecognised subject still counts as attending", classifyEventMail("x@lu.ma", "Hello")?.rsvpHint === null);
  }

  console.log("\na genuine confirmation");
  {
    recorded.length = 0;
    await scanGmailForEvents("user-1", "token", null, {
      deps: deps(),
      now: new Date("2026-06-02T00:00:00Z"),
    });
    // The event link survives; the tracker and the unsubscribe footer beside it do not.
    check("exactly one event is found", recorded.length === 1, JSON.stringify(recorded));
    check("the guest token is stripped from it", recorded[0]?.url === "https://lu.ma/ai-tinkerers", String(recorded[0]?.url));
  }

  console.log("\nwhat a forged sender gets");
  {
    const result = await scanGmailForEvents("user-1", "token", null, {
      deps: deps({
        links: async () => [
          {
            id: "m1",
            threadId: "t1",
            from: "Luma <invites@lu.ma>",
            subject: "You're in: Free Money",
            snippet: "",
            internalDate: null,
            to: "",
            listUnsubscribe: "",
            listId: "",
            precedence: "",
            authenticationResults: DKIM_FAIL,
            links: ["https://lu.ma/evil"],
          },
        ],
      }),
      now: new Date("2026-06-02T00:00:00Z"),
    });
    check("the message is counted as unauthenticated", result.unauthenticated === 1, String(result.unauthenticated));
    check("and nothing is recorded from it", result.stats.created === 0);
  }

  console.log("\nwhat a genuine email full of other links gets");
  {
    // Every link here is in a real, signed Luma email. Only one of them is an event.
    const result = await scanGmailForEvents("user-1", "token", null, {
      deps: deps({
        links: async () => [
          {
            id: "m1",
            threadId: "t1",
            from: "Luma <invites@lu.ma>",
            subject: "You're in",
            snippet: "",
            internalDate: null,
            to: "",
            listUnsubscribe: "",
            listId: "",
            precedence: "",
            authenticationResults: DKIM_OK,
            links: [
              "https://click.luma-mail.com/track/xyz",
              "https://zoom.us/j/123",
              "https://lu.ma/unsubscribe",
              "https://maps.google.com/?q=Shack15",
            ],
          },
        ],
      }),
      now: new Date("2026-06-02T00:00:00Z"),
    });
    check("no event is invented from a tracker, a map or an unsubscribe link", result.stats.created === 0, JSON.stringify(recorded));
    check("the message was still opened", result.opened === 1);
  }

  console.log("\nthe cursor");
  {
    const midListing = await scanGmailForEvents("user-1", "token", null, {
      deps: deps({
        listPage: async () => ({ messages: [], nextPageToken: "page-2" }),
      }),
      now: new Date("2026-06-02T00:00:00Z"),
    });
    // Mid-listing, the position is kept so the next pass resumes rather than restarting a year.
    check("a page token is carried forward", midListing.cursor.pageToken === "page-2");

    const finished = await scanGmailForEvents("user-1", "token", null, {
      deps: deps({ listPage: async () => ({ messages: [], nextPageToken: null }) }),
      now: new Date("2026-06-02T00:00:00Z"),
    });
    check("a finished listing clears the token", finished.cursor.pageToken === null);
    // Next time, start from today rather than a year ago — with a day of overlap, because
    // Gmail's `after:` is date-granular.
    const expected = Math.floor(Date.parse("2026-06-02T00:00:00Z") / 1000) - 86_400;
    check("and moves the window forward", finished.cursor.after === expected, String(finished.cursor.after));
  }

  console.log(
    failures === 0 ? "\nAll Gmail event-scan checks passed\n" : `\n${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

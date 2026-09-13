/**
 * Resolving a pasted ticket link to the event's public page.
 *
 * The load-bearing assertion in this file is not any individual rewrite — platforms change
 * their URL schemes and these rules will go stale. It is that the user's own URL is ALWAYS
 * among the candidates. That invariant is what makes a stale rule cost one wasted request
 * instead of a broken link, and it is the reason `canonicalizeEventUrl` returns a list at
 * all. If a future edit makes a rewrite replace the original rather than precede it, the
 * "original always survives" checks below are what will catch it.
 *
 * The second load-bearing case is the leak: a Luma invite carries the recipient's own `tk`
 * guest token, and that token used to be written into `events.url` and rendered back as a
 * link on the event page.
 */
import { canonicalizeEventUrl, type CanonicalOutcome } from "../src/lib/events/canonical-url";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function ok(outcome: CanonicalOutcome): { candidates: string[]; rewritten: boolean } {
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome;
}

function main() {
  console.log("\nRewrites propose a public page and keep the original");
  {
    const r = ok(canonicalizeEventUrl("https://www.eventbrite.com/x/founder-mixer-tickets-12345"));
    check(
      "eventbrite /x/ proposes /e/ first",
      r.candidates[0] === "https://www.eventbrite.com/e/founder-mixer-tickets-12345",
      r.candidates[0]
    );
    check(
      "the pasted URL survives as fallback",
      r.candidates.includes("https://www.eventbrite.com/x/founder-mixer-tickets-12345"),
      r.candidates.join(" , ")
    );
  }
  {
    const r = ok(canonicalizeEventUrl("https://www.eventbrite.co.uk/myevent?eid=99887766"));
    check(
      "eventbrite ccTLD + eid rewrites to /e/<id>",
      r.candidates[0] === "https://www.eventbrite.co.uk/e/99887766",
      r.candidates[0]
    );
  }
  {
    const r = ok(canonicalizeEventUrl("https://www.meetup.com/sf-ai/events/301234567/attendees"));
    check(
      "meetup sub-tab trims to the event",
      r.candidates[0] === "https://www.meetup.com/sf-ai/events/301234567/",
      r.candidates[0]
    );
  }

  console.log("\nStripping");
  {
    const r = ok(canonicalizeEventUrl("https://lu.ma/ai-tinkerers?tk=SECRET123"));
    check("luma guest token removed", !r.candidates.join(" ").includes("SECRET123"));
    check("and nothing else survives it", r.candidates[0] === "https://lu.ma/ai-tinkerers", r.candidates[0]);
  }
  {
    // Luma now serves luma.com and redirects lu.ma to it, so a link copied today has the
    // long domain. Covering only the short one left the token on the common case.
    const r = ok(canonicalizeEventUrl("https://luma.com/ai-tinkerers?tk=SECRET123&pk=SECRET456"));
    check("the luma.com domain is covered too", r.candidates[0] === "https://luma.com/ai-tinkerers", r.candidates[0]);
  }
  {
    const r = ok(
      canonicalizeEventUrl(
        "https://partiful.com/e/abc123?utm_source=sms&utm_campaign=x&fbclid=zz&aff=friend"
      )
    );
    check("tracking params removed", r.candidates[0] === "https://partiful.com/e/abc123", r.candidates[0]);
  }
  {
    // The failure this guards: stripping an event's identity turns a good link into a 404.
    const r = ok(canonicalizeEventUrl("https://example.com/show?eid=42&id=7&utm_source=news"));
    const first = r.candidates[0]!;
    check("event-identifying params kept", first.includes("eid=42") && first.includes("id=7"), first);
    check("while tracking beside them goes", !first.includes("utm_source"), first);
  }
  {
    const r = ok(canonicalizeEventUrl("https://dice.fm/event/rooftop-thing"));
    check("a clean public link is left alone", r.candidates.length === 1, r.candidates.join(" , "));
    check("and is not marked rewritten", r.rewritten === false);
  }

  console.log("\nOrder pages are a dead end, and say so");
  for (const url of [
    "https://www.eventbrite.com/orders/1234567890",
    "https://my.ticketmaster.com/orders/abc",
    "https://my.axs.com/orders",
  ]) {
    const outcome = canonicalizeEventUrl(url);
    check(`private: ${new URL(url).hostname}`, outcome.kind === "private", outcome.kind);
  }
  {
    // The near-miss: a public Ticketmaster event page must NOT be swept up by the rule above.
    const outcome = canonicalizeEventUrl("https://www.ticketmaster.com/event/0E005F1234ABCD");
    check("a public ticketmaster event page is still fetched", outcome.kind === "ok", outcome.kind);
  }

  console.log("\nInput shapes");
  {
    const r = ok(canonicalizeEventUrl("  lu.ma/abc123  "));
    check("scheme-less paste is read as https", r.candidates[0] === "https://lu.ma/abc123", r.candidates[0]);
  }
  {
    const r = ok(canonicalizeEventUrl("http://lu.ma/abc123"));
    check("http is upgraded", r.candidates[0] === "https://lu.ma/abc123", r.candidates[0]);
  }
  {
    // "notlu.ma" must not match "lu.ma" — a substring check here would strip a stranger's param.
    const r = ok(canonicalizeEventUrl("https://notlu.ma/x?tk=KEEP"));
    check("host matching is not substring-based", r.candidates[0]!.includes("tk=KEEP"), r.candidates[0]);
  }
  for (const bad of ["", "   ", "not a link", "javascript:alert(1)"]) {
    const outcome = canonicalizeEventUrl(bad);
    check(`rejected: ${JSON.stringify(bad)}`, outcome.kind === "invalid", outcome.kind);
  }

  console.log(
    failures === 0 ? "\nAll canonical-url checks passed\n" : `\n${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();

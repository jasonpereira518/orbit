/**
 * Guards the webmail deep links behind the LinkedIn reminder's "find the email" button.
 *
 * These URLs are the one step of the deferred-LinkedIn flow Orbit cannot verify at
 * runtime — a wrong host or an unencoded query silently drops the user in an empty
 * inbox a day after they asked for the export, which is exactly when giving up costs
 * the most. Pure string work: no DB, no network.
 *
 * Run: npx tsx scripts/smoke-inbox-search.ts
 */
import {
  LINKEDIN_ARCHIVE_SEARCH,
  inboxProviderFor,
  inboxSearchLabel,
  inboxSearchUrl,
  linkedInArchiveSearch,
} from "../src/lib/inbox-search";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  console.log("Inbox search deep links…");

  console.log("\nprovider routing");
  check("gmail.com -> gmail", inboxProviderFor("a@gmail.com") === "gmail");
  check("outlook.com -> outlook", inboxProviderFor("a@outlook.com") === "outlook");
  check("hotmail.com -> outlook", inboxProviderFor("a@hotmail.com") === "outlook");
  check("live.com -> outlook", inboxProviderFor("a@live.com") === "outlook");
  check("msn.com -> outlook", inboxProviderFor("a@msn.com") === "outlook");
  check(
    "case and whitespace are ignored",
    inboxProviderFor("  A@OutLook.Com  ") === "outlook"
  );
  check("a university domain falls back to gmail", inboxProviderFor("s@unc.edu") === "gmail");
  check("unknown address falls back to gmail", inboxProviderFor(null) === "gmail");
  check("empty string falls back to gmail", inboxProviderFor("") === "gmail");
  check("an address with no @ falls back to gmail", inboxProviderFor("nonsense") === "gmail");
  check(
    "a lookalike subdomain is NOT Microsoft",
    inboxProviderFor("a@notoutlook.com") === "gmail",
    inboxProviderFor("a@notoutlook.com")
  );

  console.log("\nurl shape");
  const gmail = inboxSearchUrl(LINKEDIN_ARCHIVE_SEARCH, "s@unc.edu");
  const outlook = inboxSearchUrl(LINKEDIN_ARCHIVE_SEARCH, "s@outlook.com");

  check(
    "gmail keeps the search in the fragment",
    gmail.startsWith("https://mail.google.com/mail/u/0/#search/"),
    gmail
  );
  check(
    "outlook uses the consumer host and the deeplink path",
    outlook.startsWith("https://outlook.live.com/mail/0/deeplink/search?query="),
    outlook
  );
  for (const [name, url] of [["gmail", gmail], ["outlook", outlook]] as const) {
    // A raw space or colon here is what silently truncates the query in one client or
    // the other, so both have to survive a real URL parse unchanged.
    check(`${name} url has no raw spaces`, !url.includes(" "), url);
    check(
      `${name} url encodes the colon in "from:"`,
      url.includes("from%3Alinkedin.com"),
      url
    );
    check(`${name} url parses`, Boolean(new URL(url)), url);
  }
  check(
    "gmail fragment decodes back to the exact query",
    decodeURIComponent(new URL(gmail).hash.replace("#search/", "")) ===
      LINKEDIN_ARCHIVE_SEARCH
  );
  check(
    "outlook query param decodes back to the exact query",
    new URL(outlook).searchParams.get("query") === LINKEDIN_ARCHIVE_SEARCH
  );

  console.log("\nthe query itself");
  // Matched against the real mail: LinkedIn <messages-noreply@linkedin.com>,
  // "Your full LinkedIn data archive is ready!", sent in parts.
  check(
    "matches the sending domain, not one no-reply address",
    LINKEDIN_ARCHIVE_SEARCH.includes("from:linkedin.com") &&
      !LINKEDIN_ARCHIVE_SEARCH.includes("messages-noreply"),
    LINKEDIN_ARCHIVE_SEARCH
  );
  check(
    "narrows on a word every part of the archive mail carries",
    LINKEDIN_ARCHIVE_SEARCH.includes("archive"),
    LINKEDIN_ARCHIVE_SEARCH
  );

  console.log("\nresolved link");
  const resolved = linkedInArchiveSearch("s@gmail.com");
  check("carries url, label and raw terms", Boolean(resolved.url && resolved.label && resolved.query));
  check("label names the provider it opens", resolved.label === "Search Gmail", resolved.label);
  check(
    "outlook label names Outlook",
    inboxSearchLabel("s@hotmail.com") === "Search Outlook"
  );
  check(
    "raw terms are the same string the reminder body quotes",
    resolved.query === LINKEDIN_ARCHIVE_SEARCH
  );

  console.log("\nAll inbox search checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}

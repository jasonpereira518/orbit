/**
 * The Microsoft contacts connector: mapping, paging, and the watermark rules.
 *
 * The rules that matter are the two a sync gets silently wrong. The watermark must be adopted
 * only when a run has read every page (adopting it early skips whatever was on the pages not
 * yet read, forever), and it must be dated from when the read STARTED, not when its last page
 * arrived, or a long first read loses whatever changed while it was paging.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import {
  advanceContactsCursor,
  ContactsFilterRejectedError,
  fetchContactsPage,
  toPersonRecord,
  WATERMARK_OVERLAP_MS,
  type MicrosoftContactsCursor,
} from "../src/lib/connectors/microsoft-contacts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

run(async () => {
  console.log("mapping");
  const ada = toPersonRecord({
    displayName: "Ada Lovelace",
    companyName: "Analytical",
    jobTitle: "Mathematician",
    emailAddresses: [{ address: " " }, { address: "ada@example.com" }],
    businessPhones: ["", "+44 1"],
    mobilePhone: "+44 2",
  });
  check("name, company and title map", ada?.fullName === "Ada Lovelace" && ada?.company === "Analytical" && ada?.title === "Mathematician");
  check("the first NON-BLANK email is used", ada?.email === "ada@example.com", String(ada?.email));
  check("a business phone beats the mobile", ada?.phone === "+44 1", String(ada?.phone));
  check(
    "no displayName falls back to given + surname",
    toPersonRecord({ givenName: "Grace", surname: "Hopper" })?.fullName === "Grace Hopper"
  );
  check("no name at all is dropped, not invented for", toPersonRecord({ emailAddresses: [{ address: "x@y.z" }] }) === null);

  console.log("\nthe request");
  const urls: string[] = [];
  const empty = async (url: string | URL | Request) => {
    urls.push(String(url));
    return jsonResponse({ value: [] });
  };
  await fetchContactsPage({ accessToken: "t", cursor: null, fetchImpl: empty as typeof fetch });
  check("a first read has no filter", !urls[0].includes("$filter"), urls[0]);
  check("and uses the literal $top/$select form", urls[0].includes("?$top=200&$select="), urls[0]);

  await fetchContactsPage({
    accessToken: "t",
    cursor: { syncToken: "2026-09-29T11:55:00.000Z" },
    fetchImpl: empty as typeof fetch,
  });
  check(
    "an incremental read filters on the watermark",
    urls[1].includes("$filter=lastModifiedDateTime%20ge%202026-09-29T11%3A55%3A00.000Z"),
    urls[1]
  );

  const nextLink = "https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=abc";
  await fetchContactsPage({
    accessToken: "t",
    cursor: { syncToken: "2026-09-29T11:55:00.000Z", pageToken: nextLink },
    fetchImpl: empty as typeof fetch,
  });
  check("mid-run it follows the nextLink verbatim", urls[2] === nextLink, urls[2]);

  console.log("\nfailure handling");
  let rejected: unknown = null;
  try {
    await fetchContactsPage({
      accessToken: "t",
      cursor: { syncToken: "2026-09-29T11:55:00.000Z" },
      fetchImpl: (async () => new Response("bad filter", { status: 400 })) as typeof fetch,
    });
  } catch (err) {
    rejected = err;
  }
  check("a 400 on a filtered read is the recoverable filter error", rejected instanceof ContactsFilterRejectedError);

  let plain400: unknown = null;
  try {
    await fetchContactsPage({
      accessToken: "t",
      cursor: null,
      fetchImpl: (async () => new Response("bad", { status: 400 })) as typeof fetch,
    });
  } catch (err) {
    plain400 = err;
  }
  check(
    "a 400 on an UNFILTERED read is a plain failure (there is nothing to drop)",
    plain400 instanceof Error && !(plain400 instanceof ContactsFilterRejectedError)
  );

  console.log("\nthe watermark");
  const t0 = new Date("2026-09-29T12:00:00.000Z");
  const later = new Date("2026-09-29T12:20:00.000Z");
  const morePages = { people: [], nextPageToken: "next", nameless: 0 };
  const lastPage = { people: [], nextPageToken: null, nameless: 0 };

  const afterFirst = advanceContactsCursor(null, morePages, t0);
  check("mid-run keeps the page token", afterFirst.pageToken === "next");
  check("mid-run does NOT adopt a watermark", (afterFirst.syncToken ?? null) === null);
  check("mid-run stamps when the read started", afterFirst.readStartedAt === t0.toISOString());

  const finished = advanceContactsCursor(afterFirst, lastPage, later);
  check(
    "the watermark is dated from the START of the read, minus the overlap",
    finished.syncToken === new Date(t0.getTime() - WATERMARK_OVERLAP_MS).toISOString(),
    String(finished.syncToken)
  );
  check("finishing clears the run state", finished.pageToken === null && finished.readStartedAt === null);

  const single = advanceContactsCursor(null, lastPage, t0);
  check(
    "a one-page book still gets a watermark",
    single.syncToken === new Date(t0.getTime() - WATERMARK_OVERLAP_MS).toISOString()
  );

  const carry: MicrosoftContactsCursor = { syncToken: "old", pageToken: null };
  const carried = advanceContactsCursor(carry, morePages, t0);
  check("an incremental run in progress keeps the previous watermark until it finishes", carried.syncToken === "old");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Microsoft contacts checks passed.");
});

/**
 * The Google Contacts connector's mapping and cursor rules.
 *
 * Pure tier: the connector issues no database statement, so every check here runs against a
 * stubbed `fetch` and no database at all. The properties that matter are the three ways an
 * incremental People sync goes wrong silently — adopting `nextSyncToken` before the last
 * page, sending a `syncToken` alongside the parameters that belong to a first full read, and
 * treating an expired token as a fault. None of them surfaces in manual testing until
 * contacts have already been skipped.
 */
import {
  PeopleSyncTokenExpiredError,
  advanceContactsCursor,
  fetchContactsPage,
  toPersonRecord,
} from "../src/lib/connectors/google-contacts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A stub that records the URL it was called with, so we can assert on query parameters. */
function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ADA = {
  resourceName: "people/c1",
  names: [{ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" }],
  emailAddresses: [
    { value: "work@example.com" },
    { value: "ada@example.com", metadata: { primary: true } },
  ],
  organizations: [{ name: "Analytical Engines", title: "Mathematician" }],
  phoneNumbers: [{ value: "+15550000001", metadata: { primary: true } }],
};

async function main() {
  console.log("mapping");
  const ada = toPersonRecord(ADA);
  check("a person maps to a record", ada?.fullName === "Ada Lovelace");
  check("the PRIMARY email wins, not the first", ada?.email === "ada@example.com", String(ada?.email));
  check("company and title come from the organization", ada?.company === "Analytical Engines" && ada?.title === "Mathematician");
  check("the primary phone is carried", ada?.phone === "+15550000001");

  check(
    "a displayName-less person falls back to given + family",
    toPersonRecord({ names: [{ givenName: "Grace", familyName: "Hopper" }] })?.fullName === "Grace Hopper"
  );
  check(
    "a person with an email but NO name is refused",
    toPersonRecord({ emailAddresses: [{ value: "nobody@example.com" }] }) === null
  );

  console.log("\nthe first read asks for a sync token; a delta does not repeat it");
  {
    const { impl, calls } = stubFetch({ connections: [ADA], nextSyncToken: "tok-1" });
    await fetchContactsPage({ accessToken: "at", cursor: null, fetchImpl: impl });
    check("first read requests a syncToken", calls[0].includes("requestSyncToken=true"));
    check("first read sends no syncToken", !calls[0].includes("syncToken=tok"));
  }
  {
    const { impl, calls } = stubFetch({ connections: [], nextSyncToken: "tok-2" });
    await fetchContactsPage({ accessToken: "at", cursor: { syncToken: "tok-1" }, fetchImpl: impl });
    check("a delta sends the stored syncToken", calls[0].includes("syncToken=tok-1"));
    check(
      "a delta does NOT also ask for a fresh one (400 FAILED_PRECONDITION)",
      !calls[0].includes("requestSyncToken=true")
    );
  }

  console.log("\ntombstones and nameless entries are counted, not ingested");
  {
    const { impl } = stubFetch({
      connections: [ADA, { resourceName: "people/c2", metadata: { deleted: true } }, { resourceName: "people/c3" }],
      nextSyncToken: "tok-3",
    });
    const page = await fetchContactsPage({ accessToken: "at", cursor: null, fetchImpl: impl });
    check("only the real person is returned", page.people.length === 1);
    check("the deleted person is counted", page.tombstones === 1);
    check("the nameless person is counted", page.nameless === 1);
  }

  console.log("\nthe syncToken is adopted only on the LAST page");
  {
    const mid = { people: [], nextSyncToken: null, nextPageToken: "page-2", tombstones: 0, nameless: 0 };
    const advanced = advanceContactsCursor({ syncToken: "old" }, mid);
    check("a mid-run page keeps the old syncToken", advanced.syncToken === "old");
    check("a mid-run page carries the pageToken forward", advanced.pageToken === "page-2");

    const last = { people: [], nextSyncToken: "fresh", nextPageToken: null, tombstones: 0, nameless: 0 };
    const done = advanceContactsCursor({ syncToken: "old", pageToken: "page-2" }, last);
    check("the last page adopts the fresh syncToken", done.syncToken === "fresh");
    check("the last page clears the pageToken", done.pageToken === null);
  }

  console.log("\nan expired token is a lifecycle event, not a failure");
  {
    const { impl } = stubFetch({ error: "expired" }, 410);
    let threw: unknown = null;
    try {
      await fetchContactsPage({ accessToken: "at", cursor: { syncToken: "stale" }, fetchImpl: impl });
    } catch (err) {
      threw = err;
    }
    check("410 raises PeopleSyncTokenExpiredError", threw instanceof PeopleSyncTokenExpiredError);
  }

  console.log("\na page token survives a budget stop");
  {
    const { impl, calls } = stubFetch({ connections: [], nextSyncToken: "t" });
    await fetchContactsPage({ accessToken: "at", cursor: { syncToken: "tok-1", pageToken: "page-7" }, fetchImpl: impl });
    check("the pageToken is sent", calls[0].includes("pageToken=page-7"));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Google Contacts connector checks passed.");
  process.exit(0);
}

void main();

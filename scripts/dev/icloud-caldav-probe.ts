/**
 * What iCloud's CalDAV server actually supports — the spike behind Task 1 of
 * `docs/superpowers/plans/2026-09-22-calendar-connections.md`.
 *
 * Two assumptions in `src/lib/caldav/client.ts` are unverified against Apple, and one of them
 * is load-bearing for the whole fallback path:
 *
 *   1. `sync-collection` (RFC 6578) is offered on iCloud calendars, and returns a `sync-token`.
 *      If it is not, every calendar falls back to a ctag + full time-range query each pass.
 *   2. `getctag` changes on every edit. If it does not, the ctag short-circuit silently skips a
 *      query and the edit is never seen — no error anywhere. This is the one that can lose data.
 *
 * Plus two smaller ones: whether server-side `<expand>` works (we expand locally regardless,
 * because ICS feeds need it), and how shared or subscribed calendars are marked, which is what
 * decides a calendar's default enabled/disabled state in the picker.
 *
 * Credentials come from the environment and are never written to the output. Generate an
 * app-specific password at https://appleid.apple.com (Sign-In and Security → App-Specific
 * Passwords); iCloud will not accept an account password over CalDAV with 2FA on.
 *
 *   APPLE_ID='you@icloud.com' APPLE_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' \
 *     npx tsx scripts/dev/icloud-caldav-probe.ts
 *
 * Writes `docs/superpowers/specs/2026-09-22-icloud-caldav-findings.md`, redacted: calendar names,
 * event summaries, attendee addresses and URL path segments are replaced before anything is
 * written, so the file is safe to commit and to paste into a conversation. Revoke the
 * app-specific password afterwards if you like — nothing here stores it.
 */
import {
  CalDavAuthError,
  CalDavRejectedError,
  CalDavStaleSyncTokenError,
  davRequest,
  type CalDavCredentials,
} from "../../src/lib/caldav/client";

const APPLE_ID = process.env.APPLE_ID;
const APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

const OUT = "docs/superpowers/specs/2026-09-22-icloud-caldav-findings.md";
const ROOT = "https://caldav.icloud.com";

if (!APPLE_ID || !APP_PASSWORD) {
  console.error(
    "Set APPLE_ID and APPLE_APP_PASSWORD, e.g.\n" +
      "  APPLE_ID='you@icloud.com' APPLE_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' npx tsx scripts/dev/icloud-caldav-probe.ts\n\n" +
      "Generate the app-specific password at https://appleid.apple.com — an account password will not work."
  );
  process.exit(1);
}

const creds: CalDavCredentials = { username: APPLE_ID, password: APP_PASSWORD };

/**
 * Everything that reaches the report goes through here first.
 *
 * Deliberately aggressive: the point of the file is the SHAPE of Apple's responses — which
 * elements come back, with which status — not their contents. Anything that could be a person,
 * a meeting or an account id is replaced rather than trimmed.
 */
function redact(xml: string): string {
  return xml
    .replace(/(<[^>]*displayname[^>]*>)[^<]*(<)/gi, "$1«name»$2")
    .replace(/(<[^>]*summary[^>]*>)[^<]*(<)/gi, "$1«summary»$2")
    .replace(/SUMMARY:[^\r\n]*/gi, "SUMMARY:«summary»")
    .replace(/DESCRIPTION:[^\r\n]*/gi, "DESCRIPTION:«description»")
    .replace(/LOCATION:[^\r\n]*/gi, "LOCATION:«location»")
    .replace(/ATTENDEE[^:\r\n]*:[^\r\n]*/gi, "ATTENDEE:«attendee»")
    .replace(/ORGANIZER[^:\r\n]*:[^\r\n]*/gi, "ORGANIZER:«organizer»")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "«email»")
    // Path segments under the host carry the numeric account id and per-calendar guids.
    .replace(/(caldav\.icloud\.com)(\/[^\s"'<]*)/gi, "$1/«path»")
    .replace(/(<href[^>]*>)\/[^<]*(<)/gi, "$1/«path»$2")
    .replace(new RegExp(APPLE_ID!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "«apple-id»");
}

function firstTag(xml: string, local: string): string | null {
  const m = new RegExp(`<[^>]*\\b${local}\\b[^>]*>([\\s\\S]*?)<\\/[^>]*\\b${local}\\b>`, "i").exec(xml);
  return m ? m[1]!.trim() : null;
}

function hasTag(xml: string, local: string): boolean {
  return new RegExp(`<[^>]*\\b${local}\\b`, "i").test(xml);
}

/**
 * Goes through `davRequest` — the client's own transport — rather than a private `fetch`.
 *
 * This used to be a bare `fetch(url, { headers: { Authorization }, redirect: "follow" })`, and
 * that is not a smaller version of the client, it is a broken one. `.well-known/caldav`
 * redirects to a shard host (`p42-caldav.icloud.com` and the like); that is a cross-origin
 * hop, and the Fetch standard requires `Authorization` to be stripped across one. So the
 * followed request arrived with no credential, Apple answered 401, and the report below
 * concluded the app-specific password had been rejected — which was false, and cost a real
 * investigation. `davRequest` keeps `redirect: "manual"` and re-attaches the credential per
 * hop after re-checking the host pin, which is the whole reason it exists.
 *
 * `davRequest` throws where a status would have been returned, so the mapping back to a status
 * is here: the report's value is the SHAPE of what Apple sends, and a status is part of that.
 */
async function dav(
  method: "PROPFIND" | "REPORT",
  url: string,
  body: string,
  depth: "0" | "1" = "0"
): Promise<{ status: number; finalUrl: string; text: string }> {
  try {
    const res = await davRequest(creds, url, method, depth, body, fetch);
    return { status: 207, finalUrl: res.url, text: res.text };
  } catch (err) {
    if (err instanceof CalDavAuthError) {
      return { status: 401, finalUrl: url, text: `<!-- ${err.message} -->` };
    }
    if (err instanceof CalDavStaleSyncTokenError) {
      return { status: 409, finalUrl: url, text: `<!-- ${err.message} -->` };
    }
    if (err instanceof CalDavRejectedError) {
      return { status: err.status, finalUrl: url, text: `<!-- ${err.message} -->` };
    }
    throw err;
  }
}

const PROPFIND_PRINCIPAL = `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const PROPFIND_HOME = `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const PROPFIND_CALENDARS = `<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/><cs:getctag/><d:sync-token/><ic:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>`;
const REPORT_SYNC = `<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;

function isoCompact(d: Date) {
  return `${d.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function reportExpand(from: Date, to: Date) {
  return `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="${isoCompact(from)}" end="${isoCompact(to)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${isoCompact(from)}" end="${isoCompact(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

async function main() {
  const lines: string[] = [];
  const say = (s = "") => {
    lines.push(s);
    console.log(s);
  };

  say("# What iCloud CalDAV actually supports");
  say();
  say(`Measured: ${new Date().toISOString()}`);
  say();
  say(
    "Run by Jason against his own iCloud account with `scripts/dev/icloud-caldav-probe.ts`. " +
      "Every response below is redacted by that script before it is written: calendar names, " +
      "summaries, addresses and URL path segments are replaced. No credential appears here."
  );
  say();

  // 1. Principal ------------------------------------------------------------------------
  say("## 1. Principal discovery");
  say();
  const principal = await dav("PROPFIND", `${ROOT}/.well-known/caldav`, PROPFIND_PRINCIPAL);
  say(`- \`PROPFIND /.well-known/caldav\` → **${principal.status}**`);
  const principalHref = firstTag(principal.text, "current-user-principal");
  const principalUrl = principalHref ? /<[^>]*href[^>]*>([^<]+)</i.exec(principalHref)?.[1] : null;
  say(`- \`current-user-principal\` returned: **${principalUrl ? "yes" : "NO"}**`);
  if (!principalUrl) {
    say();
    say("```xml");
    say(redact(principal.text).slice(0, 1200));
    say("```");
    say();
    say(
      `**Discovery failed — nothing below could run.** Status was ${principal.status}. ` +
        "A 401 here is Apple refusing the credential this probe presented: either the " +
        "app-specific password is wrong or revoked, or `APPLE_ID` is not the address the " +
        "password belongs to. It no longer means the request arrived without a credential — " +
        "this probe goes through the client's own `davRequest`, which re-attaches it on every " +
        "redirect hop. Anything other than 401 is Apple refusing the request itself, not the " +
        "sign-in."
    );
    await finish(lines);
    return;
  }

  // 2. Calendar home --------------------------------------------------------------------
  const principalAbs = new URL(principalUrl, ROOT).href;
  const home = await dav("PROPFIND", principalAbs, PROPFIND_HOME);
  const homeHref = firstTag(home.text, "calendar-home-set");
  const homeUrl = homeHref ? /<[^>]*href[^>]*>([^<]+)</i.exec(homeHref)?.[1] : null;
  say(`- \`calendar-home-set\` returned: **${homeUrl ? "yes" : "NO"}** (status ${home.status})`);
  say();
  if (!homeUrl) {
    say("**No calendar home — stopping.**");
    await finish(lines);
    return;
  }

  // 3. Calendar list --------------------------------------------------------------------
  say("## 2. Calendars, and how shared/subscribed ones are marked");
  say();
  const homeAbs = new URL(homeUrl, ROOT).href;
  const list = await dav("PROPFIND", homeAbs, PROPFIND_CALENDARS, "1");
  say(`- \`PROPFIND\` calendar home, Depth 1 → **${list.status}**`);

  const responses = list.text.split(/<[^>]*\bresponse\b[^>]*>/i).slice(1);
  const calendars: Array<{ href: string; ctag: string | null; syncToken: boolean; subscribed: boolean; readOnlyPriv: boolean }> = [];
  for (const chunk of responses) {
    if (!hasTag(chunk, "calendar")) continue;
    const href = /<[^>]*href[^>]*>([^<]+)</i.exec(chunk)?.[1];
    if (!href) continue;
    calendars.push({
      href,
      ctag: firstTag(chunk, "getctag"),
      syncToken: hasTag(chunk, "sync-token"),
      subscribed: hasTag(chunk, "subscribed"),
      // No write privilege advertised = the user cannot modify it.
      readOnlyPriv: hasTag(chunk, "current-user-privilege-set") && !/\bwrite\b/i.test(chunk),
    });
  }

  say(`- calendar collections found: **${calendars.length}**`);
  say(`- advertise a \`sync-token\` in PROPFIND: **${calendars.filter((c) => c.syncToken).length}/${calendars.length}**`);
  say(`- advertise a \`getctag\`: **${calendars.filter((c) => c.ctag).length}/${calendars.length}**`);
  say(`- marked \`<subscribed>\` in resourcetype: **${calendars.filter((c) => c.subscribed).length}**`);
  say(`- no write privilege in \`current-user-privilege-set\`: **${calendars.filter((c) => c.readOnlyPriv).length}**`);
  say();
  say(
    "> The client currently derives `readOnly` from the `subscribed` resourcetype alone. If the " +
      "two counts above differ, a calendar shared *with* Jason but not subscribed is being defaulted " +
      "to enabled — `src/lib/caldav/client.ts` should read the privilege set instead."
  );
  say();
  say("One redacted response, for shape:");
  say();
  say("```xml");
  say(redact(responses.find((r) => hasTag(r, "calendar")) ?? "").slice(0, 1500));
  say("```");
  say();

  if (calendars.length === 0) {
    say("**No calendars — stopping.**");
    await finish(lines);
    return;
  }

  // 4. sync-collection ------------------------------------------------------------------
  say("## 3. Does `sync-collection` work? (assumption 1)");
  say();
  const target = new URL(calendars[0]!.href, ROOT).href;
  const sync = await dav("REPORT", target, REPORT_SYNC, "1");
  const token = firstTag(sync.text, "sync-token");
  say(`- \`REPORT sync-collection\` → **${sync.status}**`);
  say(`- returned a \`sync-token\`: **${token ? "yes" : "NO"}**`);
  say(`- **Verdict: WebDAV-Sync is ${sync.status === 207 && token ? "SUPPORTED" : "NOT supported"}**`);
  if (!(sync.status === 207 && token)) {
    say();
    say("```xml");
    say(redact(sync.text).slice(0, 1200));
    say("```");
    say();
    say(
      "> Every calendar then falls back to ctag + a full time-range query each pass. The budget " +
        "numbers in the spec assume the incremental path, so they need revisiting."
    );
  }
  say();

  // 5. ctag semantics -------------------------------------------------------------------
  say("## 4. Does `getctag` change on an edit? (assumption 2 — the load-bearing one)");
  say();
  const before = calendars[0]!.ctag;
  say(`- ctag now: **${before ? "present" : "absent"}**`);
  say();
  say(
    "**This one needs a manual step.** Change something in that calendar — move an event, add one, " +
      "delete one — then re-run this script and compare the ctag line above against the previous run's."
  );
  say();
  say(
    "> If the ctag does NOT change after an edit, the short-circuit in `src/lib/caldav/client.ts` " +
      "skips the query and the edit is never seen, silently. That is the one assumption here that " +
      "can lose data rather than waste work."
  );
  say();

  // 6. Server-side expand ---------------------------------------------------------------
  say("## 5. Does server-side `<expand>` work?");
  say();
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86400000);
  const to = new Date(now.getTime() + 30 * 86400000);
  const expand = await dav("REPORT", target, reportExpand(from, to), "1");
  const expanded = (expand.text.match(/RECURRENCE-ID/gi) ?? []).length;
  const rrules = (expand.text.match(/RRULE/gi) ?? []).length;
  say(`- \`calendar-query\` with \`<expand>\` → **${expand.status}**`);
  say(`- \`RRULE\` lines in the response: **${rrules}** (0 suggests the server expanded them)`);
  say(`- \`RECURRENCE-ID\` lines: **${expanded}**`);
  say(
    `- **Verdict: expand ${expand.status === 207 && rrules === 0 ? "appears to WORK" : "does NOT appear to work — local expansion is the only path"}**`
  );
  say();
  say(
    "> Orbit expands locally regardless, because subscribed ICS feeds need it and have no server " +
      "to ask. This only decides whether the CalDAV path could skip that work."
  );
  say();

  say("## What to do with this");
  say();
  say("- If WebDAV-Sync is **not** supported: revisit the per-pass budget in the spec.");
  say("- If the ctag does **not** move on an edit: the ctag short-circuit must be removed, not tuned.");
  say("- If the subscribed and privilege counts disagree: read the privilege set for `readOnly`.");
  say("- Then replace the synthetic fixtures in `src/lib/caldav/fixtures/` with redacted real ones.");

  await finish(lines);
}

async function finish(lines: string[]) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${lines.join("\n")}\n`, "utf8");
  console.log(`\nWrote ${OUT}`);
  process.exit(0);
}

main().catch((err) => {
  // Never let a thrown error carry the Authorization header or the password into a log.
  console.error(`Probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

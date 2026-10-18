/**
 * The operator's answer to "what does Orbit hold about me?" from someone who is not a user:
 * every place they appear, across every account, without reading anyone's content.
 *
 * Seeds one person into the places a network member lands (a contact in two accounts, an
 * event guest, a calendar guest, an email recipient, the recruiter directory, the waitlist,
 * the shared photo cache) plus a different person, and checks the lookup finds exactly the
 * first — by email and by LinkedIn profile — and reports counts and account ids only.
 *
 * Run: npx tsx scripts/smoke-person-lookup.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { findPersonAcrossAccounts, linkedinSlug } from "../src/lib/person-lookup";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const A = "user_lookup_a";
const B = "user_lookup_b";
const EMAIL = "Priya.Raman@Example.test";
const LINKEDIN = "https://www.linkedin.com/in/priya-raman-123/";

async function main() {
  const db = await getDb();
  const x = (q: ReturnType<typeof sql>) => db.execute(q);

  await x(sql`INSERT INTO contacts (user_id, full_name, email, notes) VALUES
              (${A}, 'Priya Raman', ${EMAIL.toLowerCase()}, 'private note the lookup must not return'),
              (${B}, 'P. Raman', NULL, NULL),
              (${A}, 'Someone Else', 'someone@example.test', NULL)`);
  await x(sql`UPDATE contacts SET linkedin_url = ${LINKEDIN} WHERE user_id = ${B} AND full_name = 'P. Raman'`);
  const [ev] = (await x(sql`INSERT INTO events (user_id, title) VALUES (${A}, 'Demo night') RETURNING id`)).rows as Array<{ id: string }>;
  await x(sql`INSERT INTO event_attendees (event_id, user_id, full_name, email, identity_key) VALUES (${ev.id}::uuid, ${A}, 'Priya Raman', ${EMAIL}, 'k1')`);
  const [src] = (await x(sql`INSERT INTO calendar_sources (user_id, provider, connection_id, calendar_id) VALUES (${B}, 'google', gen_random_uuid(), 'primary') RETURNING id`)).rows as Array<{ id: string }>;
  await x(sql`INSERT INTO calendar_events (user_id, source_id, provider_event_id, start_at, attendees)
              VALUES (${B}, ${src.id}::uuid, 'e1', now(), ${JSON.stringify([{ email: EMAIL.toLowerCase(), name: "Priya" }])}::jsonb)`);
  await x(sql`INSERT INTO recruiters (full_name, name_normalized, email, email_normalized, linkedin_url) VALUES ('Priya Raman', 'priya raman', ${EMAIL}, ${EMAIL.toLowerCase()}, ${LINKEDIN})`);
  await x(sql`INSERT INTO interest_list_signups (email, unsubscribe_token) VALUES (${EMAIL}, 'tok')`);
  await x(sql`INSERT INTO linkedin_avatars (slug, source) VALUES ('priya-raman-123', 'unavatar')`);

  console.log("By email");
  const byEmail = await findPersonAcrossAccounts({ email: EMAIL });
  const tables = byEmail.map((h) => h.table).sort();
  check("finds the contact, event guest, calendar guest, directory and waitlist",
    ["calendar_events", "contacts", "event_attendees", "interest_list_signups", "recruiters"].every((t) => tables.includes(t)), tables.join(","));
  check("does not match someone else", byEmail.find((h) => h.table === "contacts")?.rows === 1);
  check("names the accounts that hold them", JSON.stringify(byEmail.find((h) => h.table === "calendar_events")?.accounts) === JSON.stringify([B]));
  check("global tables carry no account", (byEmail.find((h) => h.table === "interest_list_signups")?.accounts.length ?? -1) === 0);
  check("never returns what a user wrote", !JSON.stringify(byEmail).includes("private note"));

  console.log("\nBy LinkedIn profile");
  check("the slug is read from the URL", linkedinSlug(LINKEDIN) === "priya-raman-123");
  const byProfile = await findPersonAcrossAccounts({ linkedinUrl: LINKEDIN });
  check("finds the contact saved only by profile, in the other account",
    JSON.stringify(byProfile.find((h) => h.table === "contacts")?.accounts) === JSON.stringify([B]));
  check("finds the shared photo cache entry", byProfile.some((h) => h.table === "linkedin_avatars"));

  console.log("\nNo match");
  check("an unknown address finds nothing", (await findPersonAcrossAccounts({ email: "nobody@example.test" })).length === 0);
  let refused = false;
  try {
    await findPersonAcrossAccounts({});
  } catch {
    refused = true;
  }
  check("an empty request is refused", refused);

  if (failures > 0) throw new Error(`${failures} person-lookup check(s) failed`);
  console.log("\nAll person-lookup checks passed.");
}

run(main);

# Email Intelligence People and Ranking (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given an extracted email event, say who in the user's network is on the thread (resolved by email, at read time) and rank the most relevant contacts to reach for it, each with explainable reasons.

**Architecture:** Three small units with no storage and no AI. `resolve.ts` maps email addresses to contacts through `contact_identities` and flags named strangers as "add to Orbit" suggestions. `relevance.ts` is a pure, explainable scorer modelled on `src/lib/events/relevance.ts` (`scoreAttendee`). `rank.ts` sources candidates from three places (people on the thread, contacts at the event's company, a lexical profile search on the role), loads their facts in batched reads, scores them, and returns the top few in a stable order.

**Tech Stack:** Drizzle on Neon-http / PGlite, `tsx` smoke scripts. No route, no schema change, no model call.

**Spec:** `docs/superpowers/specs/2026-09-30-email-intelligence-design.md` (sections 5 and 6). Builds on P1 and P2: the `email_events` table (`people`, `company`, `role`, `kind`, `threadRowId`) and `email_threads.participants`. The consumer is P4 (Radar signals); nothing in this plan is user-visible on its own.

**How this plan was checked.** Before it was written up, the code in Tasks 1-3 and the spec edits in Task 4 were applied to a clean copy of P2's branch, typechecked, linted, and the three new smokes run (94 checks, all green, also in one shared database with the other eight email-intel smokes), along with the manifest check and Task 4's four verification `grep`s. That dry run found and fixed two type defects in earlier drafts: an intersection of incompatible `candidate` types in the relevance smoke's helper, and `seniorityOf` being typed over a weight key (`recruiterAtCareerFair`) the new tables lack. It did **not** exercise the full smoke suite, a build (nothing imports these modules yet), or any live data. Task 4 covers the suite.

## Decisions that differ from the spec

1. **`contact_id` is resolved on read, never stored.** The spec (section 2 and section 5) has `people[].contact_id` set at extraction time and asks for merge handling in `src/lib/contact-merge.ts`. Merge is a reversible operation that records every repointed child row by id and replays them on unmerge; ids inside a JSON column are invisible to that machinery, so a stored id would go stale on merge, dangle on delete, and never appear for a contact added after the email. Resolving email → contact through `contact_identities` at read time has none of those problems: merge already moves those rows to the winner (`contact-merge.ts` lists `contact_identities` among the repointed tables), deleting a contact removes its identity rows, and a contact added later resolves immediately. `EmailEventPerson.contactId` therefore stays unset in storage. `contact-merge.ts` needs no change.
2. **Same-company candidates come from a direct query, not `findOrgRosters`.** `findOrgRosters` (`src/lib/chat-roster.ts`) resolves an organisation named inside a natural-language question; here the company is already a string. The query reuses the normalisation in `who-to-talk-to.ts` (`contactsPerCompany`) and adds corporate-suffix stripping so an event at "Stripe" finds a contact at "Stripe, Inc.".
3. **No warm-path feature and no recency feature.** Warm path is a signal for strangers ("you know two people at their company"); every candidate here is already in the network. Recency and dormancy belong to Radar's own scorer (`src/lib/radar/score.ts`), which P4 feeds; duplicating them here would double-count. Closeness tier is kept.
4. **Role function is approximated from titles.** `role-function.ts` still exists only on `claude/constellation-render-clustering-b81406`. This plan uses `seniorityOf` (already in tree) plus a token overlap between the event's role and the contact's title. Swap in role function when that file lands.
5. **The lexical search arm only.** `hybridSearchContacts` is called with `embedding: null`, which skips the semantic arm: no embedding call, no AI cost, safe to run for every event in a background pass.

## Global Constraints

- **Stacked on P2.** Create the branch from the tip of P2's: `git switch -c claude/email-intel-people-ranking claude/email-intel-ai-extraction` (or from `main` once PR #389 has merged).
- **No schema change, no route, no cron, no AI, no network.** Nothing here touches `SCHEMA_VERSION`, `ops.yml`, `AI_OPERATIONS` or the legal copy.
- **Every query is scoped by `user_id`.** A contact, identity, goal or target belonging to another account must never influence a result; the rank smoke asserts it.
- **Batched reads only.** One lookup per source per event, never one per candidate. Candidate rows select only `id, full_name, company, title, industry, closeness_tier` — never `notes`, avatars or other prose (`docs/performance.md`).
- **Explainable and stable.** Every point in a score carries a reason `{code, label, points}`; the same inputs give the same order (ties break on name, then id). No model chooses or reorders anything.
- **Tests assert orderings, not literals.** The scorer's weights are exported and the smokes compare scores against each other, as `smoke-radar-score.ts` does, so tuning a weight does not break them.
- Every smoke: pure ones import nothing DB-related; PGlite ones start with `import "./smoke/_env";` and end with `process.exit(0)`. Register each in `MANIFEST` in `scripts/run-smoke.ts`; `npx tsx scripts/run-smoke.ts --check` must pass.
- The pglite tier shares one database across smokes and other email-intel smokes leave users opted in. A smoke must create and delete only its own users' rows and must not assume an empty database.
- Check exit codes, not just the tail of the output: `npx tsx scripts/<name>.ts >/dev/null 2>&1; echo $?`.
- Gate every commit on a clean `npx tsc --noEmit` (chain with `&&`, never `;`).
- In zsh, `git show "$ref:path"` fires modifiers; wrap such commands in `bash -c '...'`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/email-intel/resolve.ts` (create) | `normalizedEmail`, `resolveEmails`, `resolvePeople`, `ResolvedPerson` |
| `src/lib/email-intel/relevance.ts` (create) | Pure scorer: `EMAIL_RELEVANCE_WEIGHTS`, `scoreEmailContact`, `significantWords`, `stemOf` |
| `src/lib/email-intel/rank.ts` (create) | `loadRankContext`, `rankEventContacts`, `RankedEventContact` |
| `src/lib/email-intel/types.ts` (modify) | A comment on `EmailEventPerson.contactId`: never stored |
| `docs/superpowers/specs/2026-09-30-email-intelligence-design.md` (modify) | Sections 2 and 5 record decision 1 |
| `scripts/smoke-email-intel-resolve.ts`, `-relevance.ts`, `-rank.ts` (create) | One smoke per unit |

---

### Task 1: Resolve people to contacts (at read time)

**Files:**
- Create: `src/lib/email-intel/resolve.ts`
- Modify: `src/lib/email-intel/types.ts` (comment only)
- Create: `scripts/smoke-email-intel-resolve.ts`
- Modify: `scripts/run-smoke.ts` (pglite block)

**Interfaces:**
- Consumes: `identityKeysFor` (`src/lib/duplicates.ts`), `findIdentityOwners` (`src/lib/contact-identity.ts`), `EmailEventPerson` (P1 `types.ts`).
- Produces (exact):
  - `normalizedEmail(email: string | null | undefined): string | null`: the address as `contact_identities` stores it, or null when it cannot be an identity (missing, malformed, or a role address such as `careers@`).
  - `resolveEmails(userId: string, emails: string[]): Promise<Map<string, string>>`: normalized email → contact id, for the addresses some contact of this user holds.
  - `type ResolvedPerson = EmailEventPerson & { contactId: string | null; suggestAdd: boolean }`
  - `resolvePeople(userId: string, people: EmailEventPerson[]): Promise<ResolvedPerson[]>`: same order as the input. `suggestAdd` is true when the person is unresolved and has a name to create a contact with.

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * Resolving the people named in an email to contacts: by email, at read time, merge-safe.
 * PGlite, no network. Run: npx tsx scripts/smoke-email-intel-resolve.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import {
  normalizedEmail,
  resolveEmails,
  resolvePeople,
} from "../src/lib/email-intel/resolve";

const U = "smoke-eir-u";
const V = "smoke-eir-v";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function addContact(userId: string, fullName: string, email: string | null) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, email }).returning();
  if (email) await syncIdentitiesForContact(userId, row!.id, { email }, "smoke");
  return row!.id;
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));

  console.log("\nNormalising");
  check("case and padding are folded", normalizedEmail("  Dana@Northwind.Example ") === "dana@northwind.example");
  check("a missing address is null", normalizedEmail(null) === null && normalizedEmail(undefined) === null && normalizedEmail("") === null);
  check("a malformed address is null", normalizedEmail("not an email") === null);
  check("a role address is never an identity", normalizedEmail("careers@northwind.example") === null);

  const dana = await addContact(U, "Dana Kim", "dana@northwind.example");
  const eli = await addContact(U, "Eli Park", "eli@northwind.example");
  const vera = await addContact(V, "Vera Stone", "dana@northwind.example");

  console.log("\nResolving addresses");
  const map = await resolveEmails(U, ["DANA@northwind.example", "eli@northwind.example", "nobody@northwind.example", "careers@northwind.example", ""]);
  check("a known address resolves, whatever its case", map.get("dana@northwind.example") === dana);
  check("another known address resolves", map.get("eli@northwind.example") === eli);
  check("an unknown address is absent", !map.has("nobody@northwind.example"));
  check("a role address never resolves", !map.has("careers@northwind.example"));
  check("an empty request is an empty map", (await resolveEmails(U, [])).size === 0);
  check("another account's contact is never returned", [...map.values()].every((id) => id !== vera));
  check("the same address resolves to that account's own contact", (await resolveEmails(V, ["dana@northwind.example"])).get("dana@northwind.example") === vera);

  console.log("\nResolving people");
  const people = await resolvePeople(U, [
    { name: "Dana Kim", email: "dana@northwind.example", title: "Recruiter" },
    { name: "Stranger One", email: "one@elsewhere.example", title: null },
    { name: null, email: "two@elsewhere.example", title: null },
    { name: "Named Only", email: null, title: "Engineer" },
    { name: "  ", email: null, title: null },
  ]);
  check("the input order is kept", people.map((p) => p.name).join("|") === "Dana Kim|Stranger One||Named Only|  ");
  check("a known person carries their contact id", people[0]!.contactId === dana);
  check("a known person is not a suggestion", people[0]!.suggestAdd === false);
  check("a named stranger is offered as an add", people[1]!.contactId === null && people[1]!.suggestAdd === true);
  check("an email with no name cannot be added", people[2]!.contactId === null && people[2]!.suggestAdd === false);
  check("a name with no email is still an add", people[3]!.suggestAdd === true);
  check("a blank name is not", people[4]!.suggestAdd === false);
  check("the other fields pass through untouched", people[0]!.title === "Recruiter" && people[3]!.title === "Engineer");

  console.log("\nA merge, an unmerge and a delete");
  const ellie = await addContact(U, "Eli Park (old card)", "eli.park@oldjob.example");
  check("the old address resolves to the old card", (await resolveEmails(U, ["eli.park@oldjob.example"])).get("eli.park@oldjob.example") === ellie);
  const { mergeId } = await mergeContacts(U, eli, ellie);
  check("after a merge the loser's address resolves to the winner", (await resolveEmails(U, ["eli.park@oldjob.example"])).get("eli.park@oldjob.example") === eli);
  check("and the winner's own address still does", (await resolveEmails(U, ["eli@northwind.example"])).get("eli@northwind.example") === eli);
  await unmergeContacts(U, mergeId);
  check("after an unmerge it resolves to the restored card", (await resolveEmails(U, ["eli.park@oldjob.example"])).get("eli.park@oldjob.example") === ellie);
  await db.delete(contacts).where(eq(contacts.id, dana));
  check("after the contact is deleted the address is unresolved", !(await resolveEmails(U, ["dana@northwind.example"])).has("dana@northwind.example"));
  const gone = await resolvePeople(U, [{ name: "Dana Kim", email: "dana@northwind.example", title: null }]);
  check("and the person becomes an add suggestion", gone[0]!.contactId === null && gone[0]!.suggestAdd === true);

  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  console.log("\nAll email-intel resolve checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-email-intel-resolve.ts`
Expected: FAIL, cannot find module `../src/lib/email-intel/resolve`.

- [ ] **Step 3: Implement**

`src/lib/email-intel/resolve.ts`:

```ts
/**
 * Mapping the people an email names to contacts the user already has.
 *
 * **Resolved on read, never stored.** A contact id held inside `email_events.people` would
 * have to survive `mergeContacts` (which repoints child rows by id and replays them on
 * `unmergeContacts`, and cannot see ids inside a JSON column), a deletion, and a contact
 * added after the email arrived. Looking the address up in `contact_identities` each time has
 * none of those problems: merge already moves those rows to the winner, a deleted contact
 * takes its identity rows with it, and a new contact resolves at once. Email is the only key:
 * a name match is how duplicates get made.
 */
import { findIdentityOwners } from "@/lib/contact-identity";
import { identityKeysFor } from "@/lib/duplicates";
import type { EmailEventPerson } from "./types";

export type ResolvedPerson = EmailEventPerson & {
  /** The contact that holds this person's address right now, or null. */
  contactId: string | null;
  /** Unresolved but named: worth offering as an "Add to Orbit" suggestion. */
  suggestAdd: boolean;
};

/**
 * The address as `contact_identities` stores it, or null when it cannot be an identity. The
 * rule is `identityKeysFor`'s, so a lookup can never use a spelling no contact could hold.
 */
export function normalizedEmail(email: string | null | undefined): string | null {
  return identityKeysFor({ email }).find((k) => k.kind === "email")?.value ?? null;
}

/** Normalized email → contact id, for the addresses some contact of this user holds. */
export async function resolveEmails(userId: string, emails: string[]): Promise<Map<string, string>> {
  const values = new Set<string>();
  for (const email of emails) {
    const normalized = normalizedEmail(email);
    if (normalized) values.add(normalized);
  }
  if (values.size === 0) return new Map();
  const owners = await findIdentityOwners(
    userId,
    [...values].map((value) => ({ kind: "email" as const, value }))
  );
  return new Map(owners.filter((o) => o.key.kind === "email").map((o) => [o.key.value, o.contactId]));
}

export async function resolvePeople(userId: string, people: EmailEventPerson[]): Promise<ResolvedPerson[]> {
  const owners = await resolveEmails(userId, people.map((p) => p.email ?? ""));
  return people.map((p) => {
    const normalized = normalizedEmail(p.email);
    const contactId = (normalized ? owners.get(normalized) : undefined) ?? null;
    return { ...p, contactId, suggestAdd: contactId === null && Boolean(p.name?.trim()) };
  });
}
```

In `src/lib/email-intel/types.ts`, replace the `EmailEventPerson` type with:

```ts
export type EmailEventPerson = {
  name: string | null;
  email: string | null;
  title: string | null;
  /**
   * Never written to storage. A contact id inside this JSON column would go stale on merge
   * and unmerge; `resolvePeople` (`resolve.ts`) looks the address up when it is read.
   */
  contactId?: string | null;
};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-email-intel-resolve.ts`
Expected: every line `ok`, ending "All email-intel resolve checks passed." If the merge lines fail, print `SELECT kind, value, contact_id FROM contact_identities WHERE user_id = ...` before and after the merge: `contact-merge.ts` lists `contact_identities` among the tables it repoints (line 78), so a failure there means the identity was never claimed for the loser, not that merge is wrong. If `mergeContacts` throws because of `next/server`, check how `scripts/smoke-contact-merge.ts` is set up (it calls `mergeContacts` directly).

- [ ] **Step 5: Register, typecheck, lint, commit**

Add `"smoke-email-intel-resolve": "pglite",` to `MANIFEST` after `"smoke-email-intel-route"`. Then:

```bash
npx tsc --noEmit 2>&1 | grep -v "^npm notice"; echo "== tsc done"
npx eslint src/lib/email-intel scripts/smoke-email-intel-resolve.ts --max-warnings=0 2>&1 | grep -v "^npm notice"; echo "== eslint done"
git add src/lib/email-intel/resolve.ts src/lib/email-intel/types.ts scripts/smoke-email-intel-resolve.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): resolve the people an email names to contacts, at read time

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Only commit if no `error TS` appeared before `== tsc done`.

---
### Task 2: The relevance scorer (pure)

**Files:**
- Create: `src/lib/email-intel/relevance.ts`
- Create: `scripts/smoke-email-intel-relevance.ts`
- Modify: `scripts/run-smoke.ts` (pure block)

**Interfaces:**
- Consumes: `seniorityOf`, `RelevanceReason` (`src/lib/events/relevance.ts`), `EmailEventKind` (P1 `types.ts`).
- Produces (exact):
  - `EMAIL_RELEVANCE_WEIGHTS` (exported so smokes compare orderings, not numbers)
  - `type EmailRelevanceBucket = "must" | "good" | "maybe" | "skip"`
  - `type EmailRelevanceInput`, `type EmailRelevanceResult = { score: number; bucket: EmailRelevanceBucket; reasons: RelevanceReason[] }`
  - `scoreEmailContact(input: EmailRelevanceInput): EmailRelevanceResult`
  - `significantWords(text: string | null | undefined): string[]`: the meaningful lowercase words of a role or title, seniority words and connectors removed, in order, without repeats.
  - `stemOf(word: string): string`: a deliberately crude stem so "engineer", "engineers" and "engineering" compare equal.

The scorer never reads the database. Its inputs are already-loaded facts, so it is testable in isolation and explainable line by line, which is the whole design of `scoreAttendee` this mirrors.

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * Who, out of a person's network, is worth reaching for an email event. Orderings, not
 * literals: the weights are exported and compared against each other. Pure.
 * Run: npx tsx scripts/smoke-email-intel-relevance.ts
 */
import {
  EMAIL_RELEVANCE_WEIGHTS as W,
  scoreEmailContact,
  significantWords,
  stemOf,
  type EmailRelevanceInput,
} from "../src/lib/email-intel/relevance";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NORTHWIND = ["northwind"];

type Over = Omit<Partial<EmailRelevanceInput>, "candidate"> & { candidate?: Partial<EmailRelevanceInput["candidate"]> };

function input(over: Over = {}): EmailRelevanceInput {
  const { candidate, ...rest } = over;
  return {
    eventKind: "job_posting",
    eventCompany: "Northwind",
    eventCompanyKeys: NORTHWIND,
    eventRole: "Staff Engineer, Payments",
    candidate: {
      contactId: "c1",
      fullName: "Sam Rowe",
      company: "Northwind",
      title: "Account Coordinator",
      companyKeys: NORTHWIND,
      closenessTier: null,
      ...candidate,
    },
    via: { thread: false, search: false, searchRelevance: 0 },
    targetKeys: new Map(),
    goalFit: 0,
    ...rest,
  };
}
const score = (over?: Over) => scoreEmailContact(input(over)).score;
const codes = (over?: Over) => scoreEmailContact(input(over)).reasons.map((r) => r.code);

console.log("\nWords and stems");
check("seniority words and connectors are dropped", significantWords("Staff Engineer, Payments").join() === "engineer,payments", significantWords("Staff Engineer, Payments").join());
check("a director title keeps its function", significantWords("Director of Engineering").join() === "engineering");
check("repeats are folded", significantWords("Data data Engineer").join() === "data,engineer");
check("nothing in, nothing out", significantWords(null).length === 0 && significantWords("").length === 0);
check("engineer, engineers and engineering share a stem", stemOf("engineer") === stemOf("engineering") && stemOf("engineer") === stemOf("engineers"));
check("payment and payments share a stem", stemOf("payment") === stemOf("payments"));
check("different functions do not", stemOf("design") !== stemOf("engineer") && stemOf("sales") !== stemOf("support"));

console.log("\nOn the thread, at the company");
check("someone on the thread outranks a stranger to it", score({ via: { thread: true, search: false, searchRelevance: 0 } }) > score());
check("the company matters on its own", score() > score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } }));
check("a company on the target list adds to its people", score({ targetKeys: new Map([["northwind", 2]]) }) > score());
check("a stronger target priority adds more", score({ targetKeys: new Map([["northwind", 1]]) }) > score({ targetKeys: new Map([["northwind", 2]]) }) && score({ targetKeys: new Map([["northwind", 2]]) }) > score({ targetKeys: new Map([["northwind", 3]]) }));
check("the target bonus needs the candidate to work there", score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] }, targetKeys: new Map([["northwind", 1]]) }) === score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } }));
check("the company is matched through its suffix-less key", score({ candidate: { company: "Northwind, Inc.", companyKeys: ["northwind inc", "northwind"] } }) === score());

console.log("\nWho they are");
check("a recruiter at the company outranks a coordinator for a job", score({ candidate: { title: "Technical Recruiter" } }) > score());
check("a leader outranks an individual contributor", score({ candidate: { title: "VP of Sales" } }) > score());
check("a recruiter is worth nothing for company news", score({ eventKind: "news", candidate: { title: "Technical Recruiter" } }) === score({ eventKind: "news" }));
check("a leader still counts for company news", score({ eventKind: "news", candidate: { title: "VP of Sales" } }) > score({ eventKind: "news" }));
check("seniority is ignored for someone elsewhere", score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Technical Recruiter" } }) === score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Account Coordinator" } }));
check("seniority still counts for someone on the thread", score({ via: { thread: true, search: false, searchRelevance: 0 }, candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Technical Recruiter" } }) > score({ via: { thread: true, search: false, searchRelevance: 0 }, candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Account Coordinator" } }));

console.log("\nThe role");
const one = score({ candidate: { title: "Payments Analyst" } });
const two = score({ candidate: { title: "Payments Engineer" } });
check("a title sharing a word with the role scores", one > score());
check("sharing more words scores more", two > one);
check("the match survives a different suffix", score({ candidate: { title: "Director of Engineering" } }) > score({ candidate: { title: "Director of Sales" } }));
check("no role means no match", score({ eventRole: null, candidate: { title: "Payments Engineer" } }) === score({ eventRole: null }));
check("the reason names the shared words", scoreEmailContact(input({ candidate: { title: "Payments Engineer" } })).reasons.some((r) => r.code === "role_match" && /engineer/i.test(r.label)));

console.log("\nYou and them");
check("goal fit adds", score({ goalFit: 1 }) > score());
check("goal fit is capped", score({ goalFit: 50 }) === score({ goalFit: 1 }));
check("knowing them well adds", score({ candidate: { closenessTier: "inner" } }) > score({ candidate: { closenessTier: "mid" } }) && score({ candidate: { closenessTier: "mid" } }) > score({ candidate: { closenessTier: "outer" } }));

console.log("\nFound only by searching their profile");
const searchOnly = (relevance: number, over: Over = {}) =>
  score({ ...over, candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Account Coordinator", ...(over.candidate ?? {}) }, via: { thread: false, search: true, searchRelevance: relevance } });
check("a profile match is worth something", searchOnly(1) > searchOnly(0));
check("a better match is worth more", searchOnly(1) > searchOnly(0.5));
check("a profile match adds nothing for someone at the company", score({ via: { thread: false, search: true, searchRelevance: 1 } }) === score());
check("nor for someone on the thread", score({ via: { thread: true, search: true, searchRelevance: 1 } }) === score({ via: { thread: true, search: false, searchRelevance: 0 } }));
check("a profile match alone is less than being at the company", searchOnly(1) < score());
check("the search reason is explained", codes({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] }, via: { thread: false, search: true, searchRelevance: 1 } }).includes("search_match"));

console.log("\nShape of the answer");
const strongest = scoreEmailContact(input({
  via: { thread: true, search: false, searchRelevance: 0 },
  targetKeys: new Map([["northwind", 1]]),
  goalFit: 1,
  candidate: { title: "Technical Recruiter Payments Engineer", closenessTier: "inner" },
}));
check("a score never passes 100", strongest.score <= 100 && strongest.score > 0);
check("and never drops below 0", scoreEmailContact(input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } })).score === 0);
check("the strongest case is a must", strongest.bucket === "must");
check("someone with no reasons is skip", scoreEmailContact(input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } })).bucket === "skip" && scoreEmailContact(input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } })).reasons.length === 0);
check("buckets rise with the score", (() => {
  const order = ["skip", "maybe", "good", "must"];
  const results = [
    input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } }),
    input(),
    input({ candidate: { title: "Payments Engineer" } }),
    input({ via: { thread: true, search: false, searchRelevance: 0 }, candidate: { title: "Payments Engineer", closenessTier: "inner" } }),
  ].map((i) => scoreEmailContact(i));
  return results.every((r, i) => i === 0 || r.score >= results[i - 1]!.score) && results.every((r, i) => i === 0 || order.indexOf(r.bucket) >= order.indexOf(results[i - 1]!.bucket));
})());
check("reasons come strongest first", strongest.reasons.every((r, i) => i === 0 || strongest.reasons[i - 1]!.points >= r.points));
check("every reason has a code, a label and points", strongest.reasons.every((r) => r.code && r.label && r.points !== 0));
check("the same input scores the same", JSON.stringify(scoreEmailContact(input({ goalFit: 0.4 }))) === JSON.stringify(scoreEmailContact(input({ goalFit: 0.4 }))));
check("the weights are ordered sensibly", W.onThread > W.sameCompany && W.sameCompany > W.closeness.inner && W.closeness.inner > W.closeness.mid && W.roleMatchMany > W.roleMatchOne);

console.log("\nAll email-intel relevance checks passed.");
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-email-intel-relevance.ts`
Expected: FAIL, cannot find module `../src/lib/email-intel/relevance`.

- [ ] **Step 3: Implement**

`src/lib/email-intel/relevance.ts`:

```ts
/**
 * Who in the user's network is worth reaching for an email event.
 *
 * The same contract as `scoreAttendee` (`src/lib/events/relevance.ts`), and for the same
 * reasons. EXPLAINABLE: every point carries a reason, because "talk to Dana" is useless and
 * "Recruits for Northwind, on your target list, and is on this thread" is something a person
 * can act on. STABLE: same inputs, same order, which a model cannot promise. The optional AI
 * step, if one is ever added, writes prose about a row this has already chosen.
 *
 * Seniority is a weak, biased signal and is weighted as one. It counts only where it predicts
 * usefulness: a recruiter for a job event, a leader for company news, and only for people who
 * are at the company or on the thread. A recruiter somewhere else is not a route to this job.
 *
 * Pure: no network, no database, no AI. The caller loads the facts.
 */
import { seniorityOf, type RelevanceReason } from "@/lib/events/relevance";
import type { EmailEventKind } from "./types";

/**
 * Every weight in one object, because they only make sense relative to each other. Exported
 * so the smoke asserts ORDERINGS rather than re-typing the numbers.
 */
export const EMAIL_RELEVANCE_WEIGHTS = {
  /** They are on the email. The strongest single signal: the conversation is already open. */
  onThread: 30,
  /** They work at the company the email is about. */
  sameCompany: 20,
  /** Added to `sameCompany` when the company is on the user's target list, by priority. */
  targetCompany: { 1: 15, 2: 10, 3: 5 },
  /** For a job or a hiring-process event: who can actually move it. */
  seniority: { recruiter: 14, leader: 10, founder_exec: 8, ic: 0, unknown: 0 },
  /** For company news or an event: who is senior enough to have a view. A recruiter is not. */
  seniorityForNews: { recruiter: 0, leader: 6, founder_exec: 6, ic: 0, unknown: 0 },
  /** The title shares a word with the role, or several. */
  roleMatchOne: 10,
  roleMatchMany: 14,
  /** Scaled by `goalRelevanceComponent`, already 0..1. */
  goalMatch: 15,
  /** How well they know the user. Closer is a warmer route. */
  closeness: { inner: 10, mid: 6, outer: 0 },
  /** Found only because their profile mentions the role's words; scaled by the search score. */
  searchMatch: 12,
} as const;

export type EmailRelevanceBucket = "must" | "good" | "maybe" | "skip";

export type EmailRelevanceInput = {
  eventKind: Exclude<EmailEventKind, "other">;
  eventCompany: string | null;
  /** `companyMatchKeys(event.company)`. */
  eventCompanyKeys: string[];
  eventRole: string | null;
  candidate: {
    contactId: string;
    fullName: string;
    company: string | null;
    title: string | null;
    /** `companyMatchKeys(candidate.company)`. */
    companyKeys: string[];
    closenessTier: "inner" | "mid" | "outer" | null;
  };
  via: {
    /** On the email (named by the model, or on its headers). */
    thread: boolean;
    /** Returned by the lexical profile search. */
    search: boolean;
    /** The search's own 0..1 relevance. Ignored unless `search`. */
    searchRelevance: number;
  };
  /** The user's target companies, keyed like `companyMatchKeys`, valued by priority 1..3. */
  targetKeys: Map<string, number>;
  /** 0..1 from `goalRelevanceComponent`. */
  goalFit: number;
};

export type EmailRelevanceResult = {
  score: number;
  bucket: EmailRelevanceBucket;
  reasons: RelevanceReason[];
};

/** Words that say how senior a role is, or connect other words, and so say nothing about what it is. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "of", "at", "in", "to", "an",
  "senior", "staff", "principal", "lead", "junior", "associate", "intern",
  "sr", "jr", "head", "chief", "vice", "president", "vp", "director",
]);

/** The meaningful lowercase words of a role or title, in order, without repeats. */
export function significantWords(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const word of (text ?? "").toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (word.length < 3 || STOP_WORDS.has(word) || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/**
 * A deliberately crude stem: enough that "engineer", "engineers" and "engineering" compare
 * equal and "payment" matches "payments". Two passes because "engineering" → "engineer" →
 * "engine". It will not unify "analyst" with "analytics"; a miss costs a few points, and a
 * false match is worse, so it stays this simple.
 */
export function stemOf(word: string): string {
  let stem = word;
  for (let pass = 0; pass < 2; pass++) {
    if (stem.length > 4) stem = stem.replace(/(ing|ers|er|s)$/, "");
  }
  return stem;
}

function bucketOf(score: number): EmailRelevanceBucket {
  return score >= 40 ? "must" : score >= 22 ? "good" : score >= 10 ? "maybe" : "skip";
}

export function scoreEmailContact(input: EmailRelevanceInput): EmailRelevanceResult {
  const W = EMAIL_RELEVANCE_WEIGHTS;
  const reasons: RelevanceReason[] = [];
  const add = (code: string, label: string, points: number) => {
    if (points !== 0) reasons.push({ code, label, points });
  };
  const c = input.candidate;
  const sameCompany = c.companyKeys.some((key) => input.eventCompanyKeys.includes(key));
  const companyName = c.company ?? input.eventCompany ?? "their company";

  if (input.via.thread) add("on_thread", "On this email thread", W.onThread);

  if (sameCompany) {
    add("same_company", `Works at ${companyName}`, W.sameCompany);
    let priority: number | null = null;
    for (const key of input.eventCompanyKeys) {
      const p = input.targetKeys.get(key);
      if (p !== undefined && (priority === null || p < priority)) priority = p;
    }
    if (priority !== null) {
      const table = W.targetCompany;
      add("target_company", `${companyName} is on your target list`, table[priority as keyof typeof table] ?? table[3]);
    }
  }

  if (input.via.thread || sameCompany) {
    // `seniorityOf` is typed over the events feature's weight keys, which include a careers-fair
    // variant it never returns; it is a recruiter here.
    const raw = seniorityOf(c.title);
    const seniority: "recruiter" | "leader" | "founder_exec" | "ic" | "unknown" =
      raw === "recruiterAtCareerFair" ? "recruiter" : raw;
    const table = input.eventKind === "news" || input.eventKind === "event" ? W.seniorityForNews : W.seniority;
    const label =
      seniority === "recruiter"
        ? "Recruits for their company"
        : seniority === "founder_exec"
          ? "Runs their company"
          : "Leads a team";
    add(`seniority_${seniority}`, label, table[seniority]);
  }

  const roleStems = new Map(significantWords(input.eventRole).map((word) => [stemOf(word), word]));
  if (roleStems.size > 0 && c.title) {
    const shared = significantWords(c.title)
      .map((word) => roleStems.get(stemOf(word)))
      .filter((word): word is string => Boolean(word));
    if (shared.length > 0) {
      add(
        "role_match",
        `Title matches the role (${shared.join(", ")})`,
        shared.length > 1 ? W.roleMatchMany : W.roleMatchOne
      );
    }
  }

  if (input.goalFit > 0) {
    add("goal_match", "Matches what you said you're working on", Math.round(W.goalMatch * Math.min(1, input.goalFit)));
  }

  if (c.closenessTier) {
    add(
      `closeness_${c.closenessTier}`,
      c.closenessTier === "inner" ? "You know them well" : c.closenessTier === "mid" ? "You've met" : "In your network",
      W.closeness[c.closenessTier]
    );
  }

  if (input.via.search && !input.via.thread && !sameCompany) {
    add("search_match", "Their profile matches the role", Math.round(W.searchMatch * Math.max(0, Math.min(1, input.via.searchRelevance))));
  }

  const raw = reasons.reduce((total, reason) => total + reason.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  reasons.sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
  return { score, bucket: bucketOf(score), reasons };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-email-intel-relevance.ts`
Expected: every line `ok`, ending "All email-intel relevance checks passed." If an ordering check fails, the weights are the thing to reconsider, not the check: print both scores and the reason lists. The one assertion that encodes a product decision is "a profile match alone is less than being at the company"; if a tuning pass makes search matches outrank colleagues, change the assertion on purpose and say why in the commit.

- [ ] **Step 5: Register, typecheck, lint, commit**

Add `"smoke-email-intel-relevance": "pure",` to `MANIFEST` after `"smoke-email-intel-extract"`. Then:

```bash
npx tsc --noEmit 2>&1 | grep -v "^npm notice"; echo "== tsc done"
npx eslint src/lib/email-intel scripts/smoke-email-intel-relevance.ts --max-warnings=0 2>&1 | grep -v "^npm notice"; echo "== eslint done"
git add src/lib/email-intel/relevance.ts scripts/smoke-email-intel-relevance.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): an explainable relevance scorer for who to reach

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Only commit if no `error TS` appeared before `== tsc done`.

---

### Task 3: Rank the contacts for an event

**Files:**
- Create: `src/lib/email-intel/rank.ts`
- Create: `scripts/smoke-email-intel-rank.ts`
- Modify: `scripts/run-smoke.ts` (pglite block)

**Interfaces:**
- Consumes: `resolveEmails` (Task 1), `scoreEmailContact`, `significantWords` (Task 2), `loadTargetKeys` (`src/lib/events/companies.ts`), `companyMatchKeys` (`src/lib/events/company-list-parse.ts`), `listActiveGoalTextsForUser` (`src/lib/user-goals.ts`), `goalRelevanceComponent` (`src/lib/closeness.ts`), `hybridSearchContacts` (`src/lib/hybrid-search.ts`), the `emailThreads` table.
- Produces (exact):
  - `type RankContext = { goals: string[]; targetKeys: Map<string, number> }`
  - `loadRankContext(userId: string): Promise<RankContext>`: load once, reuse for every event in a pass.
  - `type RankableEvent = { kind: Exclude<EmailEventKind, "other">; company: string | null; role: string | null; people: EmailEventPerson[]; threadRowId: string | null }`. A row from `email_events` satisfies it.
  - `type RankedEventContact = { contactId: string; fullName: string; company: string | null; title: string | null; score: number; bucket: EmailRelevanceBucket; reasons: RelevanceReason[]; via: Array<"thread" | "company" | "search"> }`
  - `rankEventContacts(userId: string, event: RankableEvent, opts?: { limit?: number; context?: RankContext }): Promise<RankedEventContact[]>`: best first, at most `limit` (default 3), people with no reason or a `skip` score left out.

Candidate sources, each one batched read: people on the thread (the model's named people plus the addresses on the thread's headers, through `resolveEmails`); contacts at the event's company; and a lexical profile search on the role's words. Their facts are then loaded in one query and scored in JavaScript.

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * Ranking the people in a network for an email event: where candidates come from, what is
 * left out, that accounts never mix, and that the answer is stable. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-rank.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, emailThreads, targetCompanies, userGoals } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { loadRankContext, rankEventContacts, type RankableEvent } from "../src/lib/email-intel/rank";
import { upsertThreadResult } from "../src/lib/email-intel/store";

const U = "smoke-eik-u";
const V = "smoke-eik-v";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function addContact(
  userId: string,
  fullName: string,
  company: string | null,
  title: string | null,
  email: string | null,
  closenessTier: "inner" | "mid" | "outer" | null
) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, company, title, email, closenessTier }).returning();
  if (email) await syncIdentitiesForContact(userId, row!.id, { email }, "smoke");
  return row!.id;
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, [U, V]));
  await db.delete(targetCompanies).where(inArray(targetCompanies.userId, [U, V]));
  await db.delete(userGoals).where(inArray(userGoals.userId, [U, V]));
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  await db.delete(companies).where(inArray(companies.userId, [U, V]));

  const dana = await addContact(U, "Dana Kim", "Northwind, Inc.", "Technical Recruiter", "dana@northwind.example", "inner");
  const eli = await addContact(U, "Eli Park", "Northwind", "Payments Engineer", "eli@northwind.example", "mid");
  const fay = await addContact(U, "Fay Ortiz", "Northwind", "VP of Sales", null, "outer");
  const gus = await addContact(U, "Gus Lund", "Other Co", "Payments Engineer", null, "inner");
  const hal = await addContact(U, "Hal Moss", "Diner", "Head Chef", "hal@diner.example", null);
  const zed = await addContact(V, "Zed Vance", "Northwind", "Payments Engineer", "dana@northwind.example", "inner");

  const [northwind] = await db.insert(companies).values({ userId: U, name: "Northwind", nameNormalized: "northwind" }).returning();
  await db.insert(targetCompanies).values({ userId: U, companyId: northwind!.id, priority: 2 });
  await db.insert(userGoals).values({ userId: U, text: "land a payments engineering role" });

  const job: RankableEvent = {
    kind: "job_posting",
    company: "Northwind",
    role: "Staff Engineer, Payments",
    people: [
      { name: "Dana Kim", email: "DANA@northwind.example", title: "Technical Recruiter" },
      { name: "Unknown Person", email: "unknown@northwind.example", title: null },
    ],
    threadRowId: null,
  };

  console.log("\nA job at a company you know");
  const context = await loadRankContext(U);
  check("the context carries the user's goals and targets", context.goals.length === 1 && context.targetKeys.get("northwind") === 2);
  const wide = await rankEventContacts(U, job, { limit: 10, context });
  const ids = wide.map((r) => r.contactId);
  check("the recruiter on the thread comes first", ids[0] === dana, ids.join());
  check("the thread recruiter says why", wide[0]!.reasons.some((r) => r.code === "on_thread") && wide[0]!.reasons.some((r) => r.code === "seniority_recruiter"));
  check("she was also found through her company", wide[0]!.via.includes("thread") && wide[0]!.via.includes("company"));
  check("a matching engineer at the company outranks a VP with no link to the role", ids.indexOf(eli) < ids.indexOf(fay), ids.join());
  check("the VP at the company is still there", ids.includes(fay));
  check("an engineer elsewhere is found by their profile alone", ids.includes(gus) && wide.find((r) => r.contactId === gus)!.via.join() === "search");
  check("someone unrelated is left out", !ids.includes(hal));
  check("another account's contact never appears", !ids.includes(zed));
  check("the unresolved address does not become a candidate", ids.length === 4, ids.join());
  check("scores never increase down the list", wide.every((r, i) => i === 0 || wide[i - 1]!.score >= r.score));
  check("every row explains itself", wide.every((r) => r.reasons.length > 0 && r.bucket !== "skip"));
  check("the suffix in 'Northwind, Inc.' did not hide her company", wide[0]!.reasons.some((r) => r.code === "same_company"));

  console.log("\nLimits and stability");
  const top = await rankEventContacts(U, job, { context });
  check("the default is three", top.length === 3);
  check("and they are the top of the longer list", top.map((r) => r.contactId).join() === ids.slice(0, 3).join());
  check("the same call gives the same answer", JSON.stringify(await rankEventContacts(U, job, { limit: 10, context })) === JSON.stringify(wide));
  check("without a preloaded context it loads its own", (await rankEventContacts(U, job, { limit: 10 })).map((r) => r.contactId).join() === ids.join());

  console.log("\nThe company alone");
  const noPeople = await rankEventContacts(U, { ...job, people: [] }, { limit: 10, context });
  check("contacts at the company are found with nobody on the thread", noPeople.find((r) => r.contactId === dana)?.via.join() === "company");
  check("nobody is marked as on the thread", noPeople.every((r) => !r.reasons.some((x) => x.code === "on_thread")));

  console.log("\nCompany news");
  const news = await rankEventContacts(U, { kind: "news", company: "Northwind", role: null, people: [], threadRowId: null }, { limit: 10, context });
  check("a recruiter's seniority is not counted for news", news.find((r) => r.contactId === dana)!.reasons.every((r) => r.code !== "seniority_recruiter"));
  check("a leader's is", news.find((r) => r.contactId === fay)!.reasons.some((r) => r.code === "seniority_leader"));
  check("no role means no profile search", news.every((r) => !r.via.includes("search")));

  console.log("\nPeople on the thread the model did not name");
  const saved = await upsertThreadResult(U, {
    threadId: "rank-thread",
    lastMessageId: "rank-m1",
    subject: "Lunch",
    participants: ["hal@diner.example", "stranger@nowhere.example"],
    lastDirection: "in",
    decision: "classify",
    triageScore: 3,
    event: null,
  });
  check("the thread was stored", saved.changed);
  const [threadRow] = await db.select().from(emailThreads).where(eq(emailThreads.userId, U));
  const viaHeaders = await rankEventContacts(U, { kind: "event", company: null, role: null, people: [], threadRowId: threadRow!.id }, { context });
  check("an address on the headers makes that contact a candidate", viaHeaders.length === 1 && viaHeaders[0]!.contactId === hal && viaHeaders[0]!.via.join() === "thread", JSON.stringify(viaHeaders.map((r) => r.contactId)));
  const otherAccount = await rankEventContacts(V, { kind: "event", company: null, role: null, people: [], threadRowId: threadRow!.id }, { context: await loadRankContext(V) });
  check("another account cannot read this thread's participants", otherAccount.length === 0);

  console.log("\nNothing to go on");
  check("no company, role, people or thread is an empty answer", (await rankEventContacts(U, { kind: "news", company: null, role: null, people: [], threadRowId: null }, { context })).length === 0);
  check("an empty network is an empty answer", (await rankEventContacts("smoke-eik-nobody", job)).length === 0);

  await db.delete(emailThreads).where(inArray(emailThreads.userId, [U, V]));
  await db.delete(targetCompanies).where(inArray(targetCompanies.userId, [U, V]));
  await db.delete(userGoals).where(inArray(userGoals.userId, [U, V]));
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  await db.delete(companies).where(inArray(companies.userId, [U, V]));
  console.log("\nAll email-intel rank checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-email-intel-rank.ts`
Expected: FAIL, cannot find module `../src/lib/email-intel/rank`.

- [ ] **Step 3: Implement**

`src/lib/email-intel/rank.ts`:

```ts
/**
 * Ranking the people in a user's network for one email event.
 *
 * Gathers candidates from three places, loads what scoring needs in batched reads, and scores
 * in JavaScript (`scoreEmailContact`). Not SQL: the weights change as this is tuned, and a
 * scoring expression spread across a query cannot be read, tested or explained.
 *
 * Nothing is stored. A ranking computed from the network as it is now cannot go stale, and P4
 * calls it when it builds Radar's list.
 *
 *  1. People on the thread: the ones the model named plus every address on the thread's
 *     headers, resolved through `contact_identities` (so a merge, a deletion or a contact
 *     added later is always reflected).
 *  2. Contacts at the event's company, matched on the same normalised key the events feature
 *     uses, with corporate suffixes stripped so "Stripe" finds "Stripe, Inc.".
 *  3. A lexical search of profiles on the role's words. `embedding: null` skips the semantic
 *     arm: no embedding call, no AI cost, safe to run for every event in a background pass.
 *
 * Every read is scoped to the user. Candidate rows never select notes, avatars or other prose.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { emailThreads } from "@/db/schema";
import { goalRelevanceComponent } from "@/lib/closeness";
import { loadTargetKeys } from "@/lib/events/companies";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import type { RelevanceReason } from "@/lib/events/relevance";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { resolveEmails } from "./resolve";
import { scoreEmailContact, significantWords, type EmailRelevanceBucket } from "./relevance";
import type { EmailEventKind, EmailEventPerson } from "./types";

/** Contacts pulled in because they work at the event's company. */
const COMPANY_CANDIDATES = 60;
/** Contacts pulled in because their profile matches the role. */
const SEARCH_CANDIDATES = 20;
export const DEFAULT_RANK_LIMIT = 3;

export type RankContext = { goals: string[]; targetKeys: Map<string, number> };

export type RankableEvent = {
  kind: Exclude<EmailEventKind, "other">;
  company: string | null;
  role: string | null;
  people: EmailEventPerson[];
  threadRowId: string | null;
};

export type RankedEventContact = {
  contactId: string;
  fullName: string;
  company: string | null;
  title: string | null;
  score: number;
  bucket: EmailRelevanceBucket;
  reasons: RelevanceReason[];
  via: Array<"thread" | "company" | "search">;
};

/** The user's goals and target companies: two reads, shared by every event in a pass. */
export async function loadRankContext(userId: string): Promise<RankContext> {
  const [goals, targetKeys] = await Promise.all([listActiveGoalTextsForUser(userId), loadTargetKeys(userId)]);
  return { goals, targetKeys };
}

/** The addresses on a thread's headers (P1 stored them, the user's own excluded). */
async function threadParticipants(userId: string, threadRowId: string | null): Promise<string[]> {
  if (!threadRowId) return [];
  const db = await getDb();
  const [row] = await db
    .select({ participants: emailThreads.participants })
    .from(emailThreads)
    .where(and(eq(emailThreads.id, threadRowId), eq(emailThreads.userId, userId)));
  return row?.participants ?? [];
}

const NORMALIZED_COMPANY =
  "trim(regexp_replace(regexp_replace(lower(company), '[^a-z0-9\\s]', ' ', 'g'), '\\s+', ' ', 'g'))";
const WITHOUT_SUFFIX = `regexp_replace(${NORMALIZED_COMPANY}, '\\s+(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|nv|bv|plc|pbc|llp|lp)$', '')`;

/** Ids of contacts whose employer matches any of these keys, closest and most recent first. */
async function contactsAtCompany(userId: string, keys: string[], limit: number): Promise<string[]> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getDb();
  const list = sql.join(unique.map((key) => sql`${key}`), sql`, `);
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id
        FROM contacts
       WHERE user_id = ${userId}
         AND company IS NOT NULL
         AND (${sql.raw(NORMALIZED_COMPANY)} IN (${list}) OR ${sql.raw(WITHOUT_SUFFIX)} IN (${list}))
       ORDER BY CASE closeness_tier WHEN 'inner' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
                last_interaction_at DESC NULLS LAST,
                id
       LIMIT ${limit}
    `)
  ).map((r) => r.id);
}

type CandidateRow = {
  id: string;
  full_name: string;
  company: string | null;
  title: string | null;
  industry: string | null;
  closeness_tier: "inner" | "mid" | "outer" | null;
};

async function loadCandidateRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
  const db = await getDb();
  return rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT id, full_name, company, title, industry, closeness_tier
        FROM contacts
       WHERE user_id = ${userId}
         AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `)
  );
}

type Via = { thread: boolean; company: boolean; search: boolean; searchRelevance: number };

export async function rankEventContacts(
  userId: string,
  event: RankableEvent,
  opts: { limit?: number; context?: RankContext } = {}
): Promise<RankedEventContact[]> {
  const limit = opts.limit ?? DEFAULT_RANK_LIMIT;
  const companyKeys = companyMatchKeys(event.company);
  const roleWords = significantWords(event.role);

  const context = opts.context ?? (await loadRankContext(userId));
  const headerEmails = await threadParticipants(userId, event.threadRowId);
  const [threadOwners, companyIds, searched] = await Promise.all([
    resolveEmails(userId, [...event.people.map((p) => p.email ?? ""), ...headerEmails]),
    contactsAtCompany(userId, companyKeys, COMPANY_CANDIDATES),
    roleWords.length > 0
      ? hybridSearchContacts(userId, { query: roleWords.join(" "), embedding: null, limit: SEARCH_CANDIDATES, withProse: false })
      : Promise.resolve([]),
  ]);

  const via = new Map<string, Via>();
  const touch = (id: string): Via => {
    let v = via.get(id);
    if (!v) via.set(id, (v = { thread: false, company: false, search: false, searchRelevance: 0 }));
    return v;
  };
  for (const id of threadOwners.values()) touch(id).thread = true;
  for (const id of companyIds) touch(id).company = true;
  for (const hit of searched) {
    const v = touch(hit.id);
    v.search = true;
    v.searchRelevance = Math.max(v.searchRelevance, hit.relevance);
  }
  if (via.size === 0) return [];

  const rows = await loadCandidateRows(userId, [...via.keys()]);
  const eventCompanyKeys = companyKeys;
  const ranked: RankedEventContact[] = [];
  for (const row of rows) {
    const v = via.get(row.id)!;
    const result = scoreEmailContact({
      eventKind: event.kind,
      eventCompany: event.company,
      eventCompanyKeys,
      eventRole: event.role,
      candidate: {
        contactId: row.id,
        fullName: row.full_name,
        company: row.company,
        title: row.title,
        companyKeys: companyMatchKeys(row.company),
        closenessTier: row.closeness_tier,
      },
      via: { thread: v.thread, search: v.search, searchRelevance: v.searchRelevance },
      targetKeys: context.targetKeys,
      goalFit: goalRelevanceComponent(
        { company: row.company, title: row.title, industry: row.industry } as Parameters<typeof goalRelevanceComponent>[0],
        context.goals
      ),
    });
    // A row with nothing to say about it is padding, and padding is what makes a
    // recommendation list ignorable.
    if (result.reasons.length === 0 || result.bucket === "skip") continue;
    ranked.push({
      contactId: row.id,
      fullName: row.full_name,
      company: row.company,
      title: row.title,
      score: result.score,
      bucket: result.bucket,
      reasons: result.reasons,
      via: [v.thread && "thread", v.company && "company", v.search && "search"].filter(
        (x): x is "thread" | "company" | "search" => Boolean(x)
      ),
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName) || a.contactId.localeCompare(b.contactId))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-email-intel-rank.ts`
Expected: every line `ok`, ending "All email-intel rank checks passed." Places this is most likely to need a nudge, and what to do:
- **Gus is not found by the search arm**: the lexical arm's matching rules are in `src/lib/hybrid-search.ts` (`runArms`); print `hybridSearchContacts(U, { query: "engineer payments", embedding: null, limit: 20, withProse: false })` in a scratch script. If it needs a column the smoke's contact lacks, give Gus that field; do not loosen the assertion that search-only contacts carry `via: ["search"]`.
- **`ids.length === 4`**: the four are Dana, Eli, Fay (company/thread) and Gus (search). If `Hal` appears, `seniorityOf("Head Chef")` or the goal text is matching something; print his reasons.
- **The suffix check**: `WITHOUT_SUFFIX` must equal `NORMALIZED_COMPANY` minus a trailing legal suffix; if Dana is missing from the company arm, print `SELECT ${NORMALIZED_COMPANY}` for her row.
- **`listActiveGoalTextsForUser`** should return an array of strings; if `tsc` says it returns rows, map to `.text` in `loadRankContext`.

- [ ] **Step 5: Register, typecheck, lint, commit**

Add `"smoke-email-intel-rank": "pglite",` to `MANIFEST` after `"smoke-email-intel-resolve"`. Then:

```bash
npx tsc --noEmit 2>&1 | grep -v "^npm notice"; echo "== tsc done"
npx eslint src/lib/email-intel scripts/smoke-email-intel-rank.ts --max-warnings=0 2>&1 | grep -v "^npm notice"; echo "== eslint done"
git add src/lib/email-intel/rank.ts scripts/smoke-email-intel-rank.ts scripts/run-smoke.ts
git commit -m "feat(email-intel): rank the contacts to reach for an email event

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Only commit if no `error TS` appeared before `== tsc done`.

---
### Task 4: Record the decisions in the spec, and verify the branch

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-email-intelligence-design.md` (sections 2, 5 and 6)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a spec that matches the code, so P4's plan does not build on a `contact_id` that is never stored.

- [ ] **Step 1: Update the spec**

Apply these replacements exactly (each target string occurs once; check with `grep -c`):

1. In section 2, `email_events`:
   - old: ``- `people` (jsonb: name, email, title, optional `contact_id`), `asks` (suggested tasks), `dismissed_at`.``
   - new: ``- `people` (jsonb: name, email, title; contacts are resolved when read and never stored, see section 5), `asks` (suggested tasks), `dismissed_at`.``
2. In section 2, data lifecycle: replace ``- Handle `people[].contact_id` in `src/lib/contact-merge.ts`.`` with ``- `people` holds no contact ids, so `src/lib/contact-merge.ts` needs no change.``
3. In section 5, replace the first bullet with:
   ``- Named people are matched by email through `contact_identities` (`findIdentityOwners`) **when they are read** (`resolvePeople`, `src/lib/email-intel/resolve.ts`) and the result is never stored. A stored id inside a JSON column would go stale on `mergeContacts`/`unmergeContacts` (which repoint child rows by id and cannot see inside JSON), dangle on deletion, and miss a contact added after the email; a lookup has none of those problems, because merge already moves the `contact_identities` rows.``
4. In section 6, replace the **Candidates** bullet with:
   ``- Candidates: people on the thread (the model's named people plus the addresses on the thread's headers), contacts at the event's company (a direct query on the normalised company key, suffixes stripped, not `findOrgRosters`, which resolves a company named inside a question), and a lexical `hybridSearchContacts` on the role's words with `embedding: null` so no embedding call is made.``
5. In section 6, replace the **Features** bullet with:
   ``- Features: on the thread, same or target company (`loadTargetKeys`), seniority (`seniorityOf`, counted only for people at the company or on the thread, and by event kind), a title/role word match, goal fit (`goalRelevanceComponent`), closeness tier, and a profile-search match for people found only that way. Warm path is not used (every candidate is already in the network) and recency is left to Radar's own scorer.``

Verify:

```bash
grep -c "resolved when read and never stored" docs/superpowers/specs/2026-09-30-email-intelligence-design.md
grep -c "needs no change" docs/superpowers/specs/2026-09-30-email-intelligence-design.md
grep -c "not \`findOrgRosters\`" docs/superpowers/specs/2026-09-30-email-intelligence-design.md
grep -c "Warm path is not used" docs/superpowers/specs/2026-09-30-email-intelligence-design.md
```

Expected: `1` for each.

- [ ] **Step 2: Static checks and the suite**

```bash
npx tsc --noEmit 2>&1 | grep -v "^npm notice"; echo "== tsc done"
git diff --name-only claude/email-intel-ai-extraction HEAD -- '*.ts' '*.tsx' | grep -E '^(src|scripts)/' | xargs npx eslint --max-warnings=0 2>&1 | grep -v "^npm notice"; echo "== eslint done"
npx tsx scripts/run-smoke.ts --check 2>&1 | tail -1
LOG=$(mktemp); npx tsx scripts/run-smoke.ts --ci > "$LOG" 2>&1; echo "suite exit $?"; grep -E "^FAIL|passed in" "$LOG"
```

(Run the suite in the background; it takes about seven minutes.) Expected: no type errors, no lint output for the changed files (the repo has unrelated warnings elsewhere), manifest complete, every smoke green. If one fails, run it alone three times and read its output before calling it a flake: in this series two of four suite failures were real bugs in a new smoke, and the rest were wall-clock checks under load.

- [ ] **Step 3: Confirm the branch is inert**

```bash
git diff claude/email-intel-ai-extraction HEAD --stat -- src/db scripts/schema-ddl.lock.json .github src/app src/actions src/components | tail -1
grep -rln "email-intel/\(resolve\|rank\|relevance\)" src --include=*.ts --include=*.tsx | grep -v "^src/lib/email-intel/"
```

Expected: both print nothing. No schema, workflow, route, action or component changed, and nothing outside `src/lib/email-intel/` imports the new modules yet. That is intended: P4 is the first consumer. A build is therefore not needed for this branch; `tsc` and the suite cover it.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-30-email-intelligence-design.md
git commit -m "docs(email-intel): people are resolved on read; record how candidates are sourced

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Deferred (each needs its own plan)

| Work | Why it is not here |
|---|---|
| **Radar signals and accept-to-task (P4)** | The first consumer. It reads `email_events`, calls `resolvePeople` for the "add to Orbit" chips and `rankEventContacts` (with one shared `RankContext` per account per pass) for the people behind each card, and maps events to Radar's existing card kinds. Until then nothing here is reachable by a user. |
| **Search over extracted context (P5)** | Uses `resolvePeople` at index time to fill `memory_chunks.contact_ids`. |
| **Role function** | Needs `src/lib/role-function.ts` from `claude/constellation-render-clustering-b81406`. Replaces the title-word match in `relevance.ts` without changing its interface. |
| **A model rerank of the shortlist** | The spec allows a bounded Jev/LLM rerank with the deterministic order as the fallback. It should be measured against this ordering first, using the decision-model harness, not assumed to help. |
| **Weight tuning** | The weights are a first judgement. Radar's feedback loop (accepts and dismissals per reason code) is the right way to tune them once P4 is live; the reason codes here (`on_thread`, `same_company`, `seniority_*`, `role_match`, `goal_match`, `closeness_*`, `search_match`) are stable identifiers for that. |

## Self-review

- **Spec section 5:** email matching through `contact_identities` (Task 1); unmatched people are suggestions only and nothing creates a contact (Task 1's `suggestAdd` flag, no writes); the plan-cap rule is moot because nothing is created here. The stored-`contact_id` wording is replaced, with the reason, in Task 4.
- **Spec section 6:** a pure module modelled on `scoreAttendee` (Task 2); candidates from the thread, the company and a profile search (Task 3); the listed features, with warm path and recency dropped for stated reasons; reasons `{code, label, points}` and stable ordering (Tasks 2 and 3); top three by default (Task 3); `seniorityOf` first, role function later; the optional rerank is deferred.
- **Constraints:** every query carries `user_id` (asserted in Tasks 1 and 3); candidate rows select no prose; reads are batched (three candidate reads and one row load per event, two shared context reads per pass); no model or network call anywhere; no schema, route or copy change.
- **Placeholders:** none. The judgement calls (the lexical arm's matching rules, `listActiveGoalTextsForUser`'s return type, the PGlite parameter behaviour) each name the thing to check and the side to change.
- **Type consistency:** `ResolvedPerson`, `normalizedEmail`, `resolveEmails`, `resolvePeople` are defined in Task 1 and used unchanged in Task 3; `EmailRelevanceInput`, `EmailRelevanceResult`, `EmailRelevanceBucket`, `significantWords`, `stemOf`, `scoreEmailContact` are defined in Task 2 and used unchanged in Task 3; `RankContext`, `RankableEvent`, `RankedEventContact`, `loadRankContext`, `rankEventContacts` are defined in Task 3 and named the same in the Deferred table and the spec edits. `RankableEvent` is satisfied by an `email_events` row plus its `threadRowId`.

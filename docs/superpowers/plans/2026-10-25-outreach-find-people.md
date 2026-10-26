# Outreach + Find people Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Find people's cited discovery and the direct-email outbox into one Outreach flow: describe → find → draft → send from your own mailbox → see who replied. This replaces Outreach v1 in place.

**Architecture:**
- Discovery is `discoverPeople` (web search on the account's AI key) through `/api/research`.
- People added to a campaign are `outreach_prospects` rows. Their web-derived facts go in `enrichment` jsonb.
- Messages are `outreach_messages` rows that send through `enqueueEmail` as a new `outreach` origin. A hook mirrors each outcome back onto the row.
- Replies are detected on demand from mailbox metadata. Follow-ups reply in the original thread.
- No schema change. v1's Apollo, Resend and Twilio paths are deleted once the new UI stands.

**Tech Stack:** Next.js (repo's version, read `node_modules/next/dist/docs/` first), React, drizzle on Postgres/Neon (PGlite locally), tsx smoke scripts (`scripts/smoke-*.ts`, each registered in `MANIFEST` in `scripts/run-smoke.ts`).

**Spec:** `docs/superpowers/specs/2026-10-25-outreach-find-people-design.md` (decisions D1–D13, invariants §6).

## Global Constraints

- Fresh worktree: run `npm ci` before anything (no `node_modules`). Read the relevant guide in `node_modules/next/dist/docs/` before writing page, route or action code (AGENTS.md).
- **No schema changes** (D9). Don't touch `SCHEMA_VERSION`, the DDL template, or `scripts/schema-ddl.lock.json`. If a task seems to need a column, stop and ask.
- **Tenancy:** every query on `outreach_prospects` / `outreach_messages` joins `outreach_campaigns` and filters `outreach_campaigns.user_id = userId`.
- **Gates:** every `page.tsx` under `/outreach` awaits `pageVisibilityGate("page.outreach")` first, then `getEntitlements(...).canUseOutreach`, and renders `<RenderStamp />`. Every outreach server action calls `requireOutreachUser()` (`@/lib/plan-guards`) first.
- **Layering:** work lives in `src/lib/outreach-*.ts` as `…ForUser(userId, …)` functions with injectable seams, and smokes call these directly. `src/actions/outreach-*.ts` are thin: guard → lib → `revalidatePath`. They are wrapped in `asActionResult` (`@/lib/errors`), and every export in a `"use server"` file is async.
- **User-facing copy:** throw `UserFacingError` with plain sentence-case copy and no trailing period (`smoke-toast-copy`). Use the `’` character, never an escape.
- **Untrusted text:** web-derived text (`whyMatches`, titles, companies, talking points) reaches a prompt only through the existing fenced `PROSPECT` block in `generateOutreachDraft`.
- **Limits** (all in `src/lib/outreach-types.ts`): `MAX_CAMPAIGN_PEOPLE = 100`, `MAX_DRAFTS_PER_RUN = 10`, `BULK_SEND_LIMIT = 25` (exists), `FOLLOW_UP_AFTER_DAYS = 7`, `LINKEDIN_NOTE_MAX = 300`, `REPLY_CHECKS_PER_PASS = 25`, `REPLY_CHECK_WINDOW_DAYS = 60`. `MAX_EXCLUDED_NAMES = 60` lives in `web-research.ts`.
- **Client search boxes:** clear the result when the input changes, and drop a stale in-flight response with a ticket ref.
- **Tests:** `npm test` must pass at the end of every task. Never pipe it through `tail`; zsh reports tail's exit code. Run `npx tsc --noEmit` and `npm run lint` too.
- **Smoke manifest:** every new `scripts/smoke-*.ts` gets a `MANIFEST` entry in `scripts/run-smoke.ts`. Use `"pglite"` if it touches the DB, `"pure"` otherwise. A deleted smoke loses its entry. `run-smoke` exits 2 on any mismatch, so `npm test` won't even start.
- **Contact writes outside a request:** every lib function that creates or updates a contact or logs an interaction takes `opts?: ContactWriteOptions` (`@/lib/contact-writes`) and passes it through. Smokes pass `{ skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true }`, as `smoke-web-research.ts` does; without it `revalidatePath` throws outside a request. `ContactInput` fields are `string | undefined`, so map `null` to `undefined`.
- **Commits:** one per task, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.

## Review Focus

1. **The same person added by two routes:** from `/find` with a LinkedIn URL, then from the campaign search without one. Expect one row. (Task 3 test `dedupes by name+company across identity kinds`.)
2. **Send pressed twice:** a double-click, two tabs, or a retry while queued. Expect exactly one email. (Task 5 test `concurrent sends claim once`.)
3. **The mailbox disconnects or the daily cap is hit mid-batch.** Expect the rest to stay drafts, with one clear reason and no pile of red rows. (Task 5 test `stops the batch on cap or connection`.)
4. **The recipient already exists as a contact.** Expect the prospect to pick up their email, and the send to land on that contact, never a duplicate. (Task 3 `links an existing contact`, Task 5 `no duplicate contact on send`.)
5. **A reply (or an out-of-office) arrives before day 7.** Expect no follow-up offer once anything came back. (Task 8 test `no follow-up after a reply`.) Ceiling: an auto-reply counts as a reply; noted with a `ponytail:` comment.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/company-name.ts` | modify | `companyKeySql()` |
| `src/lib/warm-paths-server.ts` | modify | `listed_there` keyed on `contacts.company` |
| `src/lib/web-research.ts`, `src/app/api/research/route.ts` | modify | discovery `exclude` |
| `src/lib/outreach-types.ts` | modify | new types, limits, statuses |
| `src/lib/outreach-people.ts` | create | add/skip/remove people, email, brief, contact, choices |
| `src/actions/outreach-people.ts` | create | thin actions for the above + warm paths |
| `src/lib/outreach-drafts.ts` | modify | cited details in the prompt, LinkedIn 300 |
| `src/lib/outreach-messages.ts` | create | draft, edit, send, LinkedIn, follow-up |
| `src/lib/email/origin-hooks/outreach.ts` | create | outbox outcome → message row |
| `src/lib/email/origins.ts`, `outbox.ts`, `origin-registrations.ts`, `src/db/schema.ts` (`EmailOrigin` union only) | modify | `outreach` origin |
| `src/lib/email/inbox-threads.ts` | modify | `repliedSince` |
| `src/lib/outreach-replies.ts` | create | reply check pass |
| `src/lib/outreach-followups.ts` | create | `followUpDue` (pure) |
| `src/lib/outreach-metrics.ts`, `outreach-metrics-sql.ts` | modify | reply rate, buckets |
| `src/actions/outreach-messages.ts` | create | thin actions |
| `src/actions/outreach.ts` | modify, then shrink | campaign CRUD only |
| `src/components/outreach/*` | new + delete | form, People, Messages, warm note |
| `src/components/find/*` | modify | shared `requestBrief`, Add to campaign |
| `src/app/(clerk)/(app)/(main)/outreach/**` | modify | pages |
| legacy (Task 14) | delete | Apollo/Resend/Twilio/SMS/wizard paths and their smokes |

---

### Task 1: Warm paths match punctuated company names

**Files:**
- Modify: `src/lib/company-name.ts` (append), `src/lib/warm-paths-server.ts` (the `companyRows` arm)
- Test: `scripts/smoke-warm-paths.ts`

**Interfaces:**
- Produces: `companyKeySql(column: string): string`, the SQL twin of `normalizeCompanyKey`. `findWarmPaths(userId, orgKeys)` is unchanged in signature, but now matches `contacts.company` by that key.

- [ ] **Step 1: Write the failing test.** In `smoke-warm-paths.ts`, seed a contact with `company: "Meta Platforms, Inc."`, no experience rows and no `company_id`, then:

```ts
const paths = await findWarmPaths(USER, orgKeysFor(["Meta Platforms, Inc."]));
check("listed_there matches a punctuated company", paths.get("meta platforms inc")?.[0]?.reason === "listed_there");
```

- [ ] **Step 2:** Run `npx tsx scripts/smoke-warm-paths.ts`. Expect FAIL. Main joins `companies.name_normalized`, which is lowercase-only.
- [ ] **Step 3: Implement.** Port the fix from the uncommitted worktree `claude-worktrees/orbit/warm-intro-finder-b3b30b` (`git -C <that path> diff -- src/lib/company-name.ts src/lib/warm-paths-server.ts`). Take only the company-key change:
  - `companyKeySql(column)` returns `trim(regexp_replace(regexp_replace(lower(<column>), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'))`, built for `sql.raw`.
  - The `companyRows` select uses `orgKey: sql<string>\`${sql.raw(companyKeySql("contacts.company"))}\`` and `orgLabel: sql<string>\`contacts.company\``. Its WHERE filters `contacts.user_id = userId and <key expr> in orgKeys`, and the `companies` join goes.
  - Leave out the intro-finder extras (`findWarmPathCandidates`, `closenessTier`, the avatar swap).
  - Add the file-header `ponytail:` note: unindexed, bounded by `user_id`.
- [ ] **Step 4:** Run the smoke again. Expect PASS. Then `npm test`.
- [ ] **Step 5: Commit** `fix(warm-paths): match punctuated company names on contacts.company`

---

### Task 2: "Find more": discovery that skips people already found

**Files:**
- Modify: `src/lib/web-research.ts` (`discoverPeople`), `src/app/api/research/route.ts`
- Test: `scripts/smoke-web-research.ts`

**Interfaces:**
- Produces: `discoverPeople(userId, input, options & { exclude?: string[] })`.
  - With a non-empty `exclude`, the user prompt gains a second fenced block, `fenceUntrusted("already_found", names.join("\n"))`, preceded by the line `Do not list any of these people again; find different people who match.`
  - Names are trimmed and deduped case-insensitively, each is cut to 100 chars, and the list is capped at `MAX_EXCLUDED_NAMES = 60`, a constant in web-research.ts.
  - The route passes `body.exclude` only when it is an array of strings, and `MAX_BODY_BYTES` becomes `8_192`.

- [ ] **Step 1: Write the failing tests.** Use the smoke's fake `researcher`, which captures `user`:

```ts
const seen: string[] = [];
const researcher: DiscoveryResearcher = async (_u, user) => { seen.push(user); return { json: '{"candidates":[]}', sources: [] }; };
await discoverPeople(USER, "PMs at Stripe", { researcher, exclude: ["Ana Ruiz", "ana ruiz ", "Bo Li"] });
check("exclude block is fenced and deduped", /ALREADYFOUND/.test(seen[0]) && seen[0].split(/ana ruiz/i).length === 2 && seen[0].includes("Bo Li"));
const many = Array.from({ length: 80 }, (_, i) => `Person ${i}`);
await discoverPeople(USER, "PMs at Stripe", { researcher, exclude: many });
check("exclude capped at 60", seen[1].includes("Person 59") && !seen[1].includes("Person 60"));
const a = await discoverPeople(USER, "PMs at Stripe", { researcher });
const b = await discoverPeople(USER, "PMs at Stripe", { researcher, exclude: ["Bo Li"] });
check("exclude changes the cache key", a.ok && b.ok && a.key !== b.key);
```

- [ ] **Step 2:** Run `npx tsx scripts/smoke-web-research.ts`. Expect FAIL (`exclude` is ignored).
- [ ] **Step 3: Implement** as described in Interfaces. The excluded names come from the user's own rows, but they were web-derived originally, so they stay fenced.
- [ ] **Step 4:** Run the smoke and `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(find): discovery can skip people already found`

---

### Task 3: People on a campaign

**Files:**
- Modify: `src/lib/outreach-types.ts`
- Create: `src/lib/outreach-people.ts`, `src/actions/outreach-people.ts`
- Test: `scripts/smoke-outreach-people.ts`

**Interfaces:**
- Produces, in `outreach-types.ts`:

```ts
export type ProspectOrigin = "find" | "manual" | "brief" | "legacy";
/** What `outreach_prospects.enrichment` holds for people added since this plan. */
export type ProspectEnrichment = {
  origin?: ProspectOrigin;
  /** The page that shows the match. Shown as a link; Orbit never fetches it. */
  url?: string | null;
  whyMatches?: string | null;
  /** `ai_result_cache` key of a person brief (`research.person`). */
  researchKey?: string | null;
  emailSource?: "contact" | "user" | null;
  demo?: boolean;
};
export type NewProspect = {
  fullName: string; title: string | null; company: string | null; email: string | null;
  linkedinUrl: string | null; location: string | null;
  origin: "find" | "manual" | "brief"; url: string | null; whyMatches: string | null; researchKey: string | null;
};
export const MAX_CAMPAIGN_PEOPLE = 100;
```

- Produces, in `outreach-people.ts`:
  - `prospectExternalId(p: { fullName: string; company: string | null; linkedinUrl: string | null }): string` returns `li:<lowercased slug>` when a LinkedIn `/in/` URL is present, else `prospectNameKey(p)`.
  - `prospectNameKey(p: { fullName: string; company: string | null }): string` always returns `name:<normalizeCompanyKey(fullName)>|<normalizeCompanyKey(company ?? "")>`.
  - `normalizeNewProspect(input: unknown): NewProspect | null`. Rules:
    - `origin` defaults to `"manual"` when missing or invalid.
    - Returns null without a 2–100-char `fullName`.
    - Returns null unless there is a company or a LinkedIn URL. A name alone is refused, the same rule as `/find`.
    - `title` ≤120, `company` ≤100, `whyMatches` ≤240. `url` must be http(s).
    - `linkedinUrl` must match `^https://([a-z]{2,3}\.)?linkedin\.com/in/[A-Za-z0-9\-_%]{2,100}/?$`.
    - `email` is lowercased. It is kept only if it matches `/^[^\s@"<>():]+@[^\s@"<>():]+$/` and passes `!isPlaceholderAddress`; otherwise it becomes null.
  - `addProspectsForUser(userId, campaignId, people: unknown[]): Promise<{ added: number; alreadyThere: number; invalid: number }>`. Steps:
    1. Requires ≤10 people per call.
    2. Requires that the campaign is the user's (UserFacingError `That campaign isn’t yours or no longer exists`).
    3. Counts existing `selected` rows. Over `MAX_CAMPAIGN_PEOPLE` → UserFacingError `A campaign holds up to 100 people`.
    4. For each person, runs `findConfidentDuplicate(userId, { fullName, company, email, linkedinUrl })` (`@/lib/contact-resolve`; map nulls to undefined). A match sets `contactId`, and takes the contact's email when the person has none (`emailSource: "contact"`).
    5. A person whose `prospectExternalId` **or** `prospectNameKey` matches an existing row in the campaign counts as `alreadyThere`. Existing rows' name keys are computed from their `fullName` and `company`. If that row was `excluded`, it flips back to `selected`.
    6. Inserts with `status: "selected"` and `ON CONFLICT (campaign_id, external_id) DO NOTHING`.
  - `skipCandidateForUser(userId, campaignId, person: unknown): Promise<void>` inserts the person, or updates the matching row, to `status: "excluded"`, so "Find more" won't bring them back.
  - `removeProspectForUser(userId, prospectId): Promise<void>` sets `excluded`. It refuses with `They’ve already been contacted, so they stay on the list` when any of their messages is `queued`, `sent` or `copied`.
  - `setProspectEmailForUser(userId, prospectId, email: string | null): Promise<void>`. It validates like `normalizeNewProspect`; a bad address gives `That address doesn’t look right`. It refuses after a send, and sets `emailSource: "user"`.
  - `attachBriefForUser(userId, prospectId, researchKey: string): Promise<void>`.
    - `loadResearchedPerson(userId, key)` must return a dossier, or UserFacingError `That brief has expired — research them again`.
    - Stores `researchKey`.
    - On `match === "confident"` it fills only-empty `title`, `company` and `linkedinUrl` from `dossier.current` and `dossier.subject`.
  - `campaignKnownNamesForUser(userId, campaignId): Promise<string[]>` returns every prospect's `fullName` (selected and excluded), newest first, capped at 60.
  - `ensureProspectContactForUser(userId, prospectId, opts?: ContactWriteOptions): Promise<string>`.
    - Returns `contactId` when it is set.
    - With a `researchKey` on a confident brief, it calls `saveResearchedPersonForUser(userId, key, opts)`; the profile comes along, and the contact's source is `web_research`. If that returns `null` (the brief expired), it falls through to the next line.
    - Otherwise it calls `resolveOrCreateContact(userId, { fullName, company, title, location, email, linkedinUrl, source: "outreach" }, { source: "outreach", ...opts })`, with nulls mapped to undefined.
    - Either way it then sets the contact's email when the contact has none, and stamps `outreach_prospects.contact_id`.
- Produces, in `src/actions/outreach-people.ts` (`"use server"`): `addProspects(campaignId, people)`, `skipCandidate(campaignId, person)`, `removeProspect(prospectId)`, `setProspectEmail(prospectId, email)`, `attachBrief(prospectId, researchKey)`, and `warmPathsForCompanies(companies: string[])`.
  - `warmPathsForCompanies` is wrapped in `asActionResult` like the rest. Its data is a `Record<string, WarmPath[]>`: it caps at 20 companies, calls `findWarmPaths(userId, orgKeysFor(companies))`, and returns `Object.fromEntries` of the result.
  - Each mutating action revalidates `/outreach/${campaignId}`.

- [ ] **Step 1: Write the failing tests** in the new `smoke-outreach-people.ts`. Follow `smoke-email-origins.ts`: `import "./smoke/_env"`, `run(main)`, its own `check`, and `purgeUserData` before and after. Seed a campaign for `USER`, and one for `OTHER`, which has a prospect.

```ts
check("name alone is refused", normalizeNewProspect({ fullName: "Ana Ruiz" }) === null);
check("placeholder email dropped", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", email: "a@example.com" })?.email === null);
const r1 = await addProspectsForUser(USER, camp, [{ fullName: "Ana Ruiz", company: "ZS", origin: "find", url: "https://zs.com/team", whyMatches: "UNC MPH" }]);
const r2 = await addProspectsForUser(USER, camp, [{ fullName: "Ana Ruiz", company: "ZS", linkedinUrl: "https://www.linkedin.com/in/anaruiz", origin: "find" }]);
check("dedupes by name+company across identity kinds", r1.added === 1 && r2.alreadyThere === 1 && (await countRows(camp)) === 1);
await db.insert(schema.contacts).values({ userId: USER, fullName: "Bo Li", company: "IQVIA", email: "bo@iqvia.com" });
await addProspectsForUser(USER, camp, [{ fullName: "Bo Li", company: "IQVIA", origin: "manual" }]);
const bo = await prospectNamed(camp, "Bo Li");
check("links an existing contact", bo?.email === "bo@iqvia.com" && bo?.contactId != null);
await skipCandidateForUser(USER, camp, { fullName: "Cy Ng", company: "ZS", origin: "find" });
check("skipped names feed Find more", (await campaignKnownNamesForUser(USER, camp)).includes("Cy Ng"));
check("other tenant's campaign refused", await rejects(() => addProspectsForUser(USER, otherCamp, [{ fullName: "Di Ho", company: "ZS", origin: "manual" }])));
check("other tenant's prospect refused", await rejects(() => setProspectEmailForUser(USER, otherProspect, "x@y.org")));
check("100-person cap", await rejects(() => addProspectsForUser(USER, fullCamp, [{ fullName: "Ed Fu", company: "ZS", origin: "manual" }]), "up to 100"));
```

(`countRows`, `prospectNamed` and `rejects(fn, substring?)` are local helpers in the smoke. `fullCamp` is pre-seeded with 100 `selected` rows.)

- [ ] **Step 2:** Register `"smoke-outreach-people": "pglite"` in `MANIFEST`, then run `npx tsx scripts/smoke-outreach-people.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement** the types, the lib and the actions in Interfaces. Use one multi-row insert per call, as legacy `searchProspectsCore` does, and no per-row round trips.
- [ ] **Step 4:** Run the smoke, `npm test` and `npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5: Commit** `feat(outreach): add, skip and ready people on a campaign`

---

### Task 4: Drafts written from cited details

**Files:**
- Modify: `src/lib/outreach-drafts.ts`, `src/lib/outreach-types.ts`
- Create: `src/lib/outreach-messages.ts`
- Modify: `src/actions/outreach.ts`. Move the private `priorNotesForContacts` and `enrichmentSummary`, with their helpers `priorNoteSql` and `joinPriorNotes`, out to `outreach-messages.ts` as exports, and import them back.
- Create (test): `scripts/smoke-outreach-drafts.ts`
- Modify (test fixture): `scripts/fixtures/draft-prompt-goldens.json`, regenerated by `smoke-draft-prompts`

**Interfaces:**
- Consumes: `ProspectEnrichment` (Task 3), `loadResearchedPerson` (web-research), `listActiveGoalTextsForUser` (`@/lib/user-goals`), `loadWritingInstructions` (`@/lib/writing-instructions-store`). Writing instructions are loaded in `outreach-messages.ts` and passed in as `DraftInput.writingInstructions`. `outreach-drafts.ts` must not import the store; `smoke-writing-instructions` enforces this.
- Produces:
  - `DraftInput.prospect` gains `whyMatches?: string | null` and `talkingPoints?: string[]`. Both are rendered inside the existing `PROSPECT` fenced block, as `Why they fit: …` and `Recent: …` lines.
  - The `linkedin` rule in `channelRules` becomes "under 300 characters". `LINKEDIN_NOTE_MAX = 300` and `MAX_DRAFTS_PER_RUN = 10` are added to outreach-types.
  - `buildDraftPrompt(input: DraftInput, senderBlock: string | null): { system: string; user: string }` is extracted from `generateOutreachDraft`, which now calls it.
  - `export type Drafter = (userId: string, inputs: DraftInput[]) => Promise<GeneratedDraft[]>`.
  - `draftCampaignMessagesForUser(userId, campaignId, prospectIds: string[], opts?: { drafter?: Drafter }): Promise<{ drafted: number; skipped: number }>`. Rules:
    - The default drafter is `generateOutreachDraftsBatch`.
    - Over 10 ids → UserFacingError `Write up to 10 drafts at a time`.
    - Only `selected` prospects of the user's campaign are drafted.
    - A prospect whose step-0 message is not `draft` (or legacy `generated`) is `skipped`, and its message is never touched (invariant 4).
    - The channel is `campaign.defaultChannel` (`email` | `linkedin`).
    - Talking points come from the brief, when `researchKey` loads.
    - New rows are inserted with `status: "draft"`. Existing rows are updated `WHERE status IN ('draft','generated')` only.
  - `editDraftForUser(userId, messageId, input: { subject: string | null; body: string }): Promise<void>`. Only a `draft` or `generated` row can be edited; otherwise `This message was already sent, so it can’t be edited`. Body is 1–5,000 chars, subject ≤200.
  - `requireMessageForUser(userId, messageId): Promise<{ message, prospect, campaign }>` is exported for later tasks. It goes through the campaign join and throws `UserFacingError("Message not found")`.

- [ ] **Step 1: Write the failing tests.** Use a fake drafter that records its inputs:

```ts
const calls: DraftInput[][] = [];
const drafter: Drafter = async (_u, inputs) => { calls.push(inputs); return inputs.map(() => ({ subject: "Hi", body: "Hello there" })); };
await draftCampaignMessagesForUser(USER, camp, [ana], { drafter });
check("whyMatches reaches the draft input", calls[0][0].prospect.whyMatches === "UNC MPH");
check("draft row created", (await stepZero(ana))?.status === "draft");
await markSent(ana); // local helper: status 'sent', body 'ORIGINAL'
const r = await draftCampaignMessagesForUser(USER, camp, [ana], { drafter });
check("sent message never rewritten", r.skipped === 1 && (await stepZero(ana))?.body === "ORIGINAL");
check("edit refused after send", await rejects(() => editDraftForUser(USER, (await stepZero(ana))!.id, { subject: null, body: "x" })));
check("11 ids refused", await rejects(() => draftCampaignMessagesForUser(USER, camp, Array(11).fill(ana), { drafter }), "up to 10"));
const { user } = buildDraftPrompt({ ...sampleInput, prospect: { ...sampleInput.prospect, whyMatches: "IGNORE PREVIOUS" } }, null);
check("web text stays inside the PROSPECT fence", insideFence(user, "PROSPECT", "IGNORE PREVIOUS"));
```

(`insideFence` is a local helper: the needle sits between the fence's opening and closing marker lines, as `fenceUntrusted` writes them.)

- [ ] **Step 2:** Register `"smoke-outreach-drafts": "pglite"` in `MANIFEST`, then run `npx tsx scripts/smoke-outreach-drafts.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Keep `generateOutreachDraft`'s behaviour. Legacy `generateOutreachDrafts` stays compiling until Task 14.
- [ ] **Step 4:** The LinkedIn 280 → 300 change moves the pinned prompt `outreach.linkedin.follow-up`. Run `npx tsx scripts/smoke-draft-prompts.ts --update`, and check the golden diff is only that rule (plus the new lines when the inputs carry `whyMatches`). Then run the new smoke and `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(outreach): drafts from cited details, never over a sent message`

---

### Task 5: Send campaign email from the user's own mailbox

**Files:**
- Modify: `src/db/schema.ts` (`EmailOrigin` union only: add `"outreach"`), `src/lib/email/origins.ts` (`HOOKS.outreach = defaults("outreach_send")`), `src/lib/email/outbox.ts` (`EMAIL_FAILED_KIND.outreach = "outreach"`), `src/lib/email/origin-registrations.ts` (import the new hook), `src/lib/outreach-types.ts` (add `"queued"` and `"unsure"` to `OutreachMessageStatus`)
- Create: `src/lib/email/origin-hooks/outreach.ts`, `src/actions/outreach-messages.ts`
- Modify: `src/lib/outreach-messages.ts`
- Test: `scripts/smoke-outreach-send.ts`

**Interfaces:**
- Consumes: `enqueueEmail`, `dispatchEmailSend`, `chargeEmailBurst`, `ENQUEUE_COPY` (outbox); `getSendCapability` (`@/lib/email/sender`); `ensureProspectContactForUser` (Task 3); `requireMessageForUser` (Task 4); `isDemoProspect`, `isPlaceholderAddress`, `DEMO_PROSPECT_SEND_MESSAGE` (`@/lib/outreach-quality`).
- Produces:
  - **Hook** `origin-hooks/outreach.ts`, modeled on `origin-hooks/recruiter.ts`:
    - `onSent` sets the `outreach_messages` row `id = send.originRef` to `status 'sent'`, `sentAt = send.sentAt ?? now`, `deliveryId = send.id`, `errorMessage null`.
    - `onFailed` with kind `ambiguous` sets `status 'unsure'` and `errorMessage` `May have sent — check your Sent folder before resending`. `unsure` is never re-claimed: the outbox's partial unique index would refuse its idempotency key as `duplicate` anyway.
    - `onFailed` with any other kind sets `status 'failed'`, with `errorMessage`:
      - `auth` → `Your email needs reconnecting before this can send`
      - anything else → `Your email provider didn’t accept this message`
  - `export type SendCampaignResult = { sent: number; pending: number; failed: { messageId: string; name: string; error: string }[] }`
  - `sendCampaignMessagesForUser(userId, campaignId, messageIds: string[], opts?: { fromName?: string | null; spacingMs?: number; contactWrite?: ContactWriteOptions }): Promise<SendCampaignResult>`. Algorithm (the order matters):
    1. Over `BULK_SEND_LIMIT` → `Send up to 25 at a time`. The campaign must be the user's, and `campaign.defaultChannel === "email"`.
    2. `getSendCapability(userId)`. When `!ok`, throw `ENQUEUE_COPY[reason]` before claiming anything, so no row moves and no contact is created (D8). Keep `remainingToday`.
    3. Charge `chargeEmailBurst(userId)` once. On refusal, throw its message.
    4. **Claim:** one `UPDATE outreach_messages SET status='queued', error_message=null, updated_at=now() WHERE id IN (…) AND status IN ('draft','generated','failed') AND prospect_id IN (SELECT id FROM outreach_prospects WHERE campaign_id = $campaign) RETURNING id`. Only returned ids go on. That one statement is the double-send guard; the campaign was ownership-checked in step 1. Claimed ids past `remainingToday` go straight back to `draft`, with one failed entry carrying `ENQUEUE_COPY.cap_reached`.
    5. Per claimed message, in `created_at` order:
       - Demo prospect → back to `draft`, failed entry `DEMO_PROSPECT_SEND_MESSAGE`.
       - No email, or a placeholder → back to `draft`, failed entry `Add an email address for <name> first`.
       - Otherwise call `ensureProspectContactForUser(userId, prospectId, opts.contactWrite)`, then `enqueueEmail(userId, { to: [email], subject: subject ?? "", bodyText: body, fromName, origin: "outreach", originRef: message.id, idempotencyKey: \`outreach:${message.id}\`, contactIds: [contactId], delayMs: 0, chargeBurst: false })`.
       - For `stepIndex === 1`, add the thread fields from Task 8.
    6. Enqueue refused with reason `cap_reached`, `not_connected`, `no_send_scope` or `needs_reauth` (a race after step 2) → this message and every remaining claimed one go back to `draft`. One failed entry carries `queued.message`, then stop. Any other refusal → this one is `failed` with `errorMessage = queued.message`.
    7. Enqueued → `dispatchEmailSend(id)`. `sent` counts; `retry` counts as `pending` (the hook settles it later); anything else is a failed entry `Couldn’t send to <name> — try again?`. Sleep `spacingMs` (default `1200`, matching the recruiter `SEND_SPACING_MS`) between messages.
  - `src/actions/outreach-messages.ts` (`"use server"`), created here, holds `draftMessages(campaignId, prospectIds)`, `editDraft(messageId, input)` (Task 4) and `sendMessages(campaignId, messageIds)`. `fromName` comes from `getCurrentUserProfile()` (`@/lib/auth`) `.name`, as `recruiter-messages.ts` does.

- [ ] **Step 1: Write the failing tests** in `smoke-outreach-send.ts`. Copy the fake gmail provider and the `gmailConnections` seed from `smoke-email-origins.ts` (`setProviderOverride("gmail", fake)`, scopes `GOOGLE_SCOPES.gmailSend`, its `resetBucket`), and import `../src/lib/email/origin-registrations`. Pass `spacingMs: 0` and `contactWrite: OPTS` (the Global Constraints flags) on every call; the snippet leaves them out for brevity. Seed prospects through `addProspectsForUser` and drafts through `draftCampaignMessagesForUser` with a fake drafter. "Bo Li" pre-exists as a contact with `bo@iqvia.com`.

```ts
const res = await sendCampaignMessagesForUser(USER, camp, [mBo], { spacingMs: 0 });
const row = await msg(mBo);
check("sent through the outbox", res.sent === 1 && row.status === "sent" && row.deliveryId != null);
const send = await db.query.emailSends.findFirst({ where: eq(schema.emailSends.id, row.deliveryId!) });
check("outreach origin, own mailbox", send?.origin === "outreach" && send.fromEmail === "me@x.org" && send.idempotencyKey === `outreach:${mBo}`);
check("no duplicate contact on send", (await contactsNamed("Bo Li")) === 1);
check("interaction on the timeline", (await interactionsForContactOf(mBo)).some((i) => i.source === "outreach_send"));
const [a, b] = await Promise.all([sendCampaignMessagesForUser(USER, camp, [m2], { spacingMs: 0 }), sendCampaignMessagesForUser(USER, camp, [m2], { spacingMs: 0 })]);
check("concurrent sends claim once", a.sent + b.sent === 1 && (await sendsFor(m2)) === 1);
check("resend of a sent message is a no-op", (await sendCampaignMessagesForUser(USER, camp, [mBo], { spacingMs: 0 })).sent === 0 && (await sendsFor(mBo)) === 1);
const none = await sendCampaignMessagesForUser(USER, camp, [mNoEmail], { spacingMs: 0 });
check("no email stays a draft", none.failed[0]?.error.includes("Add an email address") && (await msg(mNoEmail)).status === "draft");
await setGmailStatus("revoked");
check("disconnected mailbox refuses before claiming", await rejects(() => sendCampaignMessagesForUser(USER, camp, [m3, m4], { spacingMs: 0 })) && (await msg(m3)).status === "draft" && (await contactsNamed("M3 Person")) === 0);
await setGmailStatus("active");
await fillDailyCapLeaving(1); // local helper: insert sent email_sends rows so remainingToday === 1
const cut = await sendCampaignMessagesForUser(USER, camp, [m3, m4], { spacingMs: 0 });
check("stops the batch on cap or connection", cut.sent === 1 && cut.failed.length === 1 && (await msg(m4)).status === "draft");
await clearDailyCap();
fail = "permanent";
await sendCampaignMessagesForUser(USER, camp, [m5], { spacingMs: 0 });
check("provider refusal marks failed in Orbit's words", (await msg(m5)).status === "failed" && !(await msg(m5)).errorMessage!.includes("Gmail 400"));
fail = "ambiguous";
await sendCampaignMessagesForUser(USER, camp, [m6], { spacingMs: 0 });
check("ambiguous send is unsure and never re-claimed", (await msg(m6)).status === "unsure" && (await sendCampaignMessagesForUser(USER, camp, [m6], { spacingMs: 0 })).sent === 0);
fail = null;
check("demo prospect never sends", (await sendCampaignMessagesForUser(USER, camp, [mDemo], { spacingMs: 0 })).sent === 0 && (await sendsFor(mDemo)) === 0);
```

- [ ] **Step 2:** Register `"smoke-outreach-send": "pglite"` in `MANIFEST`, then run `npx tsx scripts/smoke-outreach-send.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** `EMAIL_FAILED_KIND` is `satisfies Record<EmailOrigin, …>`, so `tsc` points at it once the union grows. Then run `npx tsx scripts/smoke-email-origins.ts`.
- [ ] **Step 4:** Run `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(outreach): campaign email sends from your own mailbox through the outbox`

---

### Task 6: LinkedIn: copy, open, confirm

**Files:**
- Modify: `src/lib/outreach-messages.ts`, `src/actions/outreach-messages.ts`
- Test: `scripts/smoke-outreach-send.ts` (new `linkedin` section, on a second campaign with `defaultChannel: "linkedin"`)

**Interfaces:**
- Produces:
  - `copyLinkedInMessageForUser(userId, messageId): Promise<{ body: string; linkedinUrl: string }>`. It requires:
    - the campaign channel `linkedin`
    - a prospect `linkedinUrl` (else `Add their LinkedIn profile link first`)
    - `body.length <= LINKEDIN_NOTE_MAX` (else `LinkedIn notes are limited to 300 characters — shorten this one`)

    It sets `status 'copied'` only from `draft` / `generated`; a `copied` row returns as is.
  - `confirmLinkedInSentForUser(userId, messageId, opts?: ContactWriteOptions): Promise<void>`.
    - It goes `copied` → `sent` with `sentAt = now()`, in one conditional UPDATE … `RETURNING id`.
    - When the UPDATE matches nothing: a row already `sent` returns quietly (a double confirm), and a `draft` row refuses with `Copy the note first`. Only a matched UPDATE goes on, so the interaction is logged once. `logInteractionForUser` is a plain insert, so a repeat would hit `interactions_user_external_uidx` and throw.
    - Then it calls `ensureProspectContactForUser(userId, prospectId, opts)`.
    - Then it calls `logInteractionForUser(userId, { contactId, interactionType: "linkedin_message", direction: "out", source: "outreach_send", externalId: \`outreach:${messageId}\`, interactionDate: new Date(), rawNotes: body }, opts)` (`@/lib/contact-writes`).
  - Actions: `copyLinkedIn(messageId)` and `confirmLinkedInSent(messageId)`.

- [ ] **Step 1: Write the failing tests:** `copy needs a profile link`; `301-char note refused`; `confirm requires copy first`; `double confirm logs one interaction`; `confirm creates the contact once`.
- [ ] **Step 2:** Run the smoke. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the smoke and `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(outreach): LinkedIn notes are copied, opened and confirmed by hand`

---

### Task 7: Detect replies from mailbox metadata

**Files:**
- Modify: `src/lib/email/inbox-threads.ts`, `src/lib/outreach-types.ts` (outcome `"replied"`, `OUTCOME_LABELS.replied = "Replied"`, `REPLY_CHECKS_PER_PASS = 25`, `REPLY_CHECK_WINDOW_DAYS = 60`), `src/lib/rate-limit.ts` (`RATE_LIMITS.outreachReplyCheck = { limit: 1, windowSec: 600 }`, and `BUCKET_LABELS["outreach-reply-check"] = "reply check"`; labels are keyed by the scope string, and `smoke-consume-bucket-args` fails on an unlabeled scope)
- Create: `src/lib/outreach-replies.ts`
- Modify: `src/actions/outreach-messages.ts` (`checkReplies(campaignId)`), and `src/actions/outreach.ts` (`logMessageOutcome`)
  - It accepts `"replied"`.
  - It stops changing the prospect's `status` (today it writes `interested`, `not_interested` or `replied`). `selected` is what the cap, drafting and the People list key on, so an outcome lives on the message only.
  - It can change an outcome that's already set, which D12's refine needs.
- Test: `scripts/smoke-outreach-replies.ts`

**Interfaces:**
- Produces, in `inbox-threads.ts`:
  - `gmailReplyQuery(address: string, since: Date): string` → `from:<address> after:<Math.floor(since.getTime()/1000)>`.
  - `outlookReplyFilter(address: string, since: Date): string` → `from/emailAddress/address eq '<address with ' doubled>' and receivedDateTime ge <since.toISOString()>`.
  - `repliedSince(userId, provider: "gmail" | "outlook", address: string, since: Date): Promise<Date | null>`. Rules:
    - The address must pass the file's `EMAIL` regex.
    - Gmail: `messages?q=<query>&maxResults=1`, then reads that message's `internalDate`.
    - Outlook: `messages?$filter=<filter>&$top=1&$select=receivedDateTime`.
    - Uses the existing `gmailAccess` / `outlookAccess` and `getJson` (read scopes only). Never throws; any failure is `null`.
- Produces, in `outreach-replies.ts`:
  - `export type ReplyLookup = typeof repliedSince`.
  - `checkCampaignRepliesForUser(userId, campaignId, opts?: { now?: Date; lookup?: ReplyLookup; skipThrottle?: boolean }): Promise<{ checked: number; replied: number; throttled: boolean }>`. Steps:
    1. `consumeBucket("outreach-reply-check", \`${userId}:${campaignId}\`, RATE_LIMITS.outreachReplyCheck)`, unless `skipThrottle`. An `isRateLimitedError` returns `{ checked: 0, replied: 0, throttled: true }`.
    2. Picks the user's campaign's `email` messages with `status = 'sent'`, `outcome IS NULL`, and `sent_at` within 60 days. Oldest first, ≤25.
    3. Joins `email_sends` on `email_sends.id::text = outreach_messages.delivery_id` for `provider`, skipping `demo`. `delivery_id` is `text`, and v1 rows may hold non-uuid ids, so never cast it to uuid.
    4. For each one, `lookup(userId, provider, prospect.email, sentAt)`. A date sets `outcome 'replied'` and `repliedAt = date`, in one UPDATE guarded `outcome IS NULL`.
  - Add the comment `// ponytail: an auto-reply counts as a reply; telling them apart means reading bodies, which needs a privacy change`.

- [ ] **Step 1: Write the failing tests.**

```ts
check("gmail query", gmailReplyQuery("bo@iqvia.com", new Date(1_700_000_000_000)) === "from:bo@iqvia.com after:1700000000");
check("outlook filter escapes quotes", outlookReplyFilter("o'neil@x.org", new Date(0)).includes("'o''neil@x.org'"));
const seenAddrs: string[] = [];
const lookup: ReplyLookup = async (_u, _p, addr) => { seenAddrs.push(addr); return addr === "bo@iqvia.com" ? new Date() : null; };
const r = await checkCampaignRepliesForUser(USER, camp, { lookup });
check("reply detected", r.replied === 1 && (await msg(mBo)).outcome === "replied");
check("throttled within 10 minutes", (await checkCampaignRepliesForUser(USER, camp, { lookup })).throttled);
check("old sends not checked", !seenAddrs.includes("old@x.org")); // a message sent 61 days ago
check("other tenant's campaign checks nothing", (await checkCampaignRepliesForUser(USER, otherCamp, { lookup, skipThrottle: true })).checked === 0);
```

(Seed sent messages by setting `status`, `sentAt` and `deliveryId` directly, with `email_sends` rows `provider: "gmail"`. This smoke doesn't send.)

Also add: `outcome change keeps the prospect selected`. Call `logMessageOutcome`'s lib path, or the action under the demo user as `smoke-outreach-guards` does, to set `positive_reply`. The prospect's `status` is still `selected`, and the outcome can then change to `negative_reply`.

- [ ] **Step 2:** Register `"smoke-outreach-replies": "pglite"` in `MANIFEST`, then run `npx tsx scripts/smoke-outreach-replies.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the smoke and `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(outreach): notice replies from the mailbox, sender and date only`

---

### Task 8: One follow-up, in the same thread

**Files:**
- Create: `src/lib/outreach-followups.ts`
- Modify: `src/lib/outreach-messages.ts`, `src/actions/outreach-messages.ts`, `src/lib/outreach-types.ts` (`FOLLOW_UP_AFTER_DAYS = 7`)
- Test: `scripts/smoke-outreach-replies.ts` (new `follow-up` section); `scripts/smoke-outreach-send.ts` (thread check)

**Interfaces:**
- Produces:
  - `followUpDue(first: { stepIndex: number; status: string; sentAt: Date | null; outcome: string | null }, hasFollowUp: boolean, now: Date): boolean`. It is pure, and `outreach-followups.ts` imports nothing but `outreach-types`: client components import `outreach-metrics.ts`, which will import it. True only for a `stepIndex 0`, `sent` message, sent at least `FOLLOW_UP_AFTER_DAYS` ago, with `outcome == null`, and `!hasFollowUp`.
  - `draftFollowUpForUser(userId, firstMessageId, opts?: { drafter?: Drafter; now?: Date }): Promise<{ messageId: string }>`.
    - It requires `followUpDue`, else `A follow-up isn’t due for this person yet`.
    - It generates with `stepIndex: 1` and `previousBody: first.body`, inserts `{ stepIndex: 1, parentMessageId: first.id, status: "draft", channel: first.channel }`, and returns the id.
  - In `sendCampaignMessagesForUser`, for `stepIndex === 1` email:
    - `const target = parent.deliveryId ? await resolveReplyTarget(userId, \`orbit:${parent.deliveryId}\`) : null`
    - Enqueue with `subject: replySubject(target?.subject ?? parent.subject ?? "")`, `inReplyToRfcId: target?.rfcMessageId`, `inReplyToSendId: target?.inReplyToSendId`, `threadId: target?.thread?.threadId`, `provider: target?.thread?.provider`.
    - With no target, it sends as a fresh message with the `Re:` subject.
    - `resolveReplyTarget` and `replySubject` come from `@/lib/email/reply-targets`.
  - Action: `draftFollowUp(messageId)`.

- [ ] **Step 1: Write the failing tests:**
  - pure: `not due at day 6`; `due at day 7`; `no follow-up after a reply` (`outcome: "replied"`); `only one follow-up` (`hasFollowUp` true → false).
  - send smoke: `follow-up replies in thread`. After a first send, back-date `sent_at` 8 days, then `draftFollowUpForUser` and send. Check `email_sends.inReplyToSendId === parent.deliveryId` and that the subject starts with `Re:`.
- [ ] **Step 2:** Run both smokes. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the smokes and `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(outreach): one follow-up after a week, in the same thread`

---

### Task 9: Reply rate and pipeline buckets

**Files:**
- Modify: `src/lib/outreach-metrics.ts`, `src/lib/outreach-metrics-sql.ts`, `src/lib/outreach-types.ts` (`CampaignMetrics.successfulReplyRate` → `replyRate`; `PipelineFilter`).
- Modify the callers:
  - `outreach/page.tsx` and `[id]/page.tsx`
  - `outreach-campaign-card.tsx`, `campaign-kpi-strip.tsx`, `campaign-insights.tsx`, `campaign-workspace.tsx`
  - `pipeline-filters.tsx`, whose `PipelineFilter` values change
  - `src/actions/outreach.ts`, around `:249` and `:281`. `getOutreachPerformanceSummary` builds its own untyped `accountMetrics.successfulReplyRate` from positive replies only. Rename it to `replyRate` and recompute it with any-reply semantics by hand; `tsc` won't flag it.
  - `src/components/dashboard/dashboard-sections.tsx` (`:430`), which reads that summary
- Modify (tests): `scripts/smoke-bounded-reads.ts` (`:279-303`, which holds the existing SQL-vs-JS metrics parity), and `scripts/smoke-outreach-guards.ts` (`:225` asserts a `copied` row with `sentAt` counts as delivered; it now must not).
- Create (test): `scripts/smoke-outreach-metrics.ts` (pure)

**Interfaces:**
- Produces:
  - `hasReplyOutcome` is true for `replied | positive_reply | negative_reply | neutral_reply`.
  - `isDeliveredMessage` is true for `status === "sent"`. Legacy `copied` / `opened` stop counting. The v1 send guard in `actions/outreach.ts` (`:941`, `:1300`) also reads it; that's acceptable for an unreleased page whose UI Tasks 10–12 replace and whose code Task 14 deletes.
  - `ProspectMetricRow` gains `email` and `linkedinUrl`, and `prospectPipelineBucket` gains a `channel` parameter (today it is `(prospect, now)`).
  - `replyRate = replyCount / (sentCount − bouncedCount)`, or null when the denominator is 0.
  - `PipelineFilter = "all" | "needs_info" | "needs_draft" | "ready" | "waiting" | "follow_up_due" | "replied" | "failed"`.
  - `prospectPipelineBucket(prospect, channel, now)`:
    - `needs_info`: no email on email, or no `linkedinUrl` on LinkedIn.
    - `needs_draft`: no step-0 message.
    - `ready`: draft, generated or copied.
    - `waiting`: sent, no outcome, not due.
    - `follow_up_due`: `followUpDue`.
    - `replied`: any reply outcome.
    - `failed`: status failed.
  - `campaignMetricAggregates` (SQL) mirrors `replyCount`, `sentCount` and `bouncedCount` under the same rules.

- [ ] **Step 1: Write the failing tests:**
  - In `smoke-outreach-metrics.ts` (pure): a check for each bucket and the rate (`2 replies of 4 sent, 0 bounced → 0.5`; `0 sent → null`; a `copied` row is not delivered).
  - In `smoke-bounded-reads.ts`: extend its parity block with a `replied` outcome row and a `copied` row. `metricsFromAggregates` and `computeCampaignMetrics` must still agree on `sentCount`, `replyCount` and `replyRate`.
- [ ] **Step 2:** Register `"smoke-outreach-metrics": "pure"` in `MANIFEST`, then run both smokes. Expect FAIL.
- [ ] **Step 3: Implement.** Rename the field and fix each `tsc` error.
- [ ] **Step 4:** Run the smoke, `npx tsc --noEmit` and `npm test`. Expect PASS. If `smoke-behavior-golden` differs, re-record only after confirming the diff is these metric fields.
- [ ] **Step 5: Commit** `feat(outreach): reply rate counts any reply; buckets for the new flow`

---

### Task 10: Describe: the new-campaign form and the list

**Files:**
- Create: `src/components/outreach/new-campaign-form.tsx`
- Modify: `src/app/(clerk)/(app)/(main)/outreach/new/page.tsx` (render the form instead of `OutreachWizard`), `src/actions/outreach.ts` (`createCampaign`), `src/lib/outreach-types.ts` (`REPLY_CTA_LABELS`), `src/components/outreach/outreach-campaign-card.tsx`, `src/app/(clerk)/(app)/(main)/outreach/page.tsx`, `src/app/(clerk)/(app)/(main)/outreach/layout.tsx` (its copy still mentions SMS and Apollo)
- Delete: `src/components/outreach/outreach-wizard.tsx`. Its only importer is `new/page.tsx`, and it calls the old `createCampaign` shape, so it can't outlive this task without leaving `tsc` red.
- Create (test): `scripts/smoke-outreach-page.ts` (pure, structural, like `smoke-events-page.ts`; register it as `"pure"` in `MANIFEST`)

**Interfaces:**
- Produces:
  - `createCampaign(input: { name?: string; audienceQuery: string; messageIntent: string; replyCta: OutreachReplyCta; defaultChannel: "email" | "linkedin"; tone: (typeof OUTREACH_TONES)[number] })`:
    - Wrapped in `asActionResult`.
    - `audienceQuery` 3–300 chars, `messageIntent` 3–1,000 chars.
    - Name defaults to the audience cut to 60 chars.
    - No `parseAudienceToFilters` call (no LLM on create).
    - Returns `{ id }`; the form then `router.push(\`/outreach/${id}\`)`.
  - `REPLY_CTA_LABELS`: `book_intro` "A short chat", `ask_referral` "A referral", `get_feedback` "Advice on a question", `explore_partnership` "Exploring working together", `other` "Something else".
  - The list card shows name, audience, channel, people count, sent, replied, and `formatReplyRate(replyRate)`. The page header copy becomes `Reach people you don’t know yet — from your own email`.

- [ ] **Step 1: Write the failing test** in `smoke-outreach-page.ts`. It reads the page and component sources and asserts:
  - `new/page.tsx` imports `NewCampaignForm` and not `OutreachWizard`.
  - Inside each `/outreach/**/page.tsx`'s **default export** body, the first `await` is `pageVisibilityGate("page.outreach")`. Slice from `export default async function` onward: `[id]/page.tsx`'s `generateMetadata` awaits earlier in the file, and that's fine.
  - `createCampaign`'s body doesn't reference `parseAudienceToFilters`.
- [ ] **Step 2:** Run `npx tsx scripts/smoke-outreach-page.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** The form has five fields:
  - "Who do you want to reach?" (textarea, placeholder `UNC alumni doing health-economics consulting in RTP`)
  - "Why are you reaching out?"
  - Ask (chips)
  - Channel (Email / LinkedIn radio)
  - Tone (select)
  - Name is an optional field under a "More" disclosure.

  Use the existing `@/components/ui` field, input, textarea, select and button. Errors show inline via `friendlyError`.
- [ ] **Step 4: Verify.**
  - Run `npm test` and `npm run build`.
  - Browser check: localhost demo user, set `document.cookie = "orbit_preview_unreleased=1; path=/"`, open `/outreach/new`, create a campaign, and land on `/outreach/<id>`.
  - Use headless Chrome over CDP if the Browser pane is hidden, since occluded tabs never hydrate.
- [ ] **Step 5: Commit** `feat(outreach): describe a campaign in one form`

---

### Task 11: People tab: find, add, get ready

**Files:**
- Create: `src/components/find/request-brief.ts`. Move `requestBrief` out of `find-people.tsx` and import it back. Today it throws only the message, so its thrown `Error` now also carries `status` (the HTTP code) and `reason` (the route's `reason` field), letting callers tell no-AI (402) from rate-limited (429).
- Create: `src/components/outreach/warm-path-note.tsx` (move `WarmPathNote` out of `prospect-table.tsx` and import it back), `src/components/outreach/find-candidates.tsx`, `src/components/outreach/campaign-people.tsx`
- Modify: `src/components/find/find-people.tsx`, `src/components/outreach/prospect-table.tsx`, `src/app/(clerk)/(app)/(main)/outreach/[id]/page.tsx`
- Test: `scripts/smoke-outreach-page.ts` (extend)

**Interfaces:**
- Consumes: `requestBrief(body)` (`{ kind: "discover", query, exclude }` or `{ kind: "person", fullName, company, linkedinUrl }`), Task 3's actions, `getCampaign`.
- Produces:
  - `[id]/page.tsx` renders the header plus a tablist (`role="tablist"`, styled like `find-people.tsx:102`). It has two links: `?tab=people` (default) and `?tab=messages` (Task 12).
  - The page loads `warmPaths = Object.fromEntries(await findWarmPaths(userId, orgKeysFor(prospects.map((p) => p.company))))` and `knownNames` (`campaignKnownNamesForUser`).
  - `<CampaignPeople campaign channel prospects warmPaths knownNames canUseAi />`. Each person row shows:
    - name, title, company
    - why they fit, with a source link (`rel="noopener noreferrer nofollow"`)
    - `WarmPathNote`
    - an "Already in your network" badge when `enrichment.emailSource === "contact"`, or `contactId` was set before any send
    - a channel-readiness cell: an email input (Email), or a LinkedIn link / "Add LinkedIn link" input (LinkedIn)
    - "Research" (person brief → `attachBrief`) and Remove
  - `<FindCandidates campaignId audienceQuery knownNames />`:
    - "Find people" calls `requestBrief({ kind: "discover", query: audienceQuery })`. "Find more" passes `exclude: knownNames ∪ shown names`.
    - Rows: Add (`addProspects`) and Skip (`skipCandidate`).
    - After results arrive, it calls `warmPathsForCompanies` once for the shown companies.
    - States: idle, searching (`Searching the web — this can take a minute`), no results, no AI (402 → link to Settings AI), rate-limited (429 copy from the server).
    - A ticket ref drops stale responses.
  - "Add someone" is a small inline form: name, company or LinkedIn URL, optional email → `addProspects` with `origin: "manual"`.

- [ ] **Step 1: Write the failing structural tests:**
  - `find-people.tsx` and `find-candidates.tsx` both import `request-brief`.
  - `find-candidates.tsx` passes `exclude`.
  - `[id]/page.tsx` imports `findWarmPaths`.
  - No new component contains control bytes: `/[\x00-\x08\x0B\x0C\x0E-\x1F]/`.
- [ ] **Step 2:** Run the smoke. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**
  - Run `npm test` and `npm run build`.
  - Browser (preview cookie):
    - Add a person manually.
    - Type an email.
    - Remove a person.
    - Check the warm-path note shows for a person at a company a seeded demo contact works at.
    - Check "Find people" shows the no-AI state when the worktree has no AI key. A local `.env.local` key exercises the real search; don't commit keys.
  - Take a screenshot.
- [ ] **Step 5: Commit** `feat(outreach): find and ready people inside a campaign`

---

### Task 12: Messages tab: draft, send, track

**Files:**
- Create: `src/components/outreach/campaign-messages.tsx`
- Modify: `src/app/(clerk)/(app)/(main)/outreach/[id]/page.tsx` (`tab=messages`)
- Modify: `src/components/outreach/message-editor-row.tsx`
  - It takes a `status` prop; only `draft` / `generated` is editable.
  - Rewire it from the v1 `updateOutreachMessage` / `regenerateOutreachDraft` to `editDraft`, plus "Rewrite" → `draftMessages(campaignId, [prospectId])`.
  - Add a 300-char counter on LinkedIn.
- Modify: `src/components/outreach/outcome-controls.tsx`
  - The outcomes become Replied, Positive, Negative and Bounced. There is no "No reply"; no outcome means waiting.
  - It must allow changing an outcome that's already set. Today any outcome turns it into a read-only label (`:52`), which would make D12's refine impossible.
- Test: `scripts/smoke-outreach-page.ts` (extend)

**Interfaces:**
- Consumes: the actions `draftMessages`, `editDraft`, `sendMessages`, `copyLinkedIn`, `confirmLinkedInSent`, `checkReplies`, `draftFollowUp`, `logMessageOutcome`; `prospectPipelineBucket`; `getSendCapability(userId)` (`@/lib/email/sender`), loaded by the page for email campaigns only.
- Produces: `<CampaignMessages campaign channel rows sendCapability />` with two views, chosen by a segmented control.
  - **To send.** Selection checkboxes over people in `needs_draft` / `ready`.
    - "Write drafts" sends ≤10 selected ids. The button is disabled with a hint above 10.
    - Each draft is a `MessageEditorRow`.
    - Email: "Send selected" (≤25). Above it, a line from `sendCapability`: `From you@gmail.com · 37 of 200 left today`, or a "Connect your email" link to `/settings#settings-email` when `!ok`.
    - LinkedIn, per row: "Copy & open" calls `copyLinkedIn`, then `navigator.clipboard.writeText(body)` and `window.open(linkedinUrl, "_blank", "noopener")`. The row then shows "I sent it" → `confirmLinkedInSent`.
    - The per-message failures from `SendCampaignResult.failed` show inline on their rows. The toast summary is `Sent 3 · 1 needs attention`.
  - **Sent.** On mount, call `checkReplies(campaign.id)` once. A throttled call stays silent.
    - Each row: name, sent date (`RelativeTime`), and status (Waiting / Replied / Follow-up due / Failed / Unsure). Unsure shows its `errorMessage` and no Send button.
    - "Write follow-up" → `draftFollowUp`, then the follow-up appears in To send.
    - `OutcomeControls` sets or changes Replied, Positive, Negative or Bounced.
    - A "Check for replies" button.
    - Header KPIs: sent, replied, reply rate.

- [ ] **Step 1: Write the failing structural tests:**
  - `campaign-messages.tsx` calls `checkReplies` inside a `useEffect`.
  - The page calls `getSendCapability` only behind a `defaultChannel === "email"` check.
  - `message-editor-row.tsx` references `LINKEDIN_NOTE_MAX`.
- [ ] **Step 2:** Run the smoke. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**
  - Run `npm test` and `npm run build`.
  - Browser (preview cookie, demo mode, demo provider):
    - Draft one message. With no AI key, check the error state instead.
    - Edit it.
    - Send it. Locally, `demoWorkspaceEmail` must return an address for the demo provider to send, as in the direct-email P2 notes; revert any such tweak before commit.
    - Confirm the row moves to Sent.
    - On a LinkedIn campaign, check Copy & open and I sent it.
  - Take a screenshot.
- [ ] **Step 5: Commit** `feat(outreach): draft, send and track messages in one tab`

---

### Task 13: Add to campaign from Find people

**Files:**
- Create: `src/components/find/add-to-campaign.tsx`
- Modify: `src/lib/outreach-people.ts` (`listCampaignChoicesForUser`), `src/app/(clerk)/(app)/(main)/find/page.tsx`, `src/components/find/find-people.tsx` (DiscoveryCard rows and DossierCard)
- Test: `scripts/smoke-outreach-people.ts` (extend), `scripts/smoke-outreach-page.ts` (extend)

**Interfaces:**
- Produces:
  - `listCampaignChoicesForUser(userId): Promise<{ id: string; name: string; channel: "email" | "linkedin" }[]>` returns the 20 most recently updated campaigns whose `status !== "archived"`.
  - `/find/page.tsx` loads choices only when `canUseOutreach && (await isSurfaceLive(userId, "page.outreach"))` (`@/lib/surface-visibility`); otherwise it passes `[]`, and no button renders.
  - `<AddToCampaign person choices />` is a `DropdownMenu` (`@/components/ui/dropdown-menu`) listing campaigns.
    - Choosing one calls `addProspects(campaignId, [person])`. For a dossier, `origin: "brief"` and `researchKey: key`; for a discovery row, `origin: "find"` with `url` and `whyMatches`.
    - Toasts `Added to <name>` or `Already in <name>`.

- [ ] **Step 1: Write the failing tests:**
  - `choices exclude other tenants and archived`.
  - A structural check that `find/page.tsx` guards choices with `isSurfaceLive(userId, "page.outreach")`.
- [ ] **Step 2:** Run the smokes. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm test` and `npm run build`. In the browser, with the preview cookie and a campaign created in Task 10, open `/find` and check the Add to campaign menu renders.
- [ ] **Step 5: Commit** `feat(find): add a found or briefed person to a campaign`

---

### Task 14: Retire Outreach v1

**Files:** (the deletions are the deliverable; `tsc` finds the stragglers)
- Delete:
  - `src/lib/outreach-send.ts`, `outreach-sender.ts`, `outreach-email.ts`, `outreach-readiness.ts`, `outreach-readiness-server.ts`
  - `src/components/outreach/{audience-filters-editor,bulk-action-bar,danger-send-dialog,outreach-readiness-strip,campaign-workspace,prospect-table,pipeline-filters,campaign-insights,campaign-editor,outreach-actions}.tsx`. Check each has no importer left first; keep anything Tasks 10–12 still use. `outreach-wizard.tsx` already went in Task 10.
  - `scripts/smoke-outreach-{email,sender,readiness}.ts`, and their `MANIFEST` entries
- Modify:
  - `src/actions/outreach.ts`: keep `listCampaigns`, `getCampaign`, `getOutreachPerformanceSummary`, `createCampaign`, `updateCampaign` and `logMessageOutcome`. Delete `searchProspects`, `getOutreachApolloStatus`, `updateProspectSelection`, `generateOutreachDrafts`, `regenerateOutreachDraft`, `updateOutreachMessage`, `markMessageAction`, `generateDueFollowUps`, `sendOutreachMessageAction`, `previewBulkSendQuality`, `bulkSendOutreach`, `saveProspectAsContact` and `enrichProspect`, plus their private helpers.
  - `src/lib/outreach-types.ts`: drop `"sms"` from `OutreachChannel` and `OUTREACH_CHANNELS`, plus `DAILY_SEND_LIMIT`, `DEFAULT_SEQUENCE_STEPS`, `OutreachSearchSource` and `NormalizedProspect` if unused. Keep `AudienceFilters`; `schema.ts` types the column with it.
  - `src/lib/outreach-channels.ts`: drop SMS. Contact components that import it keep compiling.
  - `src/lib/apollo.ts`: delete `searchPeople`, `parseAudienceToFilters` and the demo-prospect generator if nothing else imports them. Keep `enrichPerson` and the contact-refresh path. `scripts/smoke-apollo-hosted-budget.ts` uses `searchPeople`: trim it to what survives, or delete it and its `MANIFEST` entry if that was its whole subject.
  - Remove the `outreach.overdue` alert ("Scheduled outreach is not sending") everywhere it lives: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts` (`:306`, the stat), the admin `health-live.tsx` (`:508`), and `scripts/smoke-ops-alerts.ts` (`:321`). No placeholder rows exist any more.
  - `src/lib/demo-data/seed.ts` (founder persona) and `src/lib/demo-data/gillings.ts` (`:762`, Gillings persona): reshape both personas' campaigns to the new model. Prospects get `enrichment: { origin: "find", whyMatches, url, demo: true }`; messages are `draft`, `sent` (with `sentAt`) or `sent` + `outcome "replied"`; no `scheduled` rows. `smoke-demo-data` expects 2 campaigns, which still holds.
  - Settings "Outreach keys" (`src/components/settings/…`, `src/actions/settings.ts`): remove the Resend and Twilio fields and their readiness copy. Keep the Apollo field (contact refresh). Leave the encrypted columns in place; purge already covers them.
  - `scripts/smoke-email-no-resend.ts`: `OUTREACH_ALLOWED` and `OUTREACH_READ_ONLY` become empty sets, so no file may import Resend for person mail. Update the header comment.
  - Rewrite `scripts/smoke-outreach-guards.ts` against the new paths:
    - a demo prospect never sends
    - a placeholder address stays a draft
    - every action in `outreach-people.ts` / `outreach-messages.ts` refuses while `page.outreach` is coming-soon (`setSurfaceComingSoon`)
  - Fix `smoke-agent-sends`, `smoke-batched-writes`, `smoke-bounded-reads`, `smoke-admin-analytics`, `smoke-honest-reporting`, `smoke-ai-guardrails`, `smoke-contact-delete` and `smoke-resend-rejection` to the surviving code.
  - `smoke-provider-exhaustive`'s allowlist pins line numbers in `outreach-readiness-server.ts` and `actions/settings.ts`, and flags stale entries. Remove and re-key those entries.
  - Delete a smoke only when its whole subject is gone, remove its `MANIFEST` entry, and say which in the commit body.

- [ ] **Step 1:** Delete and modify as listed.
- [ ] **Step 2:** Run `npx tsc --noEmit`. Fix every error by removing the dead use, not by re-adding code.
- [ ] **Step 3:** Run `grep -rn "RESEND_FROM_EMAIL\|outreachFromAddress\|getOutreachSendConfig\|searchPeople(\|twilio" src --include='*.ts' --include='*.tsx'`. Expect no outreach hits. Digest and waitlist Resend uses are fine; read each hit.
- [ ] **Step 4:** Run `npm test`, `npm run lint` and `npm run build`. Expect PASS. Then do a browser pass over `/outreach`, `/outreach/new`, `/outreach/<demo campaign>` (both tabs), `/find`, the dashboard (outreach-performance card) and `/settings#settings-outreach`.
- [ ] **Step 5: Commit** `refactor(outreach): retire v1 — Apollo search, Resend and Twilio sending, SMS, the wizard`

---

### Task 15: Release (Jason only; an agent stops here)

- [ ] **Privacy copy** in `src/app/(site)/(docs)/privacy/page.tsx`, the three changes in spec §7.1. Then bump `TERMS_VERSION` and `LEGAL_LAST_UPDATED` in `src/lib/legal.ts`, and regenerate `scripts/legal-pages.lock.json` via `smoke-legal-pages`.
- [ ] **Live acceptance** on a preview, with a real Gmail and then an Outlook, never the demo account:
  1. Describe a campaign.
  2. Find, add 3 people, type your own test addresses.
  3. Draft, send.
  4. Reply from one address, then "Check for replies".
  5. Set one `sent_at` back 8 days in the preview DB, then Write follow-up and send. It should land in the same thread.
  6. Run a LinkedIn campaign with Copy & open and I sent it.
- [ ] **Release** `page.find` and `page.outreach` together: a `/admin/product` live override first, then delete both `comingSoon: true` lines.
- [ ] **Close #183 and #186**, linking the spec.

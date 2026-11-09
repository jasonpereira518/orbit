# Leads P3: the Pipeline and the /leads Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A salesperson can save the people they want to reach (typed in, or found through Apollo), see them ranked by who on their team already knows them, ask that teammate for an intro, and turn a lead into a contact — all on the real `/leads` page, still behind the coming-soon gate.

**Architecture:** A user-scoped `leads` table (schema v92) whose identity columns are written by the same `identityKeysFor` that writes `contact_identities`, so the P2 warm-path SQL matches them by equality. A pure identity module, a server store, and a pipeline loader that ranks a whole list with P2's `warmPathsForTargets` (one read plus at most two statements). Server Actions in `src/actions/leads.ts`, gated like P2's. The page is server sections streaming into client components; a "Hidden from team" pill on the contact page; a demo team so localhost opens full.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), React 19, Tailwind v4, Base UI kit in `src/components/ui/`, Drizzle on Postgres/PGlite, runtime DDL in `src/db/index.ts`, `tsx` smokes registered in `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-22-leads-design.md` (Decisions, Data model `leads`, Modules, The warm-path query). P2's plan `docs/superpowers/plans/2026-09-22-leads-p2-teams.md` built everything this one calls.

**Branch:** `claude/leads-p3-pipeline`, stacked on `claude/leads-p2-teams` (PR #266). The PR targets that branch.

## Global Constraints

- `SCHEMA_VERSION` becomes **92**. 91 is claimed by `claude/calendar-connections-apple`; 90 is P2. Rescan every remote ref and every local worktree (`bash -c`, never zsh) before pushing and take the next free number.
- New table: Drizzle in `src/db/schema.ts` + `CREATE TABLE IF NOT EXISTS` with its indexes in the `DDL` template of `src/db/index.ts` + `scripts/setup-db.ts` `EXPECTED_TABLES` + a purge step + a seeded row in `scripts/smoke-purge.ts`. No `--` comments or `;` inside DDL strings. Never `db:push`. `npx tsx scripts/smoke-schema-ddl.ts --update` after any DDL change.
- This repo's `Db` type is a union: write `.returning()` bare and read fields off the full row.
- Lead identity columns are produced ONLY by `normalizeLeadInput` (which calls `identityKeysFor`); nothing else writes `email_normalized`, `linkedin_slug`, `phone_e164`. Company key = `normalizeCompanyName(displayCompanyName(raw))`, `resolveCompany`'s rule.
- Pure modules never value-import `@/db` (type imports are fine): `src/lib/leads/{warm-path,target-input,warm-path-sql,lead-identity,intro-request,validate,apollo-leads}.ts`. Files in `src/components/leads/` never value-import a server module (`@/db`, `@/lib/teams`, `@/lib/leads/store`, `@/lib/leads/pipeline`, `@/lib/leads/warm-path-query`, `@/lib/apollo`).
- Every export of a `"use server"` file is an `async function` whose first statement is `const userId = await requireLeadsUser();`. No `export type`, no `export const`. Return types that are object literals get a local (non-exported) type alias, because the structural smoke reads up to the first `{`.
- Writes return `ActionResult` via `asActionResult`; reads return plain data. A `PaywallError` from the contact cap is turned into a `UserFacingError` so its message reaches the person.
- `UserFacingError` and toast copy passes `smoke-toast-copy`: no trailing period, curly ’ never a straight apostrophe, " — " joins an outcome to a next step, never "could not" or "failed". Toasts come from `@/lib/toast`, never `sonner` directly; errors through `friendlyError(err, fallback)`.
- Privacy (spec Decisions): the page shows a teammate's name, closeness tier ("Inner orbit" / "Mid orbit" / "Outer orbit"), how they matched, and "knows N others at Company" — never a teammate's email except inside the intro `mailto:` link, never a closeness score.
- `/leads/page.tsx`: the first `await` in the file is `await pageVisibilityGate("page.leads")`; async section components are declared BELOW the default export; `loading.tsx` renders `LeadsHeader`.
- Every new smoke is registered in `MANIFEST` in `scripts/run-smoke.ts`; `npx tsx scripts/run-smoke.ts --check` passes.
- Never pipe `npm test` through `tail`: zsh reports tail's exit code. Redirect to a file and grep `^ *FAIL`.
- Implementers never run `next dev`, `next build` or any drizzle push; the controller does the build and the browser check in Task 13.
- Commit after every task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings against the spec (recorded here so reviewers judge them, not rediscover them)

1. The store is `src/lib/leads/store.ts`, not `src/lib/leads.ts`: a file beside the `src/lib/leads/` directory would shadow it for `@/lib/leads`.
2. Pipeline ranking reuses P2's `warmPathsForTargets` (one leads read + at most two statements) instead of a new LATERAL statement. Same "never one query per lead" property, no second copy of the privacy SQL.
3. "Add to contacts" goes through `resolveOrCreateContact`, not `createContactForUser`, so a lead who is already a contact is matched instead of duplicated.
4. `source` is typed `"manual" | "apollo" | "crm"` now; `crm` rows and `crm_record_id` arrive in P4.
5. "Find a path" reuses P2's `lookupWarmLead` action; P3 adds only the save.

---

## File map

| File | Responsibility |
|---|---|
| `src/db/schema.ts`, `src/db/index.ts`, `scripts/setup-db.ts` | the `leads` table, v92 |
| `src/lib/user-data.ts`, `src/lib/data-categories.ts` | leads join the `leads` purge category |
| `src/lib/leads/lead-identity.ts` (pure) | `normalizeLeadInput`, `coerceLeadInput`, `leadTargetIdentity` |
| `src/lib/leads/intro-request.ts` (pure) | `introRequestMailto` |
| `src/lib/leads/validate.ts` (pure) | `isUuid`, `LEAD_STATUSES`, `isLeadStatus` |
| `src/lib/leads/store.ts` | `saveLead`, `listLeads`, `getLead`, `setLeadStatus`, `convertLeadToContact` |
| `src/lib/leads/pipeline.ts` | `loadPipeline` |
| `src/lib/leads/apollo-leads.ts` (pure) | Apollo form → filters, prospect → lead input / view |
| `src/actions/leads.ts` | the Leads Server Actions |
| `src/components/leads/*` | `warmth-chip`, `path-summary`, `sharing-dl`, `labels`, `team-panel`, `join-team-card`, `team-card`, `find-path`, `leads-pipeline`, `lead-detail-sheet`, `apollo-search` |
| `src/components/loading/page-skeletons.tsx` | `TeamPanelSkeleton`, `LeadsPipelineSkeleton` |
| `src/app/(clerk)/(app)/(main)/leads/{page,loading}.tsx` | the page |
| `src/components/contacts/team-share-button.tsx`, `contact-stat-pills.tsx`, `contacts/[id]/page.tsx` | the "Hidden from team" pill |
| `src/lib/demo-data/team.ts`, `src/lib/demo-data/seed.ts` | the demo team |
| `scripts/smoke-warm-path.ts` (pure), `scripts/smoke-leads.ts` (pglite, new), `scripts/smoke-leads-page.ts` (pure), `scripts/smoke-demo-data.ts`, `scripts/smoke-purge.ts` | tests |

---

### Task 1: The `leads` table (schema v92) and its purge

**Files:**
- Modify: `src/db/schema.ts` (after the `TeamMember` type, ~line 4598)
- Modify: `src/db/index.ts` (DDL template after the `team_members` block ~line 1340; changelog + version ~line 1785-1793)
- Modify: `scripts/setup-db.ts` (`EXPECTED_TABLES` tail)
- Modify: `src/lib/user-data.ts` (the `leads` step, ~line 275), `src/lib/data-categories.ts` (the `leads` meta, ~line 75)
- Modify: `scripts/smoke-purge.ts` (`seed()`, after the team seed ~line 650)
- Regenerate: `scripts/schema-ddl.lock.json`

**Interfaces:**
- Produces: `leads` Drizzle table; types `Lead`, `LeadStatus` (`"open" | "intro_requested" | "converted" | "dismissed"`), `LeadSource` (`"manual" | "apollo" | "crm"`), all exported from `@/db/schema`.

- [ ] **Step 1: Add the Drizzle definition**

In `src/db/schema.ts`, directly after `export type TeamMember = typeof teamMembers.$inferSelect;` add:

```ts
export type LeadSource = "manual" | "apollo" | "crm";
export type LeadStatus = "open" | "intro_requested" | "converted" | "dismissed";

/**
 * A person the user wants to reach, before (or instead of) they become a contact. Kept apart
 * from `contacts` on purpose: a pipeline of cold targets must not flood the network, the
 * constellation, or the free plan's contact cap. "Add to contacts" sets `contact_id` and the
 * row stays as history.
 *
 * The identity columns are written only by `normalizeLeadInput` (src/lib/leads/lead-identity.ts),
 * which uses the same `identityKeysFor` that writes `contact_identities` — so the warm-path SQL
 * matches a lead to a teammate's contact by plain equality. `source = 'crm'` and a
 * `crm_record_id` column arrive with the CRM sync (P4).
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    source: text("source").$type<LeadSource>().notNull(),
    /** Set by "Add to contacts". The lead stays, as history. */
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    email: text("email"),
    /** `identityKeysFor`'s email value; null for a role mailbox or no address. */
    emailNormalized: text("email_normalized"),
    linkedinUrl: text("linkedin_url"),
    linkedinSlug: text("linkedin_slug"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    companyName: text("company_name"),
    /** `companies.name_normalized` form, for "who knows anyone at this company". */
    companyNormalized: text("company_normalized"),
    title: text("title"),
    /** Apollo's person id, so a repeated search never saves the same person twice. */
    apolloId: text("apollo_id"),
    status: text("status").$type<LeadStatus>().default("open").notNull(),
    /** The user's own note on the target. Never shared. */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("leads_user_status_idx").on(t.userId, t.status, t.updatedAt.desc()),
    index("leads_user_email_idx").on(t.userId, t.emailNormalized),
    index("leads_user_linkedin_idx").on(t.userId, t.linkedinSlug),
    /** Without this, deleting a contact scans the table (see `contact_identities_contact_idx`). */
    index("leads_contact_idx").on(t.contactId),
    uniqueIndex("leads_user_apollo_uidx")
      .on(t.userId, t.apolloId)
      .where(sql`apollo_id is not null`),
  ]
);

export type Lead = typeof leads.$inferSelect;
```

- [ ] **Step 2: Watch the DDL coverage smoke fail**

Run: `npx tsx scripts/smoke-schema-ddl.ts`
Expected: FAIL — `leads.*` columns have no DDL and `leads_user_apollo_uidx` has no `CREATE UNIQUE INDEX`.

- [ ] **Step 3: Add the runtime DDL and bump the version**

(a) In the `DDL` template of `src/db/index.ts`, directly after the `team_members` block (after `CREATE INDEX IF NOT EXISTS team_members_team_sharing_idx ON team_members(team_id, share_network);`) add:

```sql
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  source text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  email text,
  email_normalized text,
  linkedin_url text,
  linkedin_slug text,
  phone text,
  phone_e164 text,
  company_name text,
  company_normalized text,
  title text,
  apollo_id text,
  status text NOT NULL DEFAULT 'open',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_user_status_idx ON leads(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS leads_user_email_idx ON leads(user_id, email_normalized);
CREATE INDEX IF NOT EXISTS leads_user_linkedin_idx ON leads(user_id, linkedin_slug);
CREATE INDEX IF NOT EXISTS leads_contact_idx ON leads(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_user_apollo_uidx ON leads(user_id, apollo_id) WHERE apollo_id IS NOT NULL;
```

(b) Directly above `export const SCHEMA_VERSION = 90;`, after the paragraph that begins `// 90 = teams, team_members, ...`, add:

```ts
//
// 91 (claude/calendar-connections-apple) is claimed on a branch that had not merged when
// this was written.
//
// 92 = leads: the Leads pipeline — manual and Apollo targets, ranked by who on the team
// knows them. P3 of docs/superpowers/specs/2026-09-22-leads-design.md. Rescanned every
// remote ref and every local worktree on Sep 23 2026; 92 was free.
```

and change the constant to `export const SCHEMA_VERSION = 92;`.

(c) In `scripts/setup-db.ts` `EXPECTED_TABLES`, after `"team_members",` add `"leads",`.

- [ ] **Step 4: Regenerate the lock and run the schema smokes**

Run:
```bash
npx tsx scripts/smoke-schema-ddl.ts --update && npx tsx scripts/run-smoke.ts --only smoke-schema-ddl smoke-schema-upgrade
```
Expected: both `ok`.

- [ ] **Step 5: Watch the purge smoke fail, then purge leads**

Run: `npx tsx scripts/run-smoke.ts --only smoke-purge`
Expected: FAIL with `not seeded: leads`.

In `scripts/smoke-purge.ts` `seed()`, directly after the `teamMembers` insert, add:

```ts
  await db.insert(schema.leads).values({
    userId: USER,
    source: "manual",
    displayName: "Grace Hopper",
    emailNormalized: "grace@navy.test",
  });
```

In `src/lib/user-data.ts`, add `leads,` to the `@/db/schema` import list, and change the `leads` step's first three lines to:

```ts
  leads: {
    exports: [own(teamMembers), own(leads)],
    counts: [teamMembers, leads],
    run: async (db, userId) => {
      await db.delete(leads).where(eq(leads.userId, userId));
```

(the rest of the step — memberships, the sentinel rewrite, the empty-team sweep — is unchanged).

In `src/lib/data-categories.ts`, replace the `leads` entry's description with:

```ts
    description:
      "The people you saved to reach, and your place on your company's team. Teammates stop seeing whether you know the people they look up, and the team itself is removed once nobody is left in it.",
```

- [ ] **Step 6: Run every purge and export smoke, typecheck, commit**

Run:
```bash
npx tsx scripts/run-smoke.ts --only smoke-purge smoke-purge-selective smoke-purge-resume smoke-data-export && npx tsc --noEmit
```
Expected: 4/4 `ok`; tsc silent.

```bash
git add src/db/schema.ts src/db/index.ts scripts/setup-db.ts scripts/schema-ddl.lock.json src/lib/user-data.ts src/lib/data-categories.ts scripts/smoke-purge.ts
git commit -m "Add the leads table (schema v92), purged with the leads category

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure lead identity, the intro ask, and input checks

**Files:**
- Create: `src/lib/leads/lead-identity.ts`, `src/lib/leads/intro-request.ts`, `src/lib/leads/validate.ts`
- Modify: `scripts/smoke-warm-path.ts` (new sections before the "client-bundle safety" section; three files added to its list)

**Interfaces:**
- Consumes: `identityKeysFor`, `IdentityKind` (`@/lib/duplicates`); `displayCompanyName`, `normalizeCompanyName` (`@/lib/company-name`); `buildMailtoUrl` (`@/lib/outreach-channels`, whose only import is a type); `TargetIdentity` (`./warm-path`); `LeadStatus` (`@/db/schema`, type only).
- Produces:
  - `type LeadInput = { displayName: string; email?: string | null; linkedinUrl?: string | null; phone?: string | null; companyName?: string | null; title?: string | null }`
  - `type NormalizedLead` (fields below); `LEAD_FIELD_MAX = 200`
  - `normalizeLeadInput(input: LeadInput): NormalizedLead`
  - `coerceLeadInput(raw: unknown): LeadInput`
  - `leadTargetIdentity(lead: { emailNormalized; linkedinSlug; phoneE164; companyNormalized }): TargetIdentity`
  - `introRequestMailto({ teammateName, teammateEmail, leadName, leadCompany }): string`
  - `isUuid(value: unknown): value is string`, `LEAD_STATUSES: readonly LeadStatus[]`, `isLeadStatus(value: unknown): value is LeadStatus`

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-warm-path.ts`, add to the imports:

```ts
import { identityKeysFor } from "../src/lib/duplicates";
import {
  coerceLeadInput,
  LEAD_FIELD_MAX,
  leadTargetIdentity,
  normalizeLeadInput,
} from "../src/lib/leads/lead-identity";
import { introRequestMailto } from "../src/lib/leads/intro-request";
import { isLeadStatus, isUuid, LEAD_STATUSES } from "../src/lib/leads/validate";
```

(`displayCompanyName` and `normalizeCompanyName` are already imported; if `identityKeysFor` shares an existing `../src/lib/duplicates` import line, extend that line instead.) Add these sections directly before the `client-bundle safety` section:

```ts
  console.log("\nleads are written the way contact identities are");
  {
    const raw = {
      email: " Ada@Example.COM ",
      linkedinUrl: "https://www.linkedin.com/in/Ada-Lovelace/?trk=x",
      phone: "+1 (415) 555-0123",
    };
    const lead = normalizeLeadInput({
      displayName: "  Ada Lovelace ",
      ...raw,
      companyName: "  Analytical   Engines Ltd ",
      title: "Mathematician",
    });
    const keys = identityKeysFor(raw);
    const key = (kind: string) => keys.find((k) => k.kind === kind)?.value ?? null;
    check("the name is trimmed", lead.displayName === "Ada Lovelace");
    check("the email is its identity key", lead.emailNormalized === key("email") && lead.emailNormalized === "ada@example.com");
    check("the raw email is kept as typed, trimmed", lead.email === "Ada@Example.COM");
    check("the LinkedIn slug is its identity key", !!lead.linkedinSlug && lead.linkedinSlug === key("linkedin_slug"));
    check("the phone is its identity key", !!lead.phoneE164 && lead.phoneE164 === key("phone_e164"));
    check(
      "the company key is resolveCompany's",
      lead.companyNormalized === normalizeCompanyName(displayCompanyName("Analytical   Engines Ltd"))
    );
    const role = normalizeLeadInput({ displayName: "Sales", email: "sales@acme.test" });
    check("a role mailbox is kept but never matched", role.email === "sales@acme.test" && role.emailNormalized === null);
    const bare = normalizeLeadInput({ displayName: "Grace", email: "  ", companyName: "" });
    check("blanks are null", bare.email === null && bare.companyNormalized === null && bare.linkedinSlug === null);
    const target = leadTargetIdentity(lead);
    check(
      "a lead's target carries its identifiers and company",
      target.email === lead.emailNormalized &&
        target.linkedinSlug === lead.linkedinSlug &&
        target.phoneE164 === lead.phoneE164 &&
        target.companyNormalized === lead.companyNormalized
    );
    check("a long paste is cut to the field limit", normalizeLeadInput({ displayName: "x".repeat(500) }).displayName.length === LEAD_FIELD_MAX);
    const forged = coerceLeadInput({ displayName: 42, email: ["a@b.c"], title: "CTO" });
    check("forged input keeps only strings", forged.displayName === "" && forged.email === null && forged.title === "CTO");
    check("a missing body is an empty lead", coerceLeadInput(null).displayName === "");
  }

  console.log("\nthe intro ask");
  {
    const url = introRequestMailto({
      teammateName: "Alex Ng",
      teammateEmail: "alex@acme.test",
      leadName: "Jane Doe",
      leadCompany: "Northwind",
    });
    check("is a mailto to the teammate", url.startsWith("mailto:alex%40acme.test?"), url);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    check("asks for the intro by name", params.get("subject") === "Intro to Jane Doe?");
    check("greets the teammate by first name", (params.get("body") ?? "").startsWith("Hi Alex,"));
    check("names the company when known", (params.get("body") ?? "").includes("Jane Doe at Northwind"));
    const noCompany = new URLSearchParams(
      introRequestMailto({ teammateName: "Priya", teammateEmail: "p@acme.test", leadName: "Sam", leadCompany: null }).split("?")[1]
    );
    check("and leaves it out when not", (noCompany.get("body") ?? "").includes("you know Sam."));
  }

  console.log("\ninput checks");
  {
    check("a uuid passes", isUuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
    check("anything else fails", !isUuid("1; drop table leads") && !isUuid(42) && !isUuid(undefined));
    check("the four statuses, in order", LEAD_STATUSES.join(",") === "open,intro_requested,converted,dismissed");
    check("an unknown status fails", !isLeadStatus("won") && isLeadStatus("dismissed"));
  }
```

Add `"src/lib/leads/lead-identity.ts"`, `"src/lib/leads/intro-request.ts"`, `"src/lib/leads/validate.ts"` to the client-bundle file list.

- [ ] **Step 2: Watch it fail**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/leads/lead-identity'`.

- [ ] **Step 3: Write the three modules**

Create `src/lib/leads/lead-identity.ts`:

```ts
/**
 * How a lead is written. Its identifiers come from the SAME `identityKeysFor` that writes
 * `contact_identities`, so a teammate's contact matches a lead by plain equality in the
 * warm-path SQL — two normalisers would drift, and a drifted email is a lead nobody "knows".
 * Pure and client-safe.
 */
import { identityKeysFor, type IdentityKind } from "@/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";
import type { TargetIdentity } from "./warm-path";

export type LeadInput = {
  displayName: string;
  email?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
  companyName?: string | null;
  title?: string | null;
};

export type NormalizedLead = {
  displayName: string;
  email: string | null;
  emailNormalized: string | null;
  linkedinUrl: string | null;
  linkedinSlug: string | null;
  phone: string | null;
  phoneE164: string | null;
  companyName: string | null;
  companyNormalized: string | null;
  title: string | null;
};

/** Longest a free-text lead field may be: a pasted profile is not a name. */
export const LEAD_FIELD_MAX = 200;

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().slice(0, LEAD_FIELD_MAX);
  return trimmed ? trimmed : null;
}

export function normalizeLeadInput(input: LeadInput): NormalizedLead {
  const email = clean(input.email);
  const linkedinUrl = clean(input.linkedinUrl);
  const phone = clean(input.phone);
  const keys = identityKeysFor({ email, linkedinUrl, phone });
  const pick = (kind: IdentityKind) => keys.find((k) => k.kind === kind)?.value ?? null;
  const company = clean(input.companyName);
  const companyName = company ? displayCompanyName(company) || null : null;
  return {
    displayName: clean(input.displayName) ?? "",
    email,
    emailNormalized: pick("email"),
    linkedinUrl,
    linkedinSlug: pick("linkedin_slug"),
    phone,
    phoneE164: pick("phone_e164"),
    companyName,
    companyNormalized: companyName ? normalizeCompanyName(companyName) || null : null,
    title: clean(input.title),
  };
}

/** A lead posted from the client, kept to the fields and types a lead has. */
export function coerceLeadInput(raw: unknown): LeadInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    displayName: text(r.displayName) ?? "",
    email: text(r.email),
    linkedinUrl: text(r.linkedinUrl),
    phone: text(r.phone),
    companyName: text(r.companyName),
    title: text(r.title),
  };
}

/** The identifiers a stored lead contributes to a warm-path lookup. */
export function leadTargetIdentity(lead: {
  emailNormalized: string | null;
  linkedinSlug: string | null;
  phoneE164: string | null;
  companyNormalized: string | null;
}): TargetIdentity {
  return {
    email: lead.emailNormalized,
    linkedinSlug: lead.linkedinSlug,
    phoneE164: lead.phoneE164,
    companyNormalized: lead.companyNormalized,
  };
}
```

Create `src/lib/leads/intro-request.ts`:

```ts
/**
 * The intro ask, as a mailto link to the teammate who knows the lead. Deliberately just an
 * email in the person's own client: no request record, no notification, nothing a teammate
 * has to opt out of. An in-app request is a later phase. Pure and client-safe.
 */
import { buildMailtoUrl } from "@/lib/outreach-channels";

export function introRequestMailto(input: {
  teammateName: string;
  teammateEmail: string;
  leadName: string;
  leadCompany: string | null;
}): string {
  const first = input.teammateName.trim().split(/\s+/)[0] || input.teammateName;
  const at = input.leadCompany ? ` at ${input.leadCompany}` : "";
  return buildMailtoUrl({
    email: input.teammateEmail,
    subject: `Intro to ${input.leadName}?`,
    body: [
      `Hi ${first},`,
      "",
      `Orbit says you know ${input.leadName}${at}. Would you be up for introducing me? I can send a short blurb you can forward.`,
      "",
      "Thanks!",
    ].join("\n"),
  });
}
```

Create `src/lib/leads/validate.ts`:

```ts
/**
 * Checks on what a Server Action receives. Server Functions answer a direct POST, so an id
 * or a status is whatever the caller sent until it passes these. Pure.
 */
import type { LeadStatus } from "@/db/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export const LEAD_STATUSES: readonly LeadStatus[] = [
  "open",
  "intro_requested",
  "converted",
  "dismissed",
];

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Run the smoke and typecheck**

Run: `npx tsx scripts/smoke-warm-path.ts && npx tsc --noEmit`
Expected: every line `ok`; tsc silent. If the no-company check fails because the body text differs, the module is wrong — the check pins the sentence in Step 3.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/lead-identity.ts src/lib/leads/intro-request.ts src/lib/leads/validate.ts scripts/smoke-warm-path.ts
git commit -m "Write leads with contact identities' own normaliser, and add the intro ask

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The store and the pipeline

**Files:**
- Create: `src/lib/leads/store.ts`, `src/lib/leads/pipeline.ts`, `scripts/smoke-leads.ts`
- Modify: `scripts/run-smoke.ts` (`"smoke-leads": "pglite",` next to `"smoke-warm-paths"`)

**Interfaces:**
- Consumes: `leads`, `Lead`, `LeadSource`, `LeadStatus` (`@/db/schema`); `normalizeLeadInput`, `LeadInput`, `leadTargetIdentity` (Task 2); `resolveOrCreateContact`, `ResolveOptions` (`@/lib/contact-resolve`); `warmPathsForTargets` (`./warm-path-query`); `WARMTH_RANK`, `WarmPath` (`./warm-path`).
- Produces:
  - `PIPELINE_LIMIT = 500`
  - `type SaveLeadInput = LeadInput & { source: "manual" | "apollo"; apolloId?: string | null }`
  - `saveLead(userId, input: SaveLeadInput): Promise<{ lead: Lead; created: boolean }>`
  - `listLeads(userId, opts?: { statuses?: readonly LeadStatus[] }): Promise<Lead[]>`
  - `getLead(userId, leadId): Promise<Lead | null>`
  - `setLeadStatus(userId, leadId, status: LeadStatus): Promise<boolean>`
  - `convertLeadToContact(userId, leadId, options?: ResolveOptions): Promise<{ contactId: string; outcome: "created" | "matched" | "merged" | "linked" }>`
  - `type PipelineRow = { lead: Lead; path: WarmPath | null }`; `type Pipeline = { team: "ok" | "no_team" | "not_sharing"; rows: PipelineRow[] }`
  - `loadPipeline(userId, opts?: { statuses?: readonly LeadStatus[] }): Promise<Pipeline>`

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-leads.ts`:

```ts
/**
 * The leads pipeline against a real database: saving deduplicates by every identifier,
 * statuses are the owner's alone, "Add to contacts" matches before it creates, and the
 * pipeline ranks by who on the team knows each lead.
 *
 * Rows live under `smoke-leads-*` ids and the `smoke-leads.test` team, all removed in
 * `finally`. Do NOT run while `next dev` holds `.data/pglite` — PGlite is single-writer.
 *
 * Run: npx tsx scripts/smoke-leads.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, leads, teamMembers, teams, userSettings } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { identityKeysFor } from "../src/lib/duplicates";
import { isUserFacingError } from "../src/lib/errors";
import { loadPipeline } from "../src/lib/leads/pipeline";
import {
  convertLeadToContact,
  getLead,
  listLeads,
  saveLead,
  setLeadStatus,
} from "../src/lib/leads/store";
import { joinTeamWithDomain } from "../src/lib/teams";
import { ensureUserSettings } from "../src/lib/user-settings";

const V = "smoke-leads-viewer";
const MATE = "smoke-leads-mate";
const OTHER = "smoke-leads-other";
const USERS = [V, MATE, OTHER];
const DOMAIN = "smoke-leads.test";
/** Outside a request there is nothing to revalidate and no provider to call. */
const WRITE = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true };

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(leads).where(inArray(leads.userId, USERS));
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(companies).where(inArray(companies.userId, USERS));
  await db.delete(teamMembers).where(inArray(teamMembers.userId, USERS));
  await db.delete(teams).where(eq(teams.domain, DOMAIN));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function main() {
  const db = await getDb();
  await cleanup();
  try {
    for (const u of USERS) await ensureUserSettings(u);

    console.log("\nsaving deduplicates by every identifier");
    const first = await saveLead(V, {
      source: "manual",
      displayName: "Jane Doe",
      email: "Jane@Target.test",
      companyName: "Northwind",
    });
    check("a new lead is created, open", first.created && first.lead.status === "open");
    check(
      "its email is stored the way contact_identities stores it",
      first.lead.emailNormalized === identityKeysFor({ email: "Jane@Target.test" })[0]?.value
    );
    const again = await saveLead(V, { source: "manual", displayName: "J. Doe", email: "jane@target.test", title: "VP Sales" });
    check("the same email is the same lead", !again.created && again.lead.id === first.lead.id);
    check("a second save only fills blanks", again.lead.displayName === "Jane Doe" && again.lead.title === "VP Sales");
    const ada = await saveLead(V, { source: "manual", displayName: "Ada", linkedinUrl: "https://www.linkedin.com/in/ada-l" });
    const adaAgain = await saveLead(V, { source: "manual", displayName: "Ada L", linkedinUrl: "https://linkedin.com/in/ADA-L/" });
    check("the same LinkedIn profile is the same lead", ada.created && !adaAgain.created && adaAgain.lead.id === ada.lead.id);
    const sam = await saveLead(V, { source: "apollo", apolloId: "ap-1", displayName: "Sam Patel", companyName: "Brightpath" });
    const samAgain = await saveLead(V, { source: "apollo", apolloId: "ap-1", displayName: "Sam Patel" });
    check("the same Apollo person is the same lead", sam.created && !samAgain.created && samAgain.lead.id === sam.lead.id);
    let nameless: unknown = null;
    try {
      await saveLead(V, { source: "manual", displayName: "   " });
    } catch (err) {
      nameless = err;
    }
    check("a lead needs a name, said in words", isUserFacingError(nameless));
    const theirs = await saveLead(OTHER, { source: "manual", displayName: "Jane Doe", email: "jane@target.test" });
    check("another user's identical lead is their own row", theirs.created && theirs.lead.id !== first.lead.id);

    console.log("\nstatuses are the owner's alone");
    check("another user cannot dismiss my lead", (await setLeadStatus(OTHER, first.lead.id, "dismissed")) === false);
    check("I can", (await setLeadStatus(V, first.lead.id, "dismissed")) === true);
    const open = await listLeads(V, { statuses: ["open", "intro_requested"] });
    check("a dismissed lead leaves the open list", !open.some((l) => l.id === first.lead.id));
    const reopened = await saveLead(V, { source: "manual", displayName: "Jane Doe", email: "jane@target.test" });
    check("saving it again reopens it", reopened.lead.id === first.lead.id && reopened.lead.status === "open");

    console.log("\nthe pipeline ranks by who knows each lead");
    const before = await loadPipeline(V);
    check(
      "with no team, every lead is listed without a path",
      before.team === "no_team" && before.rows.length === 3 && before.rows.every((r) => r.path === null),
      `${before.team} ${before.rows.length}`
    );
    await joinTeamWithDomain(V, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(MATE, DOMAIN, { shareNetwork: true });
    const [known] = await db
      .insert(contacts)
      .values({ userId: MATE, fullName: "Jane Doe", email: "jane@target.test", closenessTier: "inner", closeness: 80 })
      .returning();
    await claimIdentities(MATE, known.id, identityKeysFor({ email: "jane@target.test" }), "smoke");
    const ranked = await loadPipeline(V);
    const order = ranked.rows.map((r) => `${r.lead.displayName}:${r.path?.warmth}`).join(", ");
    check("with a sharing teammate, the pipeline is ranked", ranked.team === "ok");
    check("Jane comes first, hot", ranked.rows[0]?.lead.id === first.lead.id && ranked.rows[0]?.path?.warmth === "hot", order);
    check("everyone else is still listed, cold", ranked.rows.length === 3 && ranked.rows.slice(1).every((r) => r.path?.warmth === "cold"), order);
    check("a status filter narrows the list", (await loadPipeline(V, { statuses: ["converted"] })).rows.length === 0);

    console.log("\nadd to contacts matches before it creates");
    const [mine] = await db
      .insert(contacts)
      .values({ userId: V, fullName: "Sam Patel", email: "sam@brightpath.test" })
      .returning();
    await claimIdentities(V, mine.id, identityKeysFor({ email: "sam@brightpath.test" }), "smoke");
    const samLead = await saveLead(V, { source: "manual", displayName: "Sam P", email: "sam@brightpath.test" });
    const matched = await convertLeadToContact(V, samLead.lead.id, WRITE);
    check("a lead already in the network is matched, not duplicated", matched.contactId === mine.id, JSON.stringify(matched));
    const converted = await convertLeadToContact(V, first.lead.id, WRITE);
    const [created] = await db.select().from(contacts).where(eq(contacts.id, converted.contactId));
    check("a new person becomes a contact", converted.outcome === "created" && created?.userId === V && created.fullName === "Jane Doe");
    const after = await getLead(V, first.lead.id);
    check("the lead stays, linked and marked", after?.contactId === converted.contactId && after.status === "converted");
    const twice = await convertLeadToContact(V, first.lead.id, WRITE);
    check("converting twice returns the same contact", twice.contactId === converted.contactId && twice.outcome === "linked");
    let foreign: unknown = null;
    try {
      await convertLeadToContact(OTHER, first.lead.id, WRITE);
    } catch (err) {
      foreign = err;
    }
    check("another user cannot convert my lead", isUserFacingError(foreign));
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll leads store checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

Register it in `scripts/run-smoke.ts` `MANIFEST`: `"smoke-leads": "pglite",` next to `"smoke-warm-paths"`.

- [ ] **Step 2: Watch it fail**

Run: `npx tsx scripts/smoke-leads.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/leads/pipeline'`.

- [ ] **Step 3: Write the store**

Create `src/lib/leads/store.ts`:

```ts
/**
 * The leads pipeline's storage: save a target (deduplicated), list, change status, and turn
 * a lead into a contact. Every statement carries the owner's `user_id` in its WHERE.
 */
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { leads, type Lead, type LeadSource, type LeadStatus } from "@/db/schema";
import { resolveOrCreateContact, type ResolveOptions } from "@/lib/contact-resolve";
import { UserFacingError } from "@/lib/errors";
import { normalizeLeadInput, type LeadInput, type NormalizedLead } from "./lead-identity";

/** A pipeline is a working list, not an archive: past this many, the oldest drop off the page. */
export const PIPELINE_LIMIT = 500;

export type SaveLeadInput = LeadInput & {
  source: Exclude<LeadSource, "crm">;
  apolloId?: string | null;
};

/** The columns a second save may fill when the first left them blank. */
const FILLABLE = [
  "email",
  "emailNormalized",
  "linkedinUrl",
  "linkedinSlug",
  "phone",
  "phoneE164",
  "companyName",
  "companyNormalized",
  "title",
] as const satisfies readonly (keyof NormalizedLead & keyof Lead)[];

async function findByApolloId(userId: string, apolloId: string): Promise<Lead | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.userId, userId), eq(leads.apolloId, apolloId)))
    .limit(1);
  return row ?? null;
}

async function findByIdentity(userId: string, lead: NormalizedLead): Promise<Lead | null> {
  const matches: SQL[] = [];
  if (lead.emailNormalized) matches.push(eq(leads.emailNormalized, lead.emailNormalized));
  if (lead.linkedinSlug) matches.push(eq(leads.linkedinSlug, lead.linkedinSlug));
  if (!matches.length) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.userId, userId), or(...matches)))
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Save a target. The same person saved twice — by email, LinkedIn or Apollo id — is one lead:
 * the existing row keeps its values and only fills its blanks, and a dismissed lead saved
 * again is reopened.
 */
export async function saveLead(
  userId: string,
  input: SaveLeadInput
): Promise<{ lead: Lead; created: boolean }> {
  const normalized = normalizeLeadInput(input);
  if (!normalized.displayName) throw new UserFacingError("Add a name for this lead");
  const apolloId = input.apolloId?.trim() || null;
  const db = await getDb();

  const existing =
    (apolloId ? await findByApolloId(userId, apolloId) : null) ??
    (await findByIdentity(userId, normalized));
  if (existing) {
    const fill: Partial<NormalizedLead> = {};
    for (const key of FILLABLE) {
      if (existing[key] == null && normalized[key] != null) fill[key] = normalized[key];
    }
    const [updated] = await db
      .update(leads)
      .set({
        ...fill,
        ...(existing.apolloId == null && apolloId ? { apolloId } : {}),
        status: existing.status === "dismissed" ? "open" : existing.status,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, existing.id), eq(leads.userId, userId)))
      .returning();
    return { lead: updated ?? existing, created: false };
  }

  try {
    const [created] = await db
      .insert(leads)
      .values({ userId, source: input.source, apolloId, ...normalized })
      .returning();
    return { lead: created, created: true };
  } catch (err) {
    // Two saves of the same Apollo person racing on `leads_user_apollo_uidx`: the winner's row is
    // the answer, the resolveCompany pattern.
    if (apolloId) {
      const raced = await findByApolloId(userId, apolloId);
      if (raced) return { lead: raced, created: false };
    }
    throw err;
  }
}

export async function listLeads(
  userId: string,
  opts: { statuses?: readonly LeadStatus[] } = {}
): Promise<Lead[]> {
  const db = await getDb();
  const where = opts.statuses?.length
    ? and(eq(leads.userId, userId), inArray(leads.status, [...opts.statuses]))
    : eq(leads.userId, userId);
  return db.select().from(leads).where(where).orderBy(desc(leads.updatedAt)).limit(PIPELINE_LIMIT);
}

export async function getLead(userId: string, leadId: string): Promise<Lead | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** False when the lead is not this user's. */
export async function setLeadStatus(userId: string, leadId: string, status: LeadStatus): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(leads)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .returning();
  return rows.length > 0;
}

/**
 * "Add to contacts", through the resolver every other path uses: a lead who is already in the
 * network is matched rather than duplicated. The plan's contact cap applies and its
 * PaywallError propagates for the caller to turn into copy. Idempotent: a lead already linked
 * returns its contact.
 */
export async function convertLeadToContact(
  userId: string,
  leadId: string,
  options: ResolveOptions = {}
): Promise<{ contactId: string; outcome: "created" | "matched" | "merged" | "linked" }> {
  const lead = await getLead(userId, leadId);
  if (!lead) throw new UserFacingError("That lead isn’t yours to change");
  if (lead.contactId) return { contactId: lead.contactId, outcome: "linked" };

  const { contactId, outcome } = await resolveOrCreateContact(
    userId,
    {
      fullName: lead.displayName,
      email: lead.email ?? undefined,
      phone: lead.phone ?? undefined,
      linkedinUrl: lead.linkedinUrl ?? undefined,
      company: lead.companyName ?? undefined,
      title: lead.title ?? undefined,
      source: "leads",
    },
    options
  );
  const db = await getDb();
  await db
    .update(leads)
    .set({ contactId, status: "converted", updatedAt: new Date() })
    .where(and(eq(leads.id, lead.id), eq(leads.userId, userId)));
  return { contactId, outcome };
}
```

- [ ] **Step 4: Write the pipeline**

Create `src/lib/leads/pipeline.ts`:

```ts
/**
 * The Leads page's list: the user's leads, each with who on their team knows them, hottest
 * first. One read of the leads and at most two warm-path statements however long the list —
 * P2's `warmPathsForTargets` does the matching, so the privacy SQL has exactly one copy.
 */
import type { Lead, LeadStatus } from "@/db/schema";
import { leadTargetIdentity } from "./lead-identity";
import { listLeads } from "./store";
import { WARMTH_RANK, type WarmPath } from "./warm-path";
import { warmPathsForTargets } from "./warm-path-query";

export type PipelineRow = { lead: Lead; path: WarmPath | null };

/** `team` says why every `path` is null when it is not "ok". */
export type Pipeline = { team: "ok" | "no_team" | "not_sharing"; rows: PipelineRow[] };

const rankOf = (row: PipelineRow) => WARMTH_RANK[row.path?.warmth ?? "cold"];

export async function loadPipeline(
  userId: string,
  opts: { statuses?: readonly LeadStatus[] } = {}
): Promise<Pipeline> {
  const list = await listLeads(userId, opts);
  const result = await warmPathsForTargets(
    userId,
    list.map((lead) => ({ key: lead.id, ...leadTargetIdentity(lead) }))
  );
  if (result.status !== "ok") {
    return { team: result.status, rows: list.map((lead) => ({ lead, path: null })) };
  }
  const rows = list.map((lead) => ({ lead, path: result.paths.get(lead.id) ?? null }));
  rows.sort(
    (a, b) => rankOf(a) - rankOf(b) || b.lead.updatedAt.getTime() - a.lead.updatedAt.getTime()
  );
  return { team: "ok", rows };
}
```

- [ ] **Step 5: Run the smoke, the manifest check, typecheck, lint**

Run:
```bash
npx tsx scripts/smoke-leads.ts && npx tsx scripts/run-smoke.ts --only smoke-leads && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src/lib/leads scripts/smoke-leads.ts
```
Expected: every check `ok`; tsc and eslint silent. If `ContactInput` rejects a field because its type differs, match `src/lib/contact-writes.ts:68-139` rather than weakening the check. If `resolveOrCreateContact` reports `"merged"` for the Sam lead, the check still holds — it asserts the contact id only.

- [ ] **Step 6: Commit**

```bash
git add src/lib/leads/store.ts src/lib/leads/pipeline.ts scripts/smoke-leads.ts scripts/run-smoke.ts
git commit -m "Store leads without duplicates, and rank the pipeline by who knows each one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Leads Server Actions and the Apollo shape

**Files:**
- Create: `src/lib/leads/apollo-leads.ts`, `src/actions/leads.ts`
- Modify: `src/actions/teams.ts` (drop its local `isUuid`, import the shared one)
- Modify: `scripts/smoke-warm-path.ts` (an "Apollo shape" section; the structural "actions" section checks both action files; `apollo-leads.ts` joins the client-bundle list)

**Interfaces:**
- Consumes: Tasks 2 and 3; `searchPeople`, `userHasApolloKey` (`@/lib/apollo`); `AudienceFilters`, `NormalizedProspect`, `OutreachSearchSource` (`@/lib/outreach-types`, types only); `isPaywallError` (`@/lib/entitlements`); `warmPathsForTargets`; `requireLeadsUser`.
- Produces (`apollo-leads.ts`): `type ApolloSearchInput = { titles: string; companies: string; locations: string; keywords: string }`; `type ApolloProspectView = { externalId; fullName; title; company; email; phone; linkedinUrl; location; demo: boolean }`; `type ApolloLeadRow = { prospect: ApolloProspectView; path: WarmPath | null }`; `type ApolloLeadSearch = { rows: ApolloLeadRow[]; total: number; source: OutreachSearchSource; team: "ok" | "no_team" | "not_sharing"; page: number }`; `APOLLO_MAX_PAGE = 20`; `apolloFiltersFromInput(raw: unknown): AudienceFilters`; `isEmptySearch(f): boolean`; `prospectLeadInput(p): LeadInput`; `prospectView(p: NormalizedProspect, source): ApolloProspectView`; `coerceProspect(raw: unknown): ApolloProspectView | null`.
- Produces (`src/actions/leads.ts`): `loadPipelineAction(): Promise<Pipeline>`; `saveLeadAction(input: LeadInput): Promise<ActionResult<{ id: string; created: boolean }>>`; `setLeadStatusAction(leadId: string, status: LeadStatus): Promise<ActionResult<{ status: LeadStatus }>>`; `convertLeadAction(leadId: string): Promise<ActionResult<{ contactId: string }>>`; `getApolloStatusAction(): Promise<{ hasApollo: boolean }>`; `searchApolloLeadsAction(input: ApolloSearchInput, page: number): Promise<ActionResult<ApolloLeadSearch>>`; `saveApolloLeadAction(prospect: ApolloProspectView): Promise<ActionResult<{ id: string; created: boolean }>>`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-warm-path.ts` add the import:

```ts
import {
  apolloFiltersFromInput,
  coerceProspect,
  isEmptySearch,
  prospectLeadInput,
  prospectView,
} from "../src/lib/leads/apollo-leads";
```

Add this section before the `client-bundle safety` section:

```ts
  console.log("\nthe Apollo shape");
  {
    const filters = apolloFiltersFromInput({
      titles: " VP Sales, Head of Partnerships ,VP Sales,",
      companies: "Northwind",
      locations: "",
      keywords: "  fintech ",
    });
    check("comma lists are trimmed and deduplicated", filters.titles?.join("|") === "VP Sales|Head of Partnerships");
    check("companies map to organisation names", filters.organizationNames?.join("|") === "Northwind");
    check("an empty field is absent", filters.locations === undefined);
    check("keywords are trimmed", filters.keywords === "fintech");
    check("a blank form is an empty search", isEmptySearch(apolloFiltersFromInput({ titles: " , ", companies: "", locations: "", keywords: " " })));
    check("forged input is an empty search", isEmptySearch(apolloFiltersFromInput({ titles: 7 })) && isEmptySearch(apolloFiltersFromInput(null)));
    const view = prospectView(
      {
        externalId: "demo-1",
        fullName: "Ivy Chen",
        title: "VP Engineering",
        company: "Brightpath",
        email: "ivy@brightpath.example",
        phone: null,
        linkedinUrl: null,
        location: "Austin",
        enrichment: { demo: true },
      },
      "apollo"
    );
    check("a demo prospect is marked demo", view.demo === true);
    check("a prospect becomes a lead input", prospectLeadInput(view).companyName === "Brightpath" && prospectLeadInput(view).displayName === "Ivy Chen");
    check("a posted prospect keeps its fields", coerceProspect({ ...view, fullName: "  Ivy Chen " })?.fullName === "Ivy Chen");
    check("a posted prospect without an id is refused", coerceProspect({ ...view, externalId: "" }) === null);
    check("a posted prospect without a name is refused", coerceProspect({ externalId: "x", fullName: 5 }) === null);
  }
```

Replace the body of the existing `the actions in front of it` section with a loop over both files:

```ts
  console.log("\nthe actions in front of it");
  for (const file of ["src/actions/teams.ts", "src/actions/leads.ts"]) {
    const name = file.split("/").pop();
    const source = code(file);
    check(`${name} is a server module`, /^\s*"use server";/m.test(readFileSync(file, "utf8")));
    const exports = [...source.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)];
    check(`${name}: every export is an async function`, exports.length >= 7 && exports.every((m) => !!m[1]), String(exports.length));
    check(`${name}: no type or const exports`, !/^export\s+(type|const|let|interface)\b/m.test(source));
    const bodies = source.split(/^export\s+async\s+function\s+/m).slice(1);
    check(
      `${name}: every action gates on requireLeadsUser first`,
      bodies.every((b) => /^[^{]*\{\s*const userId = await requireLeadsUser\(\);/.test(b))
    );
  }
```

Add `"src/lib/leads/apollo-leads.ts"` to the client-bundle file list.

- [ ] **Step 2: Watch it fail**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/leads/apollo-leads'`.

- [ ] **Step 3: Write the Apollo shape**

Create `src/lib/leads/apollo-leads.ts`:

```ts
/**
 * Apollo search, shaped for the Leads page: the form's comma-separated fields become Apollo
 * filters, and a prospect becomes a lead input and a view the client may hold. Pure.
 */
import type { AudienceFilters, NormalizedProspect, OutreachSearchSource } from "@/lib/outreach-types";
import type { LeadInput } from "./lead-identity";
import type { WarmPath } from "./warm-path";

export type ApolloSearchInput = { titles: string; companies: string; locations: string; keywords: string };

export type ApolloProspectView = {
  externalId: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  /** Invented by `searchPeople` because there is no Apollo key. */
  demo: boolean;
};

export type ApolloLeadRow = { prospect: ApolloProspectView; path: WarmPath | null };

export type ApolloLeadSearch = {
  rows: ApolloLeadRow[];
  total: number;
  source: OutreachSearchSource;
  team: "ok" | "no_team" | "not_sharing";
  page: number;
};

/** Apollo pages are ten people; twenty pages is far past what anyone scrolls. */
export const APOLLO_MAX_PAGE = 20;

function listField(value: unknown, max = 10): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim().slice(0, 100))
        .filter(Boolean)
    ),
  ].slice(0, max);
  return items.length ? items : undefined;
}

export function apolloFiltersFromInput(raw: unknown): AudienceFilters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keywords = typeof r.keywords === "string" ? r.keywords.trim().slice(0, 200) : "";
  return {
    titles: listField(r.titles),
    organizationNames: listField(r.companies),
    locations: listField(r.locations),
    keywords: keywords || undefined,
  };
}

export function isEmptySearch(filters: AudienceFilters): boolean {
  return (
    !filters.titles?.length &&
    !filters.organizationNames?.length &&
    !filters.locations?.length &&
    !filters.keywords
  );
}

export function prospectLeadInput(
  p: Pick<ApolloProspectView, "fullName" | "title" | "company" | "email" | "phone" | "linkedinUrl">
): LeadInput {
  return {
    displayName: p.fullName,
    title: p.title,
    companyName: p.company,
    email: p.email,
    phone: p.phone,
    linkedinUrl: p.linkedinUrl,
  };
}

export function prospectView(p: NormalizedProspect, source: OutreachSearchSource): ApolloProspectView {
  return {
    externalId: p.externalId,
    fullName: p.fullName,
    title: p.title,
    company: p.company,
    email: p.email,
    phone: p.phone,
    linkedinUrl: p.linkedinUrl,
    location: p.location,
    demo: source === "demo" || p.enrichment?.demo === true,
  };
}

/** A prospect posted back from the client, checked field by field before it is saved. */
export function coerceProspect(raw: unknown): ApolloProspectView | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
  const externalId = text(r.externalId);
  const fullName = text(r.fullName);
  if (!externalId || !fullName) return null;
  return {
    externalId,
    fullName,
    title: text(r.title),
    company: text(r.company),
    email: text(r.email),
    phone: text(r.phone),
    linkedinUrl: text(r.linkedinUrl),
    location: text(r.location),
    demo: r.demo === true,
  };
}
```

- [ ] **Step 4: Write the actions and share `isUuid`**

Create `src/actions/leads.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import type { LeadStatus } from "@/db/schema";
import { searchPeople, userHasApolloKey } from "@/lib/apollo";
import { isPaywallError } from "@/lib/entitlements";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import {
  APOLLO_MAX_PAGE,
  apolloFiltersFromInput,
  coerceProspect,
  isEmptySearch,
  prospectLeadInput,
  prospectView,
  type ApolloLeadSearch,
  type ApolloProspectView,
  type ApolloSearchInput,
} from "@/lib/leads/apollo-leads";
import {
  coerceLeadInput,
  leadTargetIdentity,
  normalizeLeadInput,
  type LeadInput,
} from "@/lib/leads/lead-identity";
import { loadPipeline, type Pipeline } from "@/lib/leads/pipeline";
import { convertLeadToContact, saveLead, setLeadStatus } from "@/lib/leads/store";
import { isLeadStatus, isUuid } from "@/lib/leads/validate";
import { warmPathsForTargets } from "@/lib/leads/warm-path-query";
import { requireLeadsUser } from "@/lib/plan-guards";

/*
 * Every action starts with `requireLeadsUser()`: Server Functions answer a direct POST, so
 * this — not the nav — is the boundary, and while Leads is coming soon it refuses everyone.
 * Writes return `ActionResult` so a `UserFacingError` reaches the person instead of a digest.
 */

type SavedLead = { id: string; created: boolean };
type LeadStatusResult = { status: LeadStatus };
type ConvertedLead = { contactId: string };
type ApolloStatus = { hasApollo: boolean };

const NOT_YOURS = "That lead isn’t yours to change";

export async function loadPipelineAction(): Promise<Pipeline> {
  const userId = await requireLeadsUser();
  return loadPipeline(userId);
}

export async function saveLeadAction(input: LeadInput): Promise<ActionResult<SavedLead>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const { lead, created } = await saveLead(userId, { ...coerceLeadInput(input), source: "manual" });
    revalidatePath("/leads");
    return { id: lead.id, created };
  });
}

export async function setLeadStatusAction(
  leadId: string,
  status: LeadStatus
): Promise<ActionResult<LeadStatusResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    if (!isUuid(leadId) || !isLeadStatus(status)) throw new UserFacingError(NOT_YOURS);
    if (!(await setLeadStatus(userId, leadId, status))) throw new UserFacingError(NOT_YOURS);
    revalidatePath("/leads");
    return { status };
  });
}

export async function convertLeadAction(leadId: string): Promise<ActionResult<ConvertedLead>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    if (!isUuid(leadId)) throw new UserFacingError(NOT_YOURS);
    try {
      const { contactId } = await convertLeadToContact(userId, leadId);
      revalidatePath("/leads");
      revalidatePath("/contacts");
      return { contactId };
    } catch (err) {
      // The plan's contact cap: its message is written to be read, so it comes back as data.
      if (isPaywallError(err)) throw new UserFacingError(err.message);
      throw err;
    }
  });
}

export async function getApolloStatusAction(): Promise<ApolloStatus> {
  const userId = await requireLeadsUser();
  return { hasApollo: await userHasApolloKey(userId) };
}

export async function searchApolloLeadsAction(
  input: ApolloSearchInput,
  page: number
): Promise<ActionResult<ApolloLeadSearch>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const filters = apolloFiltersFromInput(input);
    if (isEmptySearch(filters)) {
      throw new UserFacingError("Add a title, company, place or keyword to search");
    }
    const safePage = Number.isInteger(page) && page >= 1 && page <= APOLLO_MAX_PAGE ? page : 1;
    const { prospects, total, source } = await searchPeople(userId, filters, safePage);
    const warm = await warmPathsForTargets(
      userId,
      prospects.map((p) => ({
        key: p.externalId,
        ...leadTargetIdentity(normalizeLeadInput(prospectLeadInput(p))),
      }))
    );
    return {
      rows: prospects.map((p) => ({
        prospect: prospectView(p, source),
        path: warm.status === "ok" ? (warm.paths.get(p.externalId) ?? null) : null,
      })),
      total,
      source,
      team: warm.status,
      page: safePage,
    };
  });
}

export async function saveApolloLeadAction(
  prospect: ApolloProspectView
): Promise<ActionResult<SavedLead>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const checked = coerceProspect(prospect);
    if (!checked) throw new UserFacingError("That result can’t be saved — search again");
    const { lead, created } = await saveLead(userId, {
      ...prospectLeadInput(checked),
      source: "apollo",
      apolloId: checked.externalId,
    });
    revalidatePath("/leads");
    return { id: lead.id, created };
  });
}
```

In `src/actions/teams.ts`, delete the local `UUID` constant, the local `isUuid` function and the comment above them, and add `import { isUuid } from "@/lib/leads/validate";` to the imports.

- [ ] **Step 5: Run the smoke, typecheck, lint, the P2 smokes**

Run:
```bash
npx tsx scripts/smoke-warm-path.ts && npx tsc --noEmit && npx eslint src/actions/leads.ts src/actions/teams.ts src/lib/leads && npx tsx scripts/run-smoke.ts --only smoke-team-lifecycle smoke-warm-paths smoke-leads smoke-toast-copy
```
Expected: all `ok`; tsc and eslint silent; `smoke-toast-copy` passes the new `UserFacingError` strings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/leads/apollo-leads.ts src/actions/leads.ts src/actions/teams.ts scripts/smoke-warm-path.ts
git commit -m "Add the Leads Server Actions: save, status, add to contacts, and Apollo search with warm paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The shared view pieces — warmth chip, path summary, the sharing list

**Files:**
- Create: `src/components/leads/warmth-chip.tsx`, `src/components/leads/path-summary.tsx`, `src/components/leads/sharing-dl.tsx`, `src/components/leads/labels.ts`
- Modify: `scripts/smoke-leads-page.ts` (a render section; a client-safety section over the whole directory; a `CLIENT_COMPONENTS` list later tasks extend)

**Interfaces:**
- Consumes: `Warmth`, `WarmPath` (`@/lib/leads/warm-path`); `IdentityKind` (`@/lib/duplicates`, type); `ClosenessTierBadge` (`@/components/dashboard/closeness-tier-badge`); `LeadStatus`, `LeadSource` (`@/db/schema`, types).
- Produces: `WarmthChip({ warmth, className? })`, `WARMTH_LABEL: Record<Warmth, string>`; `PathSummary({ path, companyName, compact? })`; `SharingDl()`; `LEAD_STATUS_LABEL: Record<LeadStatus, string>`, `LEAD_SOURCE_LABEL: Record<LeadSource, string>`. None of the three components uses a hook or `"use client"`, so both server and client components render them and the pure smoke can too.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-leads-page.ts` add to the imports:

```ts
import { existsSync, readdirSync } from "node:fs";
import type { WarmPath } from "../src/lib/leads/warm-path";
import { WarmthChip } from "../src/components/leads/warmth-chip";
import { PathSummary } from "../src/components/leads/path-summary";
import { SharingDl } from "../src/components/leads/sharing-dl";
```

(`readFileSync` is already imported from `node:fs`; merge into one import line.) Above `function main()` add:

```ts
/**
 * Client components under src/components/leads. Each task that adds one appends its file here,
 * so a missing file or a lost "use client" is a failed check, not a silent build surprise.
 */
const CLIENT_COMPONENTS: string[] = [];
```

Add these sections before the `structure` section:

```ts
  console.log("\nwhat the page shows about a path");
  {
    const path: WarmPath = {
      warmth: "hot",
      direct: [{ teammate: { userId: "u1", name: "Alex Ng", email: "alex@acme.test" }, tier: "inner", matchedOn: "email" }],
      account: [{ teammate: { userId: "u2", name: "Priya Nair", email: "priya@acme.test" }, count: 2, bestTier: "mid" }],
    };
    const full = text(React.createElement(PathSummary, { path, companyName: "Northwind" }));
    check("names the teammate and the orbit", full.includes("Alex Ng") && full.includes("Inner orbit"), full);
    check("says how they matched", full.includes("via email"), full);
    check("says how many others they know at the company", full.includes("knows 2 others at Northwind"), full);
    check("never shows a teammate's email", !full.includes("@acme.test"), full);
    const compact = text(React.createElement(PathSummary, { path, companyName: "Northwind", compact: true }));
    check("the compact line fits a row", compact.includes("Alex (inner)") && compact.includes("Northwind via Priya"), compact);
    check("and hides emails too", !compact.includes("@acme.test"), compact);
    const nobody = text(React.createElement(PathSummary, { path: { warmth: "cold", direct: [], account: [] }, companyName: null }));
    check("an empty path says so", /nobody on your team/i.test(nobody), nobody);
    for (const warmth of ["hot", "warm", "cool", "cold"] as const) {
      check(`a ${warmth} chip has a label`, text(React.createElement(WarmthChip, { warmth })).length > 3);
    }
    const dl = text(React.createElement(SharingDl));
    check("the sharing list names both sides", dl.includes("Shared while you share") && dl.includes("Never shared"), dl);
  }

  console.log("\nthe leads components stay client-safe");
  {
    const dir = "src/components/leads";
    const serverOnly =
      /import\s+(?!type\b)[^;]*from\s+["'](@\/db(\/[^"']*)?|@\/lib\/teams|@\/lib\/leads\/(store|pipeline|warm-path-query)|@\/lib\/apollo)["']/;
    for (const file of readdirSync(dir).filter((f) => /\.(tsx?)$/.test(f))) {
      check(`${file} never value-imports a server module`, !serverOnly.test(code(`${dir}/${file}`)));
    }
    for (const file of CLIENT_COMPONENTS) {
      const path = `${dir}/${file}`;
      check(`${file} exists and is a client component`, existsSync(path) && /^\s*"use client";/.test(readFileSync(path, "utf8")));
    }
  }
```

- [ ] **Step 2: Watch it fail**

Run: `npx tsx scripts/smoke-leads-page.ts`
Expected: FAIL at import — `Cannot find module '../src/components/leads/warmth-chip'`.

- [ ] **Step 3: Write the four files**

Create `src/components/leads/labels.ts`:

```ts
import type { LeadSource, LeadStatus } from "@/db/schema";

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  open: "Open",
  intro_requested: "Intro asked",
  converted: "In contacts",
  dismissed: "Dismissed",
};

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  manual: "Added by you",
  apollo: "From Apollo",
  crm: "From your CRM",
};
```

Create `src/components/leads/warmth-chip.tsx`:

```tsx
import type { Warmth } from "@/lib/leads/warm-path";
import { cn } from "@/lib/utils";

export const WARMTH_LABEL: Record<Warmth, string> = {
  hot: "Hot path",
  warm: "Warm path",
  cool: "Cool path",
  cold: "No path yet",
};

const WARMTH_HINT: Record<Warmth, string> = {
  hot: "A teammate knows them well — inner orbit",
  warm: "A teammate knows them, or two know them loosely",
  cool: "One loose connection, or someone at their company",
  cold: "Nobody on your team knows them yet",
};

/** The closeness-tier palette, one step warmer: emerald, sky, amber, then muted for none. */
const WARMTH_STYLE: Record<Warmth, string> = {
  hot: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warm: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  cool: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  cold: "bg-muted text-muted-foreground",
};

export function WarmthChip({ warmth, className }: { warmth: Warmth; className?: string }) {
  return (
    <span
      title={WARMTH_HINT[warmth]}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        WARMTH_STYLE[warmth],
        className
      )}
    >
      {WARMTH_LABEL[warmth]}
    </span>
  );
}
```

Create `src/components/leads/path-summary.tsx`:

```tsx
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import type { IdentityKind } from "@/lib/duplicates";
import type { WarmPath } from "@/lib/leads/warm-path";

const MATCHED_ON: Record<IdentityKind, string> = {
  email: "email",
  linkedin_slug: "LinkedIn",
  phone_e164: "phone",
  x_handle: "X",
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * Who on the team knows a lead — the whole of what a lookup reveals: a teammate's name, how
 * close they are, how they matched, and how many others they know at the company. Never an
 * email: a teammate's address is used only inside the intro link. Hook-free, so server pages,
 * client lists and the smoke all render it.
 */
export function PathSummary({
  path,
  companyName,
  compact = false,
}: {
  path: WarmPath;
  companyName: string | null;
  compact?: boolean;
}) {
  const company = companyName ?? "their company";

  if (compact) {
    const direct = path.direct.map((d) => `${firstName(d.teammate.name)} (${d.tier})`).join(", ");
    const viaCompany = path.account.length
      ? `people at ${company} via ${path.account.map((a) => firstName(a.teammate.name)).join(", ")}`
      : "";
    const line = [direct, viaCompany].filter(Boolean).join(" · ");
    return <p className="truncate text-xs text-muted-foreground">{line || "Nobody on your team yet"}</p>;
  }

  if (!path.direct.length && !path.account.length) {
    return <p className="text-sm text-muted-foreground">Nobody on your team knows them yet.</p>;
  }

  return (
    <div className="space-y-3">
      {path.direct.length > 0 && (
        <ul className="space-y-1.5" aria-label="Teammates who know them">
          {path.direct.map((d) => (
            <li key={d.teammate.userId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-ink">{d.teammate.name}</span>
              <ClosenessTierBadge tier={d.tier} />
              <span className="text-xs text-muted-foreground">via {MATCHED_ON[d.matchedOn]}</span>
            </li>
          ))}
        </ul>
      )}
      {path.account.length > 0 && (
        <ul className="space-y-1.5" aria-label={`Teammates who know people at ${company}`}>
          {path.account.map((a) => (
            <li key={a.teammate.userId} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                <span className="font-medium text-ink">{a.teammate.name}</span> knows {a.count}{" "}
                {a.count === 1 ? "other" : "others"} at {company}
              </span>
              <ClosenessTierBadge tier={a.bestTier} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Create `src/components/leads/sharing-dl.tsx`:

```tsx
/**
 * What joining a team shares, and what it never does. Load-bearing, like the recruiter
 * sharing list it copies: this is the only place a person is told what a teammate can learn.
 * Keep it in step with the SELECT lists in `src/lib/leads/warm-path-sql.ts`.
 */
export function SharingDl() {
  return (
    <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-2">
      <div>
        <dt className="font-medium text-foreground">Shared while you share</dt>
        <dd className="mt-1 text-muted-foreground">
          Whether you know someone a teammate looks up, and how close you are — inner, mid or outer
          orbit — plus how many other people you know at their company. Your name and work email,
          so they can ask you for the intro.
        </dd>
      </div>
      <div>
        <dt className="font-medium text-foreground">Never shared</dt>
        <dd className="mt-1 text-muted-foreground">
          Your notes, interactions, AI summaries, tags, and anyone’s contact details. Teammates
          can’t browse your network — they only learn about someone they already named. People
          you mark “Hidden from team” never appear, and nothing is shared while sharing is off.
        </dd>
      </div>
    </dl>
  );
}
```

- [ ] **Step 4: Run the smoke, typecheck, lint**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint src/components/leads scripts/smoke-leads-page.ts`
Expected: all `ok`. If "Inner orbit" is missing from the rendered summary, read `ClosenessTierBadge`'s non-dot branch: the label must come from its `TIER_LABELS`; do not re-implement the badge.

- [ ] **Step 5: Commit**

```bash
git add src/components/leads/labels.ts src/components/leads/warmth-chip.tsx src/components/leads/path-summary.tsx src/components/leads/sharing-dl.tsx scripts/smoke-leads-page.ts
git commit -m "Add the warmth chip, the path summary and the sharing list, rendered and checked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: The team panel — join, share, members, leave

**Files:**
- Create: `src/components/leads/team-panel.tsx` (server component), `src/components/leads/join-team-card.tsx` (client), `src/components/leads/team-card.tsx` (client)
- Modify: `scripts/smoke-leads-page.ts` (`CLIENT_COMPONENTS`)

**Interfaces:**
- Consumes: `joinTeamAction`, `leaveTeamAction`, `setTeamSharingAction` (`@/actions/teams`, all `ActionResult`); types `TeamEligibility`, `TeamMembership`, `TeamMemberRow` (`@/lib/teams`, type imports only); `SharingDl` (Task 5).
- Produces: `TeamPanel({ eligibility, members, viewerUserId })` — used by the page in Task 10.

- [ ] **Step 1: Register the client components and watch the check fail**

In `scripts/smoke-leads-page.ts`, set `const CLIENT_COMPONENTS: string[] = ["join-team-card.tsx", "team-card.tsx"];`.

Run: `npx tsx scripts/smoke-leads-page.ts`
Expected: FAIL — `join-team-card.tsx exists and is a client component`.

- [ ] **Step 2: Write the three components**

Create `src/components/leads/join-team-card.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Handshake } from "lucide-react";
import { joinTeamAction } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { SharingDl } from "./sharing-dl";

/** The offer to join the viewer's domain team, with the sharing choice made up front. */
export function JoinTeamCard({ domain, name, memberCount }: { domain: string; name: string; memberCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<boolean | null>(null);

  function join(shareNetwork: boolean) {
    setChoice(shareNetwork);
    start(async () => {
      try {
        const result = await joinTeamAction({ shareNetwork });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(shareNetwork ? `You’re on the ${name} team, sharing your network` : `You’re on the ${name} team`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t join the team — try again?"));
      }
    });
  }

  const already =
    memberCount > 0
      ? `${memberCount} ${memberCount === 1 ? "colleague is" : "colleagues are"} already on it.`
      : "You’d be the first.";

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex gap-3">
        <div className="mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary">
          <Handshake className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-ink">Join the {name} team</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Everyone with a verified @{domain} address lands on the same team. {already} Share
            your network to see who your teammates know — it works both ways.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => join(true)}>
          {pending && choice === true ? "Joining…" : "Join and share my network"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => join(false)}>
          {pending && choice === false ? "Joining…" : "Join without sharing"}
        </Button>
      </div>
      <SharingDl />
    </section>
  );
}
```

Create `src/components/leads/team-card.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe2, Lock } from "lucide-react";
import { leaveTeamAction, setTeamSharingAction } from "@/actions/teams";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import type { TeamMemberRow, TeamMembership } from "@/lib/teams";
import { toast } from "@/lib/toast";
import { SharingDl } from "./sharing-dl";

/**
 * A member's view of their team: the sharing switch (reciprocal — the copy says so), who is
 * on it, and a two-step leave. Teammates are listed by name and sharing state only.
 */
export function TeamCard({
  membership,
  members,
  viewerUserId,
}: {
  membership: TeamMembership;
  members: TeamMemberRow[];
  viewerUserId: string;
}) {
  const router = useRouter();
  const [sharing, setSharing] = useState(membership.shareNetwork);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [pending, start] = useTransition();

  function toggleSharing() {
    const next = !sharing;
    start(async () => {
      setSharing(next);
      try {
        const result = await setTeamSharingAction(next);
        if (!result.ok) {
          setSharing(!next);
          toast.error(result.error);
          return;
        }
        toast.success(next ? "Your network is shared with the team" : "Your network is private again");
        router.refresh();
      } catch (err) {
        setSharing(!next);
        toast.error(friendlyError(err, "Couldn’t change sharing — try again?"));
      }
    });
  }

  function leave() {
    start(async () => {
      try {
        const result = await leaveTeamAction();
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`You left the ${membership.name} team`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t leave the team — try again?"));
      } finally {
        setConfirmLeave(false);
      }
    });
  }

  const others = members.filter((m) => m.userId !== viewerUserId);
  const sharingOthers = others.filter((m) => m.sharing).length;
  const summary = !sharing
    ? "Your network is private, so you won’t see who your teammates know either. Share it to find warm paths."
    : others.length === 0
      ? `You’re the first one here. Colleagues with a verified @${membership.domain} address can join.`
      : `Your network is shared. ${sharingOthers} of ${others.length} ${others.length === 1 ? "teammate shares" : "teammates share"} theirs with you.`;

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <div
            className={
              sharing
                ? "mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary"
                : "mt-0.5 h-9 w-9 shrink-0 rounded-full bg-muted p-2 text-muted-foreground"
            }
          >
            {sharing ? <Globe2 className="h-5 w-5" aria-hidden /> : <Lock className="h-5 w-5" aria-hidden />}
          </div>
          <div className="min-w-0">
            <h2 className="font-medium text-ink">{membership.name} team</h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{summary}</p>
          </div>
        </div>
        <Button type="button" disabled={pending} variant={sharing ? "outline" : "default"} onClick={toggleSharing}>
          {pending ? "Saving…" : sharing ? "Stop sharing" : "Share my network"}
        </Button>
      </div>

      {members.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/60" aria-label="Team members">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium text-ink">{member.name}</span>
                {member.userId === viewerUserId ? <span className="text-muted-foreground"> (you)</span> : null}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {member.sharing ? "Sharing" : "Private"}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <SharingDl />

      <div className="flex justify-end">
        {confirmLeave ? (
          <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Leave the {membership.name} team?
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={leave}>
              Leave
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmLeave(false)}>
              Stay
            </Button>
          </span>
        ) : (
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmLeave(true)}>
            Leave team
          </Button>
        )}
      </div>
    </section>
  );
}
```

Create `src/components/leads/team-panel.tsx`:

```tsx
import type { TeamEligibility, TeamMemberRow } from "@/lib/teams";
import { JoinTeamCard } from "./join-team-card";
import { TeamCard } from "./team-card";

/** The top of /leads: a member's team, the offer to join one, or why they can't yet. */
export function TeamPanel({
  eligibility,
  members,
  viewerUserId,
}: {
  eligibility: TeamEligibility;
  members: TeamMemberRow[];
  viewerUserId: string;
}) {
  if (eligibility.kind === "member") {
    return <TeamCard membership={eligibility.membership} members={members} viewerUserId={viewerUserId} />;
  }
  if (eligibility.kind === "eligible") {
    return (
      <JoinTeamCard
        domain={eligibility.domain}
        name={eligibility.name}
        memberCount={eligibility.existing?.memberCount ?? 0}
      />
    );
  }
  return (
    <section className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-6">
      <h2 className="font-medium text-ink">Teams need a work email</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {eligibility.reason === "public_domain"
          ? "A team is everyone at one company’s email domain, so a personal address like Gmail can’t form one. Add your work email in your account settings and verify it."
          : "Verify your work email in your account settings, then come back to join your team."}
      </p>
    </section>
  );
}
```

- [ ] **Step 3: Run the smoke, typecheck, lint, the voice check**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint src/components/leads && npx tsx scripts/smoke-toast-copy.ts`
Expected: all pass. Behaviour is verified in the browser in Task 13.

- [ ] **Step 4: Commit**

```bash
git add src/components/leads/team-panel.tsx src/components/leads/join-team-card.tsx src/components/leads/team-card.tsx scripts/smoke-leads-page.ts
git commit -m "Add the team panel: join with a sharing choice, the members, and leaving

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Find a path, and save it as a lead

**Files:**
- Create: `src/components/leads/find-path.tsx` (client)
- Modify: `scripts/smoke-leads-page.ts` (`CLIENT_COMPONENTS` gains `"find-path.tsx"`)

**Interfaces:**
- Consumes: `lookupWarmLead(raw): Promise<{ parsed: ParsedTarget; lookup: WarmPathLookup }>` (`@/actions/teams`); `saveLeadAction` (Task 4); `ParsedTarget` (`@/lib/leads/target-input`, type — kinds `email | linkedin | phone | x | name_company | name | empty`, fields `displayName`, `email`, `companyNormalized`, …); `WarmPathLookup`; `PathSummary`, `WarmthChip` (Task 5).
- Produces: `FindPath()` — no props; used by the page in Task 10.

- [ ] **Step 1: Register it and watch the check fail**

Append `"find-path.tsx"` to `CLIENT_COMPONENTS`. Run `npx tsx scripts/smoke-leads-page.ts`. Expected: FAIL on `find-path.tsx exists`.

- [ ] **Step 2: Write the component**

Create `src/components/leads/find-path.tsx`:

```tsx
"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { saveLeadAction } from "@/actions/leads";
import { lookupWarmLead } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import type { ParsedTarget } from "@/lib/leads/target-input";
import type { WarmPathLookup } from "@/lib/leads/warm-path";
import { toast } from "@/lib/toast";
import { PathSummary } from "./path-summary";
import { WarmthChip } from "./warmth-chip";

type Found = { raw: string; parsed: ParsedTarget; lookup: WarmPathLookup };

/** A name to prefill: the one typed, else the mailbox of an email, else nothing. */
function suggestedName(found: Found): string {
  if (found.parsed.displayName) return found.parsed.displayName;
  if (found.parsed.kind === "email" && found.parsed.email) return found.parsed.email.split("@")[0] ?? "";
  return "";
}

/** "Name, Company" keeps the company as typed; the parser kept only its lower-case key. */
function suggestedCompany(found: Found): string {
  if (found.parsed.kind !== "name_company") return "";
  return found.raw.slice(found.raw.indexOf(",") + 1).trim();
}

const LOOKUP_NOTE: Record<"no_team" | "not_sharing", string> = {
  no_team: "Join your team above to see who knows them.",
  not_sharing: "Share your network above to see who knows them — it works both ways.",
};

/**
 * One box, any identifier: who on the team knows this person, then a one-step save. An X
 * handle is looked up but not stored — a lead has no X column until one is needed.
 */
export function FindPath() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = raw.trim();
    if (!value) return;
    startSearch(async () => {
      try {
        const { parsed, lookup } = await lookupWarmLead(value);
        const next = { raw: value, parsed, lookup };
        setFound(next);
        setName(suggestedName(next));
        setCompany(suggestedCompany(next));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t look that up — try again?"));
      }
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!found) return;
    const { parsed, raw: typed } = found;
    startSave(async () => {
      try {
        const result = await saveLeadAction({
          displayName: name,
          companyName: company || null,
          email: parsed.kind === "email" ? (parsed.email ?? null) : null,
          linkedinUrl: parsed.kind === "linkedin" ? typed : null,
          phone: parsed.kind === "phone" ? typed : null,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(result.value.created ? "Saved to your leads" : "Already in your leads — updated it");
        setFound(null);
        setRaw("");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save that lead — try again?"));
      }
    });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div>
        <h2 className="font-medium text-ink">Find a path</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste an email, a LinkedIn profile, a phone number, or “Name, Company”.
        </p>
      </div>
      <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          placeholder="jane@northwind.com"
          aria-label="Who do you want to reach?"
          maxLength={300}
          className="sm:flex-1"
        />
        <Button type="submit" disabled={searching || !raw.trim()}>
          <Search aria-hidden />
          {searching ? "Looking…" : "Find a path"}
        </Button>
      </form>

      {found && found.parsed.kind !== "empty" && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4" aria-live="polite">
          {found.lookup.status === "ok" ? (
            <div className="space-y-3">
              <WarmthChip warmth={found.lookup.path.warmth} />
              <PathSummary path={found.lookup.path} companyName={company || null} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{LOOKUP_NOTE[found.lookup.status]}</p>
          )}
          {found.parsed.kind === "name" && (
            <p className="text-xs text-muted-foreground">
              A name alone can’t be matched — add their email or LinkedIn profile to find a path.
            </p>
          )}
          <form
            onSubmit={save}
            className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          >
            <div className="space-y-1.5">
              <Label htmlFor="lead-name">Name</Label>
              <Input id="lead-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-company">Company</Label>
              <Input id="lead-company" value={company} onChange={(event) => setCompany(event.target.value)} maxLength={200} />
            </div>
            <Button type="submit" variant="outline" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save as a lead"}
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
```

If `Input`'s `onChange` is typed differently in this repo (it wraps `@base-ui/react/input`), follow the usage in `src/components/outreach/audience-filters-editor.tsx:46-52` exactly.

- [ ] **Step 3: Run the smoke, typecheck, lint, the voice check**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint src/components/leads && npx tsx scripts/smoke-toast-copy.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/leads/find-path.tsx scripts/smoke-leads-page.ts
git commit -m "Add Find a path: one box for any identifier, then save the person as a lead

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The pipeline list and the lead sheet

**Files:**
- Create: `src/components/leads/leads-pipeline.tsx` (client), `src/components/leads/lead-detail-sheet.tsx` (client)
- Modify: `scripts/smoke-leads-page.ts` (`CLIENT_COMPONENTS` gains both)

**Interfaces:**
- Consumes: `Pipeline`, `PipelineRow` (`@/lib/leads/pipeline`, types); `setLeadStatusAction`, `convertLeadAction` (Task 4); `introRequestMailto` (Task 2); `Sheet`, `SheetContent` (`side`, `className`), `SheetHeader`, `SheetTitle`, `SheetDescription` (`@/components/ui/sheet`, Base UI — `open` / `onOpenChange`); `Button`, `buttonVariants`; Task 5's pieces.
- Produces: `LeadsPipeline({ pipeline })`, `LeadDetailSheet({ row, onClose })`.

- [ ] **Step 1: Register them and watch the check fail**

Append `"leads-pipeline.tsx"` and `"lead-detail-sheet.tsx"` to `CLIENT_COMPONENTS`. Run the smoke. Expected: FAIL on `leads-pipeline.tsx exists`.

- [ ] **Step 2: Write the sheet**

Create `src/components/leads/lead-detail-sheet.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, RotateCcw, UserPlus, X } from "lucide-react";
import { convertLeadAction, setLeadStatusAction } from "@/actions/leads";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { LeadStatus } from "@/db/schema";
import { friendlyError } from "@/lib/errors";
import { introRequestMailto } from "@/lib/leads/intro-request";
import type { PipelineRow } from "@/lib/leads/pipeline";
import { toast } from "@/lib/toast";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL } from "./labels";
import { PathSummary } from "./path-summary";
import { WarmthChip } from "./warmth-chip";

export function LeadDetailSheet({ row, onClose }: { row: PipelineRow | null; onClose: () => void }) {
  return (
    <Sheet
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="sm:max-w-md">
        {row ? <LeadDetail row={row} /> : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * One lead: who knows them, an intro ask per teammate who does (a mailto — the teammate's
 * email appears only inside that link), and the two decisions: add to contacts, or dismiss.
 */
function LeadDetail({ row }: { row: PipelineRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { lead, path } = row;
  const askable = (path?.direct ?? []).flatMap((d) =>
    d.teammate.email ? [{ userId: d.teammate.userId, name: d.teammate.name, email: d.teammate.email }] : []
  );

  function setStatus(status: LeadStatus, done: string) {
    start(async () => {
      try {
        const result = await setLeadStatusAction(lead.id, status);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(done);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update that lead — try again?"));
      }
    });
  }

  function convert() {
    start(async () => {
      try {
        const result = await convertLeadAction(lead.id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`${lead.displayName} is in your contacts`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t add them to your contacts — try again?"));
      }
    });
  }

  /** The mail client opens from the link itself; this only records that the ask happened. */
  function recordAsk() {
    if (lead.status === "open") setStatus("intro_requested", "Marked as intro asked");
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-ink">{lead.displayName}</SheetTitle>
        <SheetDescription>
          {[lead.title, lead.companyName].filter(Boolean).join(" · ") || LEAD_SOURCE_LABEL[lead.source]}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-5 overflow-y-auto px-4 pb-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {path ? <WarmthChip warmth={path.warmth} /> : null}
          <span className="text-xs text-muted-foreground">
            {LEAD_STATUS_LABEL[lead.status]} · {LEAD_SOURCE_LABEL[lead.source]}
          </span>
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Who knows them</h3>
          {path ? (
            <PathSummary path={path} companyName={lead.companyName} />
          ) : (
            <p className="text-muted-foreground">Join your team and share your network to see who knows them.</p>
          )}
        </section>

        {askable.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ask for an intro</h3>
            <p className="text-xs text-muted-foreground">Opens an email to your teammate, ready to send.</p>
            <div className="flex flex-wrap gap-2">
              {askable.map((mate) => (
                <a
                  key={mate.userId}
                  href={introRequestMailto({
                    teammateName: mate.name,
                    teammateEmail: mate.email,
                    leadName: lead.displayName,
                    leadCompany: lead.companyName,
                  })}
                  onClick={recordAsk}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <Mail aria-hidden />
                  Ask {mate.name.trim().split(/\s+/)[0]}
                </a>
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
          {lead.contactId ? (
            <Link href={`/contacts/${lead.contactId}`} className={buttonVariants({ size: "sm" })}>
              Open contact
            </Link>
          ) : (
            <Button type="button" size="sm" disabled={pending} onClick={convert}>
              <UserPlus aria-hidden />
              Add to contacts
            </Button>
          )}
          {lead.status === "dismissed" ? (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setStatus("open", "Lead reopened")}>
              <RotateCcw aria-hidden />
              Reopen
            </Button>
          ) : lead.status !== "converted" ? (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setStatus("dismissed", "Lead dismissed")}>
              <X aria-hidden />
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Write the list**

Create `src/components/leads/leads-pipeline.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { LeadStatus } from "@/db/schema";
import type { Pipeline, PipelineRow } from "@/lib/leads/pipeline";
import type { Warmth } from "@/lib/leads/warm-path";
import { cn } from "@/lib/utils";
import { LEAD_STATUS_LABEL } from "./labels";
import { LeadDetailSheet } from "./lead-detail-sheet";
import { PathSummary } from "./path-summary";
import { WARMTH_LABEL, WarmthChip } from "./warmth-chip";

type StatusTab = "open" | "converted" | "dismissed" | "all";

const STATUS_TABS: { key: StatusTab; label: string; matches: (status: LeadStatus) => boolean }[] = [
  { key: "open", label: "Open", matches: (s) => s === "open" || s === "intro_requested" },
  { key: "converted", label: "In contacts", matches: (s) => s === "converted" },
  { key: "dismissed", label: "Dismissed", matches: (s) => s === "dismissed" },
  { key: "all", label: "All", matches: () => true },
];

const WARMTH_FILTERS: (Warmth | "all")[] = ["all", "hot", "warm", "cool", "cold"];

const TEAM_NOTE: Record<Pipeline["team"], string> = {
  ok: "Ranked by who on your team knows them.",
  no_team: "Join your team to rank these by who knows them.",
  not_sharing: "Share your network to rank these by who knows them.",
};

const warmthOf = (row: PipelineRow): Warmth => row.path?.warmth ?? "cold";

/**
 * The saved leads, already ranked by the server (hottest first). Filters are client-side over
 * one list of at most `PIPELINE_LIMIT` rows; the sheet re-finds its row by id on every render,
 * so a refresh after an action shows the updated lead.
 */
export function LeadsPipeline({ pipeline }: { pipeline: Pipeline }) {
  const [tab, setTab] = useState<StatusTab>("open");
  const [warmth, setWarmth] = useState<Warmth | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeTab = STATUS_TABS.find((t) => t.key === tab) ?? STATUS_TABS[0];
  const visible = pipeline.rows.filter(
    (row) => activeTab.matches(row.lead.status) && (warmth === "all" || warmthOf(row) === warmth)
  );
  const selected = selectedId ? (pipeline.rows.find((row) => row.lead.id === selectedId) ?? null) : null;

  return (
    <section className="space-y-3" aria-labelledby="leads-pipeline-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="leads-pipeline-title" className="font-medium text-ink">
            Your leads
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{TEAM_NOTE[pipeline.team]}</p>
        </div>
        <div role="group" aria-label="Filter by status" className="flex rounded-lg border border-border/70 bg-card p-0.5 text-sm">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors duration-fast",
                tab === t.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}{" "}
              <span className="tabular-nums opacity-70">
                {pipeline.rows.filter((row) => t.matches(row.lead.status)).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {pipeline.team === "ok" && pipeline.rows.length > 0 && (
        <div role="group" aria-label="Filter by warmth" className="flex flex-wrap gap-1.5">
          {WARMTH_FILTERS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={warmth === w}
              onClick={() => setWarmth(w)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-fast",
                warmth === w
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/70 text-muted-foreground hover:text-foreground"
              )}
            >
              {w === "all" ? "Any path" : WARMTH_LABEL[w]}
            </button>
          ))}
        </div>
      )}

      {pipeline.rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-12 text-center">
          <p className="font-medium text-ink">No leads yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Find a path above or search Apollo below, then save the people you want to reach.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          Nothing here with these filters.
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-2xl border border-border/70 bg-card">
          {visible.map((row) => (
            <li key={row.lead.id}>
              <button
                type="button"
                onClick={() => setSelectedId(row.lead.id)}
                className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors duration-fast hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{row.lead.displayName}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {[row.lead.title, row.lead.companyName].filter(Boolean).join(" · ") || "No title or company yet"}
                  </p>
                  {row.path && <PathSummary path={row.path} companyName={row.lead.companyName} compact />}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {row.lead.status !== "open" && (
                    <Badge variant="outline" className="text-[10px]">
                      {LEAD_STATUS_LABEL[row.lead.status]}
                    </Badge>
                  )}
                  {row.lead.source === "apollo" && (
                    <Badge variant="secondary" className="text-[10px]">
                      Apollo
                    </Badge>
                  )}
                  {row.path ? <WarmthChip warmth={row.path.warmth} /> : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <LeadDetailSheet row={selected} onClose={() => setSelectedId(null)} />
    </section>
  );
}
```

- [ ] **Step 4: Run the smoke, typecheck, lint, the voice check**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint src/components/leads && npx tsx scripts/smoke-toast-copy.ts`
Expected: all pass. If `Sheet`'s `onOpenChange` has a two-argument signature, the one-argument handler above still type-checks; if it does not, match `src/components/ui/sheet.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/leads/leads-pipeline.tsx src/components/leads/lead-detail-sheet.tsx scripts/smoke-leads-page.ts
git commit -m "Add the leads pipeline and the lead sheet: intro asks, add to contacts, dismiss

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Apollo search on /leads

**Files:**
- Create: `src/components/leads/apollo-search.tsx` (client)
- Modify: `scripts/smoke-leads-page.ts` (`CLIENT_COMPONENTS` gains `"apollo-search.tsx"`)

**Interfaces:**
- Consumes: `searchApolloLeadsAction`, `saveApolloLeadAction` (Task 4); `APOLLO_MAX_PAGE`, `ApolloLeadRow`, `ApolloLeadSearch`, `ApolloSearchInput` (Task 4, pure module); `Label`, `Input`, `Button`; Task 5's pieces.
- Produces: `ApolloSearch()` — no props; used by the page in Task 10.

- [ ] **Step 1: Register it and watch the check fail**

Append `"apollo-search.tsx"` to `CLIENT_COMPONENTS`. Run the smoke. Expected: FAIL on `apollo-search.tsx exists`.

- [ ] **Step 2: Write the component**

Create `src/components/leads/apollo-search.tsx`:

```tsx
"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";
import { saveApolloLeadAction, searchApolloLeadsAction } from "@/actions/leads";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import {
  APOLLO_MAX_PAGE,
  type ApolloLeadRow,
  type ApolloLeadSearch,
  type ApolloSearchInput,
} from "@/lib/leads/apollo-leads";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PathSummary } from "./path-summary";
import { WarmthChip } from "./warmth-chip";

const EMPTY: ApolloSearchInput = { titles: "", companies: "", locations: "", keywords: "" };

const FIELDS: { key: keyof ApolloSearchInput; label: string; placeholder: string }[] = [
  { key: "titles", label: "Titles", placeholder: "VP Sales, Head of Partnerships" },
  { key: "companies", label: "Companies", placeholder: "Northwind, Lumen Labs" },
  { key: "locations", label: "Locations", placeholder: "New York, Remote" },
  { key: "keywords", label: "Keywords", placeholder: "fintech" },
];

const TEAM_NOTE = {
  no_team: "Join your team to see who knows these people.",
  not_sharing: "Share your network to see who knows these people.",
} as const;

/**
 * Apollo prospecting with the team's warm paths on every result. Collapsed by default: it is
 * the second way into the pipeline, after Find a path. Without an Apollo key `searchPeople`
 * returns invented people; the notice says so rather than letting them pass for real ones.
 */
export function ApolloSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<ApolloSearchInput>(EMPTY);
  const [result, setResult] = useState<ApolloLeadSearch | null>(null);
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();

  function run(page: number) {
    startSearch(async () => {
      try {
        const res = await searchApolloLeadsAction(input, page);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setResult((prev) => (page > 1 && prev ? { ...res.value, rows: [...prev.rows, ...res.value.rows] } : res.value));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t search Apollo — try again?"));
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(1);
  }

  function save(row: ApolloLeadRow) {
    startSave(async () => {
      try {
        const res = await saveApolloLeadAction(row.prospect);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setSaved((prev) => new Set(prev).add(row.prospect.externalId));
        toast.success(
          res.value.created
            ? `${row.prospect.fullName} saved to your leads`
            : `${row.prospect.fullName} is already in your leads`
        );
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save that lead — try again?"));
      }
    });
  }

  const hasMore = result ? result.rows.length < result.total && result.page < APOLLO_MAX_PAGE : false;

  return (
    <section className="rounded-2xl border border-border/70 bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="apollo-search-panel"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span>
          <span className="block font-medium text-ink">Search Apollo</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            Find new people by title and company, and see which ones your team already knows.
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-fast", open && "rotate-180")}
        />
      </button>

      {open && (
        <div id="apollo-search-panel" className="space-y-4 border-t border-border/60 p-5">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`apollo-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`apollo-${field.key}`}
                    value={input[field.key]}
                    placeholder={field.placeholder}
                    maxLength={300}
                    onChange={(event) => setInput((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
            <Button type="submit" disabled={searching}>
              <Search aria-hidden />
              {searching ? "Searching…" : "Search"}
            </Button>
          </form>

          {result && (
            <div className="space-y-3" aria-live="polite">
              {result.source === "demo" && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  Demo results — add your Apollo key in Settings to search real people. Warm paths
                  still work on them.
                </p>
              )}
              {result.team !== "ok" && <p className="text-xs text-muted-foreground">{TEAM_NOTE[result.team]}</p>}
              {result.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody matched — try fewer filters.</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
                  {result.rows.map((row) => {
                    const done = saved.has(row.prospect.externalId);
                    return (
                      <li key={row.prospect.externalId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-ink">{row.prospect.fullName}</p>
                          <p className="truncate text-sm text-muted-foreground">
                            {[row.prospect.title, row.prospect.company, row.prospect.location].filter(Boolean).join(" · ")}
                          </p>
                          {row.path && <PathSummary path={row.path} companyName={row.prospect.company} compact />}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {row.path ? <WarmthChip warmth={row.path.warmth} /> : null}
                          <Button type="button" size="sm" variant="outline" disabled={saving || done} onClick={() => save(row)}>
                            {done ? "Saved" : "Save"}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {hasMore && (
                <Button type="button" variant="ghost" size="sm" disabled={searching} onClick={() => run(result.page + 1)}>
                  {searching ? "Loading…" : "More results"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Run the smoke, typecheck, lint, the voice check**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint src/components/leads && npx tsx scripts/smoke-toast-copy.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/leads/apollo-search.tsx scripts/smoke-leads-page.ts
git commit -m "Add Apollo search to /leads, with the team's warm paths on every result

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Assemble the page

**Files:**
- Modify: `src/app/(clerk)/(app)/(main)/leads/page.tsx`, `src/app/(clerk)/(app)/(main)/leads/loading.tsx`
- Modify: `src/components/loading/page-skeletons.tsx` (two skeletons after `EventsListSkeleton`)
- Modify: `scripts/smoke-leads-page.ts` (structure section)

**Interfaces:**
- Consumes: `getTeamEligibility`, `listTeamMembersAction` (`@/actions/teams`); `loadPipelineAction` (Task 4); `requireUserId` (`@/lib/auth`); `TeamPanel` (Task 6), `FindPath` (Task 7), `LeadsPipeline` (Task 8), `ApolloSearch` (Task 9).
- Produces: `TeamPanelSkeleton()`, `LeadsPipelineSkeleton()`.

- [ ] **Step 1: Write the failing structure checks**

In `scripts/smoke-leads-page.ts`'s `structure` section, directly after the existing `loading.tsx renders the same header` check, add:

```ts
    const exportAt = page.indexOf("export default async function LeadsPage");
    for (const section of ["TeamSection", "PipelineSection"]) {
      const at = page.indexOf(`async function ${section}`);
      // A section above the export would put its `await` before the gate's in the file.
      check(`${section} is declared below the page`, at > exportAt && exportAt >= 0);
    }
    check("the page renders the four parts", ["<TeamSection", "<FindPath", "<PipelineSection", "<ApolloSearch"].every((part) => page.includes(part)));
    const loading = code("src/app/(clerk)/(app)/(main)/leads/loading.tsx");
    check("loading.tsx mirrors the page", loading.includes("TeamPanelSkeleton") && loading.includes("LeadsPipelineSkeleton"));
```

Run: `npx tsx scripts/smoke-leads-page.ts`
Expected: FAIL on `TeamSection is declared below the page`.

- [ ] **Step 2: Add the skeletons**

In `src/components/loading/page-skeletons.tsx`, directly after `EventsListSkeleton`, add:

```tsx
/** Mirrors the /leads team card. */
export function TeamPanelSkeleton() {
  return <Skeleton className="h-36 w-full rounded-2xl" />;
}

/** Mirrors the /leads pipeline: a heading with the status filter, then rows. */
export function LeadsPipelineSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-8 w-64 rounded-lg" />
      </div>
      <div className="divide-y divide-border/60 rounded-2xl border border-border/70 bg-card">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 px-5 py-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the page and its loading state**

Replace `src/app/(clerk)/(app)/(main)/leads/page.tsx` with:

```tsx
import { Suspense } from "react";
import { getTeamEligibility, listTeamMembersAction } from "@/actions/teams";
import { loadPipelineAction } from "@/actions/leads";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { ApolloSearch } from "@/components/leads/apollo-search";
import { FindPath } from "@/components/leads/find-path";
import { LeadsHeader } from "@/components/leads/leads-header";
import { LeadsPipeline } from "@/components/leads/leads-pipeline";
import { TeamPanel } from "@/components/leads/team-panel";
import { LeadsPipelineSkeleton, TeamPanelSkeleton } from "@/components/loading/page-skeletons";
import { requireUserId } from "@/lib/auth";

export default async function LeadsPage() {
  // First, before anything else: a click straight from a sibling route skips the
  // layout-level check (see `pageVisibilityGate`), and nothing below should run for a
  // page that is not out yet. The sections are declared below this function for the same
  // reason — `scripts/smoke-leads-page.ts` checks the gate is the file's first await.
  const gate = await pageVisibilityGate("page.leads");
  if (gate) return gate;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <div className="reveal-mount" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
        <Suspense fallback={<TeamPanelSkeleton />}>
          <TeamSection />
        </Suspense>
      </div>
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <FindPath />
      </div>
      <div className="reveal-mount" style={{ "--reveal-delay": "120ms" } as React.CSSProperties}>
        <Suspense fallback={<LeadsPipelineSkeleton />}>
          <PipelineSection />
        </Suspense>
      </div>
      <div className="reveal-mount" style={{ "--reveal-delay": "150ms" } as React.CSSProperties}>
        <ApolloSearch />
      </div>
    </div>
  );
}

async function TeamSection() {
  const [eligibility, userId] = await Promise.all([getTeamEligibility(), requireUserId()]);
  const members = eligibility.kind === "member" ? await listTeamMembersAction() : [];
  return <TeamPanel eligibility={eligibility} members={members} viewerUserId={userId} />;
}

async function PipelineSection() {
  const pipeline = await loadPipelineAction();
  return <LeadsPipeline pipeline={pipeline} />;
}
```

Replace `src/app/(clerk)/(app)/(main)/leads/loading.tsx` with:

```tsx
import { LeadsHeader } from "@/components/leads/leads-header";
import { LeadsPipelineSkeleton, TeamPanelSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (real header + the same skeletons) for a seamless handoff. */
export default function LeadsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <TeamPanelSkeleton />
      <LeadsPipelineSkeleton />
    </div>
  );
}
```

If `React.CSSProperties` does not resolve without an import in this file, copy exactly what `src/app/(clerk)/(app)/(main)/events/page.tsx` does for its `--reveal-delay` styles.

- [ ] **Step 4: Run the smokes, typecheck, lint**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint "src/app/(clerk)/(app)/(main)/leads" src/components/loading/page-skeletons.tsx && npx tsx scripts/run-smoke.ts --only smoke-surface-visibility`
Expected: all pass — including the original "the page gates before it does anything else".

- [ ] **Step 5: Commit**

```bash
git add "src/app/(clerk)/(app)/(main)/leads" src/components/loading/page-skeletons.tsx scripts/smoke-leads-page.ts
git commit -m "Assemble /leads: the team, Find a path, the pipeline and Apollo search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: "Hidden from team" on the contact page

**Files:**
- Create: `src/components/contacts/team-share-button.tsx` (client)
- Modify: `src/components/contacts/contact-stat-pills.tsx` (a `team` prop, rendered after the constellation button)
- Modify: `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx` (a guarded promise started with its neighbours; the prop)
- Modify: `scripts/smoke-leads-page.ts` (a "contact page" section)

**Interfaces:**
- Consumes: `setContactTeamSharedAction(contactId, shared): Promise<ActionResult<{ shared: boolean }>>` (`@/actions/teams`); `getViewerTeam` (`@/lib/teams`); `resolveSurfaceVisibility` (`@/lib/surface-visibility`, returns `{ hidden, comingSoon, … }` sets); `contact.teamShared` (integer, from `getContact`).
- Produces: `TeamShareButton({ contactId, shared })`; `ContactStatPills` gains `team?: { contactId: string; shared: boolean }`.

- [ ] **Step 1: Write the failing checks**

Add this section to `scripts/smoke-leads-page.ts` before `structure`:

```ts
  console.log("\nthe contact page's team pill");
  {
    const button = "src/components/contacts/team-share-button.tsx";
    check("the pill is a client component", existsSync(button) && /^\s*"use client";/.test(readFileSync(button, "utf8")));
    check("the stat pills render it only when given a team", /team\s*&&\s*\(?\s*<TeamShareButton/.test(code("src/components/contacts/contact-stat-pills.tsx")));
    const contactPage = code("src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx");
    // A control for a closed feature is worse than none: the pill follows Leads' release.
    check("the contact page shows it only while Leads is released", contactPage.includes('comingSoon.has("page.leads")') && contactPage.includes('hidden.has("page.leads")'));
    check("and only to a team member", contactPage.includes("getViewerTeam("));
  }
```

Run the smoke. Expected: FAIL on `the pill is a client component`.

- [ ] **Step 2: Write the pill**

Create `src/components/contacts/team-share-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Loader2, Users } from "lucide-react";
import { setContactTeamSharedAction } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The per-contact exception to team sharing, beside the constellation pin and shaped like it.
 * "Visible" means a teammate who looks this person up learns that you know them and how
 * closely — nothing else. The contact page decides whether to show it at all.
 */
export function TeamShareButton({ contactId, shared }: { contactId: string; shared: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState(shared);
  const [pending, start] = useTransition();

  function toggle() {
    const next = !current;
    setCurrent(next);
    start(async () => {
      try {
        const result = await setContactTeamSharedAction(contactId, next);
        if (!result.ok) {
          setCurrent(!next);
          toast.error(result.error);
          return;
        }
        router.refresh();
      } catch (err) {
        setCurrent(!next);
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      aria-pressed={!current}
      title={
        current
          ? "Teammates who look this person up can see that you know them, and how closely — click to hide"
          : "Hidden from your team — click to let teammates see that you know them"
      }
      onClick={toggle}
      className={cn("rounded-full", !current && "text-muted-foreground")}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : current ? <Users aria-hidden /> : <EyeOff aria-hidden />}
      {current ? "Visible to team" : "Hidden from team"}
    </Button>
  );
}
```

- [ ] **Step 3: Wire it into the stat pills and the contact page**

In `src/components/contacts/contact-stat-pills.tsx`: import `TeamShareButton` from `@/components/contacts/team-share-button`; add to the props (after `constellation`):

```ts
  /**
   * Present only for a team member while Leads is released for them — the contact page
   * decides. The per-contact "Hidden from team" exception.
   */
  team?: { contactId: string; shared: boolean };
```

destructure `team`, and directly after the `{constellation && (…)}` block render:

```tsx
      {team && <TeamShareButton contactId={team.contactId} shared={team.shared} />}
```

In `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx`: import `getViewerTeam` from `@/lib/teams` and `resolveSurfaceVisibility` from `@/lib/surface-visibility`. Directly after `const profilePromise = …;` add:

```ts
  // The "Hidden from team" pill: only for a team member, and only while Leads is released for
  // this viewer — a control for a closed feature is worse than none. Mandatory `.catch`, like
  // its neighbours: started before the first await.
  const teamPillPromise = userIdPromise
    .then(async (u) => {
      const [membership, visibility] = await Promise.all([getViewerTeam(u), resolveSurfaceVisibility(u)]);
      return (
        membership !== null &&
        !visibility.hidden.has("page.leads") &&
        !visibility.comingSoon.has("page.leads")
      );
    })
    .catch(() => false);
```

After the `if (!contact) { … }` block (the first place `contact` is known to exist), add `const showTeamPill = await teamPillPromise;`, and pass to `<ContactStatPills …>`:

```tsx
      team={showTeamPill ? { contactId: contact.id, shared: contact.teamShared === 1 } : undefined}
```

- [ ] **Step 4: Run the smokes, typecheck, lint**

Run: `npx tsx scripts/smoke-leads-page.ts && npx tsc --noEmit && npx eslint src/components/contacts/team-share-button.tsx src/components/contacts/contact-stat-pills.tsx "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" && npx tsx scripts/smoke-toast-copy.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/contacts/team-share-button.tsx src/components/contacts/contact-stat-pills.tsx "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-leads-page.ts
git commit -m "Add the Hidden from team pill to the contact page, for members while Leads is open

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The demo team

**Files:**
- Create: `src/lib/demo-data/team.ts`
- Modify: `src/lib/demo-data/seed.ts` (a `team` surface)
- Modify: `scripts/smoke-demo-data.ts` (assertions + cleanup)

**Interfaces:**
- Consumes: `joinTeamWithDomain` (`@/lib/teams`); `saveLead` (Task 3); `loadPipeline` (Task 3, in the smoke); `claimIdentities` (`@/lib/contact-identity`); `resolveCompany` (`@/lib/companies`); `ensureUserSettings` (`@/lib/user-settings`); `identityKeysFor`; `DEMO_SOURCE`.
- Produces: `DEMO_TEAM_DOMAIN`, `DEMO_TEAMMATES`, `DEMO_TEAMMATE_CONTACTS`, `DEMO_LEADS` (with `expected` warmth).

- [ ] **Step 1: Write the fixture**

Create `src/lib/demo-data/team.ts`:

```ts
/**
 * The demo team: two synthetic colleagues on the demo account's `orbit.local` domain, the
 * people they know, and four leads that land on every rung of the warmth ladder — so /leads
 * opens full on localhost, and a change that breaks the ranking shows there first.
 *
 * Colleagues are shared by every local account, like the demo recruiters: the first account
 * to seed creates their contacts, later ones only join the team.
 */
export const DEMO_TEAM_DOMAIN = "orbit.local";

export type DemoTeammate = { userId: string; firstName: string; lastName: string; email: string };

export const DEMO_TEAMMATES: readonly DemoTeammate[] = [
  { userId: "demo-teammate-alex", firstName: "Alex", lastName: "Rivera", email: "alex@orbit.local" },
  { userId: "demo-teammate-priya", firstName: "Priya", lastName: "Nair", email: "priya@orbit.local" },
];

export type DemoTeammateContact = {
  teammate: string;
  fullName: string;
  email: string;
  company: string;
  title: string;
  tier: "inner" | "mid" | "outer";
  closeness: number;
};

export const DEMO_TEAMMATE_CONTACTS: readonly DemoTeammateContact[] = [
  { teammate: "demo-teammate-alex", fullName: "Dana Whitfield", email: "dana@northwind.example", company: "Northwind Health", title: "VP Operations", tier: "inner", closeness: 84 },
  { teammate: "demo-teammate-alex", fullName: "Grace Okafor", email: "grace@lumenlabs.example", company: "Lumen Labs", title: "Head of Data", tier: "mid", closeness: 56 },
  { teammate: "demo-teammate-alex", fullName: "Leo Martins", email: "leo@northwind.example", company: "Northwind Health", title: "Procurement Lead", tier: "outer", closeness: 24 },
  { teammate: "demo-teammate-priya", fullName: "Grace Okafor", email: "grace@lumenlabs.example", company: "Lumen Labs", title: "Head of Data", tier: "outer", closeness: 31 },
  { teammate: "demo-teammate-priya", fullName: "Sam Patel", email: "sam@brightpath.example", company: "Brightpath", title: "CTO", tier: "outer", closeness: 22 },
];

export type DemoLead = {
  displayName: string;
  email: string;
  companyName: string;
  title: string;
  /** Where the seed must land it: the smoke checks every rung. */
  expected: "hot" | "warm" | "cool" | "cold";
};

export const DEMO_LEADS: readonly DemoLead[] = [
  // Alex knows Dana well: hot. Alex also knows Leo at Northwind, an account path.
  { displayName: "Dana Whitfield", email: "dana@northwind.example", companyName: "Northwind Health", title: "VP Operations", expected: "hot" },
  // Alex (mid) and Priya (outer) both know Grace: warm.
  { displayName: "Grace Okafor", email: "grace@lumenlabs.example", companyName: "Lumen Labs", title: "Head of Data", expected: "warm" },
  // Nobody knows Ivy, but Priya knows Sam at Brightpath: cool.
  { displayName: "Ivy Chen", email: "ivy@brightpath.example", companyName: "Brightpath", title: "VP Engineering", expected: "cool" },
  { displayName: "Marco Russo", email: "marco@quarry.example", companyName: "Quarry", title: "Founder", expected: "cold" },
];
```

- [ ] **Step 2: Write the failing smoke checks**

In `scripts/smoke-demo-data.ts`:
- add `leads`, `teamMembers`, `teams` to the `../src/db/schema` import; add `import { DEMO_LEADS, DEMO_TEAM_DOMAIN, DEMO_TEAMMATE_CONTACTS, DEMO_TEAMMATES } from "../src/lib/demo-data/team";` and `import { loadPipeline } from "../src/lib/leads/pipeline";`
- in `cleanup()`, set `const users = [FRESH, REMOTE_USER, EXISTING, SECOND, ...DEMO_TEAMMATES.map((m) => m.userId)];`, add `leads` and `teamMembers` at the FRONT of the table list, and after the loop add `await db.delete(teams).where(eq(teams.domain, DEMO_TEAM_DOMAIN));`
- directly after the `goals seeded` check add:

```ts
    console.log("\nthe demo team");
    const pipeline = await loadPipeline(FRESH);
    check("the demo account is on a sharing team", pipeline.team === "ok", pipeline.team);
    check(`the demo leads are seeded (${DEMO_LEADS.length})`, pipeline.rows.length === DEMO_LEADS.length, String(pipeline.rows.length));
    const warmthOf = new Map(pipeline.rows.map((r) => [r.lead.displayName, r.path?.warmth ?? "none"]));
    check(
      "the leads land on every rung of the ladder",
      DEMO_LEADS.every((l) => warmthOf.get(l.displayName) === l.expected),
      JSON.stringify([...warmthOf])
    );
```

- directly after the point where `SECOND` is seeded (in the recruiter section), add:

```ts
    const alex = DEMO_TEAMMATES[0].userId;
    const alexContacts = await rowsFor(contacts, contacts.userId, alex);
    check(
      "a later account reuses the demo colleagues",
      alexContacts === DEMO_TEAMMATE_CONTACTS.filter((c) => c.teammate === alex).length,
      String(alexContacts)
    );
    check("…and joins the same team", (await loadPipeline(SECOND)).team === "ok");
```

Run: `npx tsx scripts/run-smoke.ts --only smoke-demo-data`
Expected: FAIL on `the demo account is on a sharing team` (`no_team`).

- [ ] **Step 3: Seed the team**

In `src/lib/demo-data/seed.ts`:
- add `resolveCompany` to the existing `@/lib/companies` import; add imports:

```ts
import { claimIdentities } from "@/lib/contact-identity";
import { saveLead } from "@/lib/leads/store";
import { joinTeamWithDomain } from "@/lib/teams";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  DEMO_LEADS,
  DEMO_TEAM_DOMAIN,
  DEMO_TEAMMATE_CONTACTS,
  DEMO_TEAMMATES,
} from "@/lib/demo-data/team";
```

- add `["team", () => seedTeam(userId, summary)],` as the last entry of the `surfaces` array;
- add this function after the `goals` seeder:

```ts
/* ------------------------------------------------------------------------------ team */

/**
 * The demo team on `orbit.local`: two colleagues who share their networks, the people they
 * know (with explicit closeness — nobody ever reads their accounts, so nothing would score
 * them), and four leads for this account that land hot, warm, cool and cold. Colleagues'
 * contacts are created once; a later local account only joins.
 */
async function seedTeam(userId: string, summary: DemoSeedSummary): Promise<void> {
  const db = await getDb();
  for (const mate of DEMO_TEAMMATES) {
    await ensureUserSettings(mate.userId);
    await db
      .update(userSettings)
      .set({ firstName: mate.firstName, lastName: mate.lastName, email: mate.email })
      .where(eq(userSettings.userId, mate.userId));
    await joinTeamWithDomain(mate.userId, DEMO_TEAM_DOMAIN, { shareNetwork: true });

    const existing = await db.query.contacts.findFirst({
      where: eq(contacts.userId, mate.userId),
      columns: { id: true },
    });
    if (existing) continue;
    for (const person of DEMO_TEAMMATE_CONTACTS.filter((c) => c.teammate === mate.userId)) {
      const company = await resolveCompany(mate.userId, person.company);
      const [row] = await db
        .insert(contacts)
        .values({
          userId: mate.userId,
          fullName: person.fullName,
          email: person.email,
          title: person.title,
          company: company?.name ?? person.company,
          companyId: company?.id ?? null,
          closenessTier: person.tier,
          closeness: person.closeness,
          source: DEMO_SOURCE,
        })
        .returning();
      await claimIdentities(mate.userId, row.id, identityKeysFor({ email: person.email }), DEMO_SOURCE);
    }
  }

  await joinTeamWithDomain(userId, DEMO_TEAM_DOMAIN, { shareNetwork: true });
  for (const lead of DEMO_LEADS) {
    await saveLead(userId, {
      source: "manual",
      displayName: lead.displayName,
      email: lead.email,
      companyName: lead.companyName,
      title: lead.title,
    });
  }
  summary.teamMembers = DEMO_TEAMMATES.length + 1;
  summary.leads = DEMO_LEADS.length;
}
```

If `userSettings.email`, `contacts.closenessTier` or `contacts.closeness` are named differently in `src/db/schema.ts`, use the schema's names; do not add columns.

- [ ] **Step 4: Run the smokes, typecheck, lint**

Run: `npx tsx scripts/run-smoke.ts --only smoke-demo-data smoke-leads smoke-purge && npx tsc --noEmit && npx eslint src/lib/demo-data scripts/smoke-demo-data.ts`
Expected: all pass, including every rung of the ladder.

- [ ] **Step 5: Commit**

```bash
git add src/lib/demo-data/team.ts src/lib/demo-data/seed.ts scripts/smoke-demo-data.ts
git commit -m "Seed a demo team whose four leads land hot, warm, cool and cold

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Whole-branch verification, the browser, and the PR (controller)

**Files:** none new unless a check fails.

- [ ] **Step 1: Rescan the schema number**

```bash
bash -c 'for r in $(git for-each-ref --format="%(refname)" refs/heads refs/remotes); do v=$(git show "$r:src/db/index.ts" 2>/dev/null | grep -oE "^export const SCHEMA_VERSION = [0-9]+" | grep -oE "[0-9]+$"); [ -n "$v" ] && [ "$v" -ge 90 ] && echo "$v $r"; done | sort -rn; git worktree list --porcelain | grep "^worktree " | cut -d" " -f2 | while read w; do v=$(grep -hoE "^export const SCHEMA_VERSION = [0-9]+" "$w/src/db/index.ts" 2>/dev/null | grep -oE "[0-9]+$"); [ -n "$v" ] && [ "$v" -ge 90 ] && echo "$v $(git -C "$w" rev-parse --abbrev-ref HEAD)"; done | sort -rn'
```
Expected: only this branch claims 92. Otherwise take the next free number, update the changelog, `smoke-schema-ddl --update`.

- [ ] **Step 2: Run everything, without a tail pipe**

```bash
npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check
npm test > "$SCRATCH/leads-p3-suite.log" 2>&1; echo "exit=$?"; grep -E "^ *FAIL|passed in" "$SCRATCH/leads-p3-suite.log"
npm run build; rm -rf .next
```
Expected: tsc silent; eslint 0 errors; manifest ok; suite exit 0 with no FAIL lines; build exit 0.

- [ ] **Step 3: See it in the browser**

The demo account on localhost is an admin, and coming-soon pages are closed for admins too. Start the demo preview on a fresh local database (the existing `.data/pglite` already holds a demo account from before the team seed existed — move it aside, do not delete it), open `/leads`, and set the preview cookie the way `setPreviewUnreleasedAction` does (read `src/lib/surface-visibility.ts` for the cookie name and value; `/admin` may 404 in a worktree with no `.env`). Front the Browser-pane tab before any interaction — a hidden tab never hydrates. Check, with screenshots:
- the team card reads "Orbit team" with Alex Rivera, Priya Nair and you, all sharing;
- the pipeline lists Dana (Hot path), Grace (Warm path), Ivy (Cool path), Marco (No path yet), in that order;
- Dana's sheet shows "Alex Rivera · Inner orbit · via email", "Alex Rivera knows 1 other at Northwind Health", and an "Ask Alex" link whose `href` is a `mailto:` to `alex@orbit.local`;
- Find a path with `grace@lumenlabs.example` shows Warm path; saving an unknown email adds a cold lead;
- Apollo search with Titles "VP Sales" shows the demo notice and results with Save buttons;
- a contact page shows "Visible to team"; clicking it flips to "Hidden from team";
- the page at 375px wide has no horizontal scroll.
Then remove the cookie and confirm `/leads` shows the coming-soon screen again.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin claude/leads-p3-pipeline
gh pr create --base claude/leads-p2-teams --title "Leads P3: the pipeline and the /leads page (schema v92)" --body-file "$SCRATCH/leads-p3-pr.md"
```

The PR body names the rulings above, the schema number, what the browser check showed, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

- **Spec coverage:** `leads` table and purge (Task 1); identity contract with `contact_identities` (Task 2); store, dedupe, convert via the shared resolver, pipeline ranking without per-lead queries (Task 3); actions with the release gate, Apollo search with warm paths (Task 4); the page's four parts — team panel (6), find a path (7), pipeline and sheet with the intro ask (8), Apollo (9), assembly (10); the per-contact opt-out pill (11); the demo team (12). `crm_records`, `crm_record_id`, the `crm` entitlement and the Contacts "Work" pill are P4 by the spec's phase table.
- **Placeholders:** none; every code step carries its code, and the three "if the repo's API differs" notes name the file to copy from.
- **Type consistency:** `LeadInput`/`NormalizedLead` (Task 2) are what `saveLead` (3), the actions (4) and `apollo-leads` (4) use; `Pipeline`/`PipelineRow` (3) are what the actions (4), `LeadsPipeline` and `LeadDetailSheet` (8) use; `ApolloSearchInput`/`ApolloLeadSearch`/`ApolloLeadRow`/`ApolloProspectView`/`APOLLO_MAX_PAGE` (4) are what `ApolloSearch` (9) uses; `WARMTH_LABEL`, `WarmthChip`, `PathSummary`, `SharingDl`, `LEAD_STATUS_LABEL`, `LEAD_SOURCE_LABEL` (5) are what Tasks 6–9 import; `TeamPanel`'s props (6) are what the page (10) passes.

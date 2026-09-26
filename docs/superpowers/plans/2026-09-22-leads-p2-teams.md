# Leads P2: Teams and the Who-Knows-Whom Index — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user with a verified work email can join their company's team, choose to share their network, and look up a person to learn which sharing teammates know them and how closely — with nothing else about those contacts leaving the database.

**Architecture:** Two new tables (`teams`, `team_members`) plus a per-contact opt-out column and two cross-user indexes. A pure domain module, a server team-lifecycle module, and a warm-path query split into pure SQL builders (so a smoke can grep the rendered statement for forbidden columns) and a thin executor. Server actions gate on a new `requireReleasedSurface`, which closes a coming-soon page's actions the way its page is closed.

**Tech Stack:** Next.js 16 App Router (Server Actions), Drizzle ORM on Postgres (Neon in prod, PGlite locally), runtime DDL in `src/db/index.ts`, `tsx` smoke scripts under `scripts/` registered in `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-22-leads-design.md` (sections Decisions, Data model, Modules, The warm-path query). Read it first.

**Branch:** `claude/leads-p2-teams`, stacked on `claude/coming-soon-leads-tab-93382b` (PR #264). Open the PR against that branch until #264 merges, then retarget to `main`.

## Global Constraints

- `SCHEMA_VERSION` becomes **90**. 87 (`claude/orbit-integrations-strategy-0b8be6`), 88 (`claude/memory-chunk-restale`) and 89 (`claude/deepgram-speech`) are claimed on other branches as of the Sep 22 2026 scan. **Rescan every remote ref and every local worktree before pushing** (`bash -c` — the `$ref:path` form trips zsh) and take the next free number; two branches writing the same number merge silently.
- Booleans on rows are integers: `integer(...).default(0).notNull()` for opt-ins (start empty), `default(1)` for the per-contact opt-out.
- New tables: Drizzle in `src/db/schema.ts` + `CREATE TABLE IF NOT EXISTS` with its indexes in the `DDL` template in `src/db/index.ts` + `scripts/setup-db.ts` `EXPECTED_TABLES` + a purge step. New columns on existing tables: the `DDL` template **and** `alters` **and** `ensureColumn` in `migratePglite`. No `--` comments or `;` inside DDL strings. Never `db:push`.
- Every table with a `user_id` column is seeded and purged in `scripts/smoke-purge.ts`; every `DataCategory` has a `WITNESS` entry in `scripts/smoke-purge-selective.ts`.
- `src/lib/team-domain.ts`, `src/lib/leads/warm-path.ts`, `src/lib/leads/target-input.ts`, `src/lib/leads/warm-path-sql.ts` never value-import `@/db` (type imports are fine). They may be imported by client components later.
- `contact_identities` is written only by `claimIdentities` in `src/lib/contact-identity.ts`.
- Errors a person should read are `UserFacingError`; actions wrap them with `asActionResult`. Never surface `err.message`.
- Privacy boundary (the spec's SELECT-list rule): the warm-path statements never name `notes`, `ai_summary`, `key_facts`, `c.email`, `c.phone`, `linkedin_url`; `share_network = 1`, `team_shared = 1` and `<> viewer` live in SQL; no correlated `EXISTS` over tenant tables; no column interpolated inside a drizzle `.select()` projection.
- Every new smoke script is added to `MANIFEST` in `scripts/run-smoke.ts` (`pure` or `pglite`); `npx tsx scripts/run-smoke.ts --check` must pass.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `src/db/schema.ts` | `teams`, `teamMembers`, `contacts.teamShared` |
| `src/db/index.ts` | DDL for the above, two indexes, `SCHEMA_VERSION = 90` |
| `scripts/setup-db.ts` | `EXPECTED_TABLES` |
| `src/lib/team-domain.ts` (new, pure) | `teamDomainForEmail`, `teamNameForDomain`, `teammateDisplayName`, `TEAM_DELETED_CREATOR` |
| `src/lib/data-categories.ts`, `src/lib/user-data.ts` | the `leads` purge category and step |
| `src/lib/surface-visibility.ts`, `src/lib/plan-guards.ts` | `requireReleasedSurface`, `requireLeadsUser` |
| `src/lib/teams.ts` (new) | team lifecycle: eligibility, join, leave, sharing, members |
| `src/lib/leads/warm-path.ts` (new, pure) | types, `rankWarmth`, `identityPairs` |
| `src/lib/leads/target-input.ts` (new, pure) | `parseTargetInput` |
| `src/lib/leads/warm-path-sql.ts` (new, pure) | `directPathsStatement`, `accountPathsStatement` |
| `src/lib/leads/warm-path-query.ts` (new) | `warmPathsForTargets`, `findWarmPaths` |
| `src/actions/teams.ts` (new) | Server Actions for the above |
| `scripts/smoke-warm-path.ts` (new, pure) | domain, parser, ladder, SQL-text guard, action structure |
| `scripts/smoke-team-lifecycle.ts` (new, pglite) | join/leave/sharing/opt-out against PGlite |
| `scripts/smoke-warm-paths.ts` (new, pglite) | the privacy boundary against seeded data |
| `scripts/smoke-purge.ts`, `scripts/smoke-purge-selective.ts`, `scripts/smoke-surface-visibility.ts` | seeds and guard checks |

---

### Task 1: Schema and DDL (v90)

**Files:**
- Modify: `src/db/schema.ts` (contacts block near line 447; new tables after `contactIdentities`, ~line 610)
- Modify: `src/db/index.ts` (template ~line 122 and ~line 98 and ~line 1318; `SCALE_DDL` ~line 2111; `alters` end ~line 3310; `migratePglite` ~line 2431; changelog ~line 1762)
- Modify: `scripts/setup-db.ts:12-54`
- Modify: `scripts/schema-ddl.lock.json` (regenerated)

**Interfaces:**
- Produces: `teams`, `teamMembers` Drizzle tables and `Team`, `TeamMember` types; `contacts.teamShared`.

- [ ] **Step 1: Add the Drizzle definitions**

In `src/db/schema.ts`, directly after `constellationPin: text("constellation_pin").$type<"in" | "out">(),` (line 447) add:

```ts
    /**
     * Whether teammates may learn that this person is in the user's network (name and
     * closeness tier only — see `src/lib/leads/warm-path-sql.ts`). Integer per house
     * convention. Defaults to shared but is inert until `team_members.share_network` is 1:
     * the per-team switch is the real gate and this is the per-contact exception, the
     * `user_recruiter_links.shared_to_pool` shape. Survives leaving and rejoining a team.
     */
    teamShared: integer("team_shared").default(1).notNull(),
```

After the `contactIdentities` table (after its `NewContactIdentity` type export) add:

```ts
/**
 * A team is a verified email domain. Everyone whose Clerk primary email is verified at
 * `@acme.com` may join the one `acme.com` team; public mail domains never form one
 * (`teamDomainForEmail` in `src/lib/team-domain.ts`). The row is shared, not user-scoped:
 * `created_by` is deliberately NOT named `user_id`, so the purge's derived scan does not
 * demand a delete — a creator's account can go while the team stays, and their id is
 * rewritten to `TEAM_DELETED_CREATOR` instead (the `recruiters.created_by_user_id` rule).
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Lower-cased. The team's identity. */
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("teams_domain_uidx").on(t.domain)]
);

export type Team = typeof teams.$inferSelect;

/**
 * One row per member. `share_network` is the reciprocal opt-in: 0 contributes nothing
 * to the who-knows-whom lookups and sees nothing from them. Starts at 0 for everyone,
 * like `user_settings.recruiter_sharing`, and is read live by every query — never
 * cached — so switching it off withdraws a person's contacts immediately.
 */
export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Unique: one team per user, because a user has one verified primary email. */
    userId: text("user_id").notNull(),
    shareNetwork: integer("share_network").default(0).notNull(),
    /** The domain proven at join time, kept so a later re-verification can compare. */
    emailDomain: text("email_domain").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("team_members_user_uidx").on(t.userId),
    index("team_members_team_sharing_idx").on(t.teamId, t.shareNetwork),
  ]
);

export type TeamMember = typeof teamMembers.$inferSelect;
```

- [ ] **Step 2: Run the DDL coverage smoke to see it fail**

Run: `npx tsx scripts/smoke-schema-ddl.ts`
Expected: FAIL — columns `teams.*`, `team_members.*`, `contacts.team_shared` have no DDL; unique indexes `teams_domain_uidx`, `team_members_user_uidx` missing.

- [ ] **Step 3: Add the runtime DDL**

In `src/db/index.ts`:

(a) In the `contacts` CREATE TABLE of the `DDL` template, after `  constellation_pin text,` (line 122) add:

```sql
  team_shared integer NOT NULL DEFAULT 1,
```

(b) After `CREATE UNIQUE INDEX IF NOT EXISTS companies_user_name_uidx ON companies(user_id, name_normalized);` (line 98) add:

```sql
CREATE INDEX IF NOT EXISTS companies_name_normalized_idx ON companies(name_normalized);
```

(c) After the `contact_identities` CREATE TABLE block in the template (ends ~line 1318) add:

```sql
CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_domain_uidx ON teams(domain);
CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  share_network integer NOT NULL DEFAULT 0,
  email_domain text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_user_uidx ON team_members(user_id);
CREATE INDEX IF NOT EXISTS team_members_team_sharing_idx ON team_members(team_id, share_network);
```

(d) In `SCALE_DDL`, directly after the `contact_identities_contact_idx` entry (~line 2111) add:

```ts
  // The who-knows-whom lookup: a teammate's identity, matched across every user's contacts.
  // The unique index above leads with user_id and cannot serve a cross-user probe.
  `CREATE INDEX IF NOT EXISTS contact_identities_kind_value_idx
     ON contact_identities(kind, value)`,
```

(e) In `alters`, after the `companies_user_name_uidx` line (~line 3046) add:

```ts
  `CREATE INDEX IF NOT EXISTS companies_name_normalized_idx ON companies(name_normalized)`,
```

and as the last entries before the closing `];` (~line 3311):

```ts
  // v90: the Leads team model (docs/superpowers/specs/2026-09-22-leads-design.md, P2).
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS team_shared integer NOT NULL DEFAULT 1`,
```

(f) In `migratePglite`, next to `await ensureColumn(client, "contacts", "constellation_pin", "text");` (~line 2431) add:

```ts
  await ensureColumn(client, "contacts", "team_shared", "integer NOT NULL DEFAULT 1");
```

(g) Replace the changelog tail and version (lines ~1758-1762) with:

```ts
// NOT 83 anymore. Both 84 and 85 above landed in main while this branch (chat-source-chips)
// was still in review. Rescanned against every remote branch and every local worktree on
// Sep 22 2026, after merging main (now at 85) into this branch a second time; 86 is still
// the highest found anywhere and is still free.
//
// 87 (claude/orbit-integrations-strategy-0b8be6, the connector spine), 88
// (claude/memory-chunk-restale) and 89 (claude/deepgram-speech) are claimed on branches that
// had not merged when this was written.
//
// 90 = teams, team_members, contacts.team_shared, contact_identities(kind, value) and
// companies(name_normalized): the Leads team model and the who-knows-whom index — P2 of
// docs/superpowers/specs/2026-09-22-leads-design.md. Rescanned every remote ref and every
// local worktree on Sep 22 2026; 90 was free. Whichever of 87–90 lands later renumbers.
export const SCHEMA_VERSION = 90;
```

(h) In `scripts/setup-db.ts` `EXPECTED_TABLES`, after `"broadcast_recipients",` add `"teams",` and `"team_members",`.

- [ ] **Step 4: Regenerate the lock and run the schema smokes**

Run:
```bash
npx tsx scripts/smoke-schema-ddl.ts --update && npx tsx scripts/run-smoke.ts --only smoke-schema-ddl smoke-schema-upgrade
```
Expected: both `ok`. `smoke-schema-upgrade` proves a v89 PGlite database reconciles to v90 with the new tables, the column and every named index present.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git add src/db/schema.ts src/db/index.ts scripts/setup-db.ts scripts/schema-ddl.lock.json
git commit -m "Add teams, team_members and contacts.team_shared (schema v90)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The pure team-domain module

**Files:**
- Create: `src/lib/team-domain.ts`
- Create: `scripts/smoke-warm-path.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, next to `"smoke-leads-page": "pure",`)

**Interfaces:**
- Consumes: `publicEmailDomain(domain: string): boolean` from `src/lib/closeness-evidence.ts`.
- Produces: `TEAM_DELETED_CREATOR`, `teamDomainForEmail(email): string | null`, `teamNameForDomain(domain): string`, `teammateDisplayName({ firstName, lastName, email }): string`.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-warm-path.ts`:

```ts
/**
 * The pure half of Leads P2: team domains, target parsing, the warmth ladder, the SQL the
 * who-knows-whom lookup renders, and the shape of the actions in front of it.
 *
 * The SQL section is the privacy boundary as text. The statements are built by pure
 * functions precisely so this script can render them without a database and grep for the
 * columns that must never appear — a wrong join would otherwise only show up as a leak.
 */
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  TEAM_DELETED_CREATOR,
  teamDomainForEmail,
  teamNameForDomain,
  teammateDisplayName,
} from "../src/lib/team-domain";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A module with its comments stripped, so prose describing a rule cannot trip the rule. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const dialect = new PgDialect();

function main() {
  console.log("\nteam domains");
  {
    check("a work address gives its domain, lower-cased", teamDomainForEmail("Ada@Acme.com") === "acme.com");
    check("a public mailbox forms no team", teamDomainForEmail("ada@gmail.com") === null);
    check("nor does a missing address", teamDomainForEmail(null) === null && teamDomainForEmail("") === null);
    check("nor a string that is not an address", teamDomainForEmail("not-an-email") === null);
    check("nor a bare host", teamDomainForEmail("x@localhost") === null);
    check("the demo account's domain counts", teamDomainForEmail("demo@orbit.local") === "orbit.local");
    check("acme.com → Acme", teamNameForDomain("acme.com") === "Acme");
    check("acme.co.uk → Acme", teamNameForDomain("acme.co.uk") === "Acme");
    check("eu.acme.com → Acme", teamNameForDomain("eu.acme.com") === "Acme");
    check("orbit.local → Orbit", teamNameForDomain("orbit.local") === "Orbit");
    check("full name wins", teammateDisplayName({ firstName: "Ada", lastName: "Lovelace", email: "a@x.io" }) === "Ada Lovelace");
    check("one name is fine", teammateDisplayName({ firstName: "Ada", lastName: null, email: null }) === "Ada");
    check("pre-mirror accounts fall back to the mailbox", teammateDisplayName({ firstName: null, lastName: null, email: "priya@acme.com" }) === "priya");
    check("and to a neutral word after that", teammateDisplayName({ firstName: null, lastName: null, email: null }) === "A teammate");
    check("the purge sentinel matches recruiters'", TEAM_DELETED_CREATOR === "deleted-account");
  }

  console.log("\nclient-bundle safety");
  {
    for (const file of ["src/lib/team-domain.ts"]) {
      const valueDbImport = /import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(code(file));
      check(`${file} never value-imports @/db`, !valueDbImport);
    }
  }

  void dialect;

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll warm-path checks passed.");
}

main();
```

Register it: in `scripts/run-smoke.ts` after `"smoke-leads-page": "pure",` add `"smoke-warm-path": "pure",`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/team-domain'`.

- [ ] **Step 3: Write the module**

Create `src/lib/team-domain.ts`:

```ts
/**
 * What makes a team, without a database: the domain rule and the names shown for people
 * on one. Pure and client-safe — the join card and the warm-path chips import it.
 */
import { publicEmailDomain } from "@/lib/closeness-evidence";

/**
 * Written into `teams.created_by` when the creator's account is purged. Same word as
 * `RECRUITER_DELETED_CREATOR`, for the same reason: never null, never a dangling id.
 */
export const TEAM_DELETED_CREATOR = "deleted-account";

/**
 * The team a verified email belongs to, or null when it cannot form one: no address, no
 * dot in the host, or a public mailbox provider (nobody at gmail.com is a colleague of
 * everybody else at gmail.com).
 */
export function teamDomainForEmail(email: string | null | undefined): string | null {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".") || /[\s/]/.test(domain)) return null;
  if (publicEmailDomain(domain)) return null;
  return domain;
}

/** Second-level labels that are a registry, not a company: `acme.co.uk` is Acme. */
const GENERIC_SECOND_LEVELS = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** A display name for a team, from its domain: `eu.acme.com` → "Acme". */
export function teamNameForDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  let label = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? domain);
  if (parts.length >= 3 && GENERIC_SECOND_LEVELS.has(label)) label = parts[parts.length - 3];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * How a teammate is named in a lookup result. Accounts that predate the Clerk mirror have
 * null first/last names in `user_settings` (see the `firstName` comment in schema.ts), so
 * the mailbox name is the fallback, and a neutral word after that.
 */
export function teammateDisplayName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const full = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;
  const mailbox = row.email?.split("@")[0]?.trim();
  return mailbox || "A teammate";
}
```

- [ ] **Step 4: Run the smoke and the manifest check**

Run: `npx tsx scripts/smoke-warm-path.ts && npx tsx scripts/run-smoke.ts --check`
Expected: every line `ok`, "All warm-path checks passed.", manifest ok.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team-domain.ts scripts/smoke-warm-path.ts scripts/run-smoke.ts
git commit -m "Add the pure team-domain rules: which emails form a team, and how teammates are named

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The `leads` purge category

**Files:**
- Modify: `src/lib/data-categories.ts` (union ~line 15-31; META after the `imports` entry ~line 72; ORDER comment ~line 9-13)
- Modify: `src/lib/user-data.ts` (imports ~line 9-80; `STEPS` after `imports` step)
- Modify: `scripts/smoke-purge.ts` (`seed()`, before its `return` at ~line 640)
- Modify: `scripts/smoke-purge-selective.ts:204` (`WITNESS`)

**Interfaces:**
- Consumes: `teams`, `teamMembers` from `@/db/schema`; `TEAM_DELETED_CREATOR` from `@/lib/team-domain`.
- Produces: `DataCategory` includes `"leads"`.

- [ ] **Step 1: Run the purge smoke to see it fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-purge`
Expected: FAIL — `team_members` is user-scoped and has no row to delete (the derived scan demands a seed) and/or no step purges it.

- [ ] **Step 2: Add the category**

In `src/lib/data-categories.ts`, in the `DataCategory` union insert `| "leads"` directly after `| "imports"`. In `DATA_CATEGORY_META`, directly after the `imports` entry add:

```ts
  {
    id: "leads",
    label: "Leads and team",
    description:
      "Your place on your company's team. Teammates stop seeing whether you know the people they look up, and the team itself is removed once nobody is left in it.",
  },
```

Extend the ORDER comment's list with: `` `leads` before `connections` and `contacts` (its later tables point at both with set-null keys) ``.

In `src/lib/user-data.ts` add to the schema import list `teams,` and `teamMembers,`, add `import { TEAM_DELETED_CREATOR } from "@/lib/team-domain";`, and in `STEPS` directly after the `imports` step add:

```ts
  leads: {
    exports: [own(teamMembers)],
    counts: [teamMembers],
    run: async (db, userId) => {
      const memberships = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId));
      await db.delete(teamMembers).where(eq(teamMembers.userId, userId));
      // The team row is shared: a creator's account can go while the team stays. Same
      // sentinel as recruiters, for the same reason — never null, never a dangling id.
      await db
        .update(teams)
        .set({ createdBy: TEAM_DELETED_CREATOR, updatedAt: new Date() })
        .where(eq(teams.createdBy, userId));
      // A team nobody is on any more is not a team. Literal identifiers on purpose: a
      // column interpolated into sql`` here would render unqualified.
      for (const { teamId } of memberships) {
        await db
          .delete(teams)
          .where(
            and(
              eq(teams.id, teamId),
              sql`not exists (select 1 from team_members tm where tm.team_id = teams.id)`
            )
          );
      }
    },
  },
```

- [ ] **Step 3: Seed the smokes**

In `scripts/smoke-purge.ts` `seed()`, before its `return`, add (add `sql` to the file's `drizzle-orm` import if absent):

```ts
  const [team] = await db
    .insert(schema.teams)
    .values({ domain: "smoke-purge.test", name: "Smoke Purge", createdBy: USER })
    .onConflictDoUpdate({ target: schema.teams.domain, set: { domain: sql`excluded.domain` } })
    .returning();
  await db.insert(schema.teamMembers).values({
    teamId: team.id,
    userId: USER,
    shareNetwork: 1,
    emailDomain: "smoke-purge.test",
  });
```

After the smoke's "nothing leaks" assertions, add one more with the file's `check` helper:

```ts
  const teamsLeft = await db
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(eq(schema.teams.domain, "smoke-purge.test"));
  check("an emptied team is removed with its last member", teamsLeft.length === 0);
```

In `scripts/smoke-purge-selective.ts` `WITNESS`, after `imports: "imports",` add `leads: "team_members",`.

- [ ] **Step 4: Run the purge smokes**

Run: `npx tsx scripts/run-smoke.ts --only smoke-purge smoke-purge-selective`
Expected: both `ok`. If `smoke-purge-selective` reports the `leads` witness as unseeded, add to its `seed()` the same two inserts as above with its own user constant.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/lib/data-categories.ts src/lib/user-data.ts scripts/smoke-purge.ts scripts/smoke-purge-selective.ts
git commit -m "Purge a person's team membership, and the team once it is empty

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Close a coming-soon page's actions

**Files:**
- Modify: `src/lib/surface-visibility.ts` (after `requireVisibleSurface`, ~line 203)
- Modify: `src/lib/plan-guards.ts` (append)
- Modify: `scripts/smoke-surface-visibility.ts` (imports ~line 18-23; a new section after the block that ends ~line 195)

**Interfaces:**
- Produces: `requireReleasedSurface(userId, surfaceKey): Promise<void>`; `requireLeadsUser(): Promise<string>`.

- [ ] **Step 1: Write the failing check**

In `scripts/smoke-surface-visibility.ts`, add `requireReleasedSurface,` to the `../src/lib/surface-visibility` import, `isSurfaceHiddenError` too if not already imported, and after the existing section that calls `requireVisibleSurface(USER, "page.dashboard")` add:

```ts
  console.log("\ncoming-soon closes actions, not just pages");
  {
    let thrown: unknown = null;
    try {
      await requireReleasedSurface(USER, "page.leads");
    } catch (err) {
      thrown = err;
    }
    check("a coming-soon surface refuses its actions", isSurfaceHiddenError(thrown));
    // The older guard deliberately ignores comingSoon; pinned so the difference is a fact.
    let older: unknown = null;
    try {
      await requireVisibleSurface(USER, "page.leads");
    } catch (err) {
      older = err;
    }
    check("while requireVisibleSurface still lets them through", older === null);
    let always: unknown = null;
    try {
      await requireReleasedSurface(USER, "page.dashboard");
    } catch (err) {
      always = err;
    }
    check("an always-visible surface is never refused", always === null);
  }
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-surface-visibility`
Expected: FAIL — `requireReleasedSurface` is not exported.

- [ ] **Step 3: Add the guards**

In `src/lib/surface-visibility.ts`, after `requireVisibleSurface`:

```ts
/**
 * Throws `SurfaceHiddenError` unless `surfaceKey` is both switched on and released for
 * this viewer. `requireVisibleSurface` ignores `comingSoon` on purpose — the pages that use
 * it predate the flag — but a page that ships closed must close its actions too: a Server
 * Function answers a direct POST whether or not the nav shows the page.
 */
export async function requireReleasedSurface(userId: string, surfaceKey: string) {
  if (isAlwaysVisible(surfaceKey)) return;
  const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
  if (hidden.has(surfaceKey) || comingSoon.has(surfaceKey)) {
    throw new SurfaceHiddenError(surfaceKey);
  }
}
```

In `src/lib/plan-guards.ts`, add `requireReleasedSurface` to the import and append:

```ts
/**
 * Auth plus "Leads is switched on and released". No plan gate: joining a team and looking
 * up warm paths are free (the CRM connection is the paid part, gated separately later).
 */
export async function requireLeadsUser() {
  const userId = await requireUserId();
  await requireReleasedSurface(userId, "page.leads");
  return userId;
}
```

- [ ] **Step 4: Run the smoke**

Run: `npx tsx scripts/run-smoke.ts --only smoke-surface-visibility`
Expected: `ok`, including the three new lines.

- [ ] **Step 5: Commit**

```bash
git add src/lib/surface-visibility.ts src/lib/plan-guards.ts scripts/smoke-surface-visibility.ts
git commit -m "Refuse a coming-soon page's actions the way its page is refused

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Team lifecycle

**Files:**
- Create: `src/lib/teams.ts`
- Create: `scripts/smoke-team-lifecycle.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pglite section)

**Interfaces:**
- Consumes: `teams`, `teamMembers`, `contacts`, `userSettings` from `@/db/schema`; `teamDomainForEmail`, `teamNameForDomain`, `teammateDisplayName` from `@/lib/team-domain`; `isDemoMode` from `@/lib/demo-account`; `UserFacingError` from `@/lib/errors`; `currentUser` from `@clerk/nextjs/server`.
- Produces:
  - `type TeamMembership = { teamId: string; domain: string; name: string; shareNetwork: boolean; joinedAt: Date }`
  - `getViewerTeam(userId): Promise<TeamMembership | null>` (request-cached)
  - `verifiedWorkEmail(): Promise<string | null>` (request context only)
  - `type TeamEligibility` (below); `eligibleTeamForUser(userId): Promise<TeamEligibility>`
  - `joinTeamWithDomain(userId, domain, { shareNetwork }): Promise<{ teamId: string; memberCount: number }>`
  - `joinTeam(userId, { shareNetwork })`, `leaveTeam(userId)`, `setTeamSharing(userId, on): Promise<boolean>`, `setContactTeamShared(userId, contactId, shared): Promise<boolean>`
  - `type TeamMemberRow = { userId; name; email: string | null; sharing: boolean; joinedAt: Date }`; `listTeamMembers(teamId)`

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-team-lifecycle.ts`:

```ts
/**
 * Joining, leaving and sharing on a team, against a real database.
 *
 * Every assertion is either a race (two colleagues joining a brand-new domain at once must
 * land on ONE team) or a boundary (a member cannot touch another member's contacts; a
 * non-member cannot flip sharing). Rows live under `smoke-team-*` ids and go in `finally`.
 * Do NOT run while `next dev` holds `.data/pglite` — PGlite is single-writer.
 *
 * Run: npx tsx scripts/smoke-team-lifecycle.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, teamMembers, teams, userSettings } from "../src/db/schema";
import { isUserFacingError } from "../src/lib/errors";
import {
  getViewerTeam,
  joinTeamWithDomain,
  leaveTeam,
  listTeamMembers,
  setContactTeamShared,
  setTeamSharing,
} from "../src/lib/teams";
import { ensureUserSettings } from "../src/lib/user-settings";

const A = "smoke-team-a";
const B = "smoke-team-b";
const C = "smoke-team-c";
const USERS = [A, B, C];
const DOMAIN = "smoke-team.test";
const OTHER = "other-smoke-team.test";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(teamMembers).where(inArray(teamMembers.userId, USERS));
  await db.delete(teams).where(inArray(teams.domain, [DOMAIN, OTHER]));
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function teamsWithDomain(domain: string) {
  const db = await getDb();
  return db.select({ id: teams.id, createdBy: teams.createdBy }).from(teams).where(eq(teams.domain, domain));
}

async function main() {
  const db = await getDb();
  await cleanup();
  try {
    for (const u of USERS) await ensureUserSettings(u);
    await db.update(userSettings).set({ firstName: "Alex", lastName: "Ng" }).where(eq(userSettings.userId, A));

    console.log("\ntwo colleagues join a new domain at once");
    const [ra, rb] = await Promise.all([
      joinTeamWithDomain(A, DOMAIN, { shareNetwork: true }),
      joinTeamWithDomain(B, DOMAIN, { shareNetwork: false }),
    ]);
    check("both land on the same team", ra.teamId === rb.teamId, `${ra.teamId} vs ${rb.teamId}`);
    check("exactly one team row exists", (await teamsWithDomain(DOMAIN)).length === 1);
    const a = await getViewerTeam(A);
    const b = await getViewerTeam(B);
    check("A is a sharing member", a?.shareNetwork === true && a.domain === DOMAIN);
    check("B joined without sharing", b?.shareNetwork === false);
    check("the team is named from its domain", a?.name === "Smoke-team");

    console.log("\nrejoining is idempotent and re-states the sharing choice");
    const again = await joinTeamWithDomain(A, DOMAIN, { shareNetwork: false });
    check("same team id", again.teamId === ra.teamId);
    check("membership count unchanged", again.memberCount === 2, String(again.memberCount));
    check("sharing now off", (await getViewerTeam(A))?.shareNetwork === false);
    check("and can be switched back", (await setTeamSharing(A, true)) === true && (await getViewerTeam(A))?.shareNetwork === true);
    check("a non-member cannot flip sharing", (await setTeamSharing(C, true)) === false);

    console.log("\none team per person");
    let refused: unknown = null;
    try {
      await joinTeamWithDomain(A, OTHER, { shareNetwork: true });
    } catch (err) {
      refused = err;
    }
    check("joining a second domain is refused with a readable message", isUserFacingError(refused));
    check("and no second team was created", (await teamsWithDomain(OTHER)).length === 0);

    console.log("\nthe per-contact opt-out is the owner's alone");
    const [contact] = await db
      .insert(contacts)
      .values({ userId: A, fullName: "Ada Lovelace" })
      .returning({ id: contacts.id, teamShared: contacts.teamShared });
    check("a new contact is shared by default", contact.teamShared === 1);
    check("another member cannot hide it", (await setContactTeamShared(B, contact.id, false)) === false);
    const [still] = await db.select({ teamShared: contacts.teamShared }).from(contacts).where(eq(contacts.id, contact.id));
    check("so it stays shared", still.teamShared === 1);
    check("its owner can", (await setContactTeamShared(A, contact.id, false)) === true);
    const [hidden] = await db.select({ teamShared: contacts.teamShared }).from(contacts).where(eq(contacts.id, contact.id));
    check("and then it is hidden", hidden.teamShared === 0);

    console.log("\nmembers are listed by name, with the sharing flag");
    const members = await listTeamMembers(ra.teamId);
    const alex = members.find((m) => m.userId === A);
    const bee = members.find((m) => m.userId === B);
    check("two members", members.length === 2, String(members.length));
    check("names come from the settings mirror", alex?.name === "Alex Ng", alex?.name);
    check("a nameless account falls back", bee?.name === "A teammate", bee?.name);
    check("the sharing flag is carried", alex?.sharing === true && bee?.sharing === false);

    console.log("\nleaving");
    await leaveTeam(B);
    check("the team survives while a member remains", (await teamsWithDomain(DOMAIN)).length === 1);
    check("B is no longer a member", (await getViewerTeam(B)) === null);
    await leaveTeam(A);
    check("the last member takes the team with them", (await teamsWithDomain(DOMAIN)).length === 0);
    check("leaving twice is harmless", (await leaveTeam(A), true));
    const [orphan] = await db.select({ teamShared: contacts.teamShared }).from(contacts).where(eq(contacts.id, contact.id));
    check("the per-contact choice survives leaving", orphan.teamShared === 0);
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll team lifecycle checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

Register it: in `scripts/run-smoke.ts` pglite section, next to `"smoke-recruiter-sharing"`, add `"smoke-team-lifecycle": "pglite",`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/smoke-team-lifecycle.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/teams'`.

- [ ] **Step 3: Write the module**

Create `src/lib/teams.ts`:

```ts
/**
 * Team lifecycle: who may join which team, joining, leaving, and the two sharing switches.
 *
 * A team is a verified email domain (`src/lib/team-domain.ts`). The verification itself is
 * Clerk's, read from the request in `verifiedWorkEmail`; everything below that takes the
 * proven domain as a plain argument, which is what makes it testable against PGlite and is
 * why `joinTeam` is two functions.
 *
 * Sharing is reciprocal and read live: `share_network` is a column the warm-path SQL joins
 * on every time, never a cached count, so switching it off withdraws a person's contacts
 * from every lookup immediately (the recruiters-pool rule, and for the same reason).
 */
import { cache } from "react";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { getDb } from "@/db";
import { contacts, teamMembers, teams, userSettings } from "@/db/schema";
import { isDemoMode } from "@/lib/demo-account";
import { UserFacingError } from "@/lib/errors";
import { teamDomainForEmail, teamNameForDomain, teammateDisplayName } from "@/lib/team-domain";

export type TeamMembership = {
  teamId: string;
  domain: string;
  name: string;
  shareNetwork: boolean;
  joinedAt: Date;
};

/** The viewer's team, or null. Request-cached: every warm-path query starts here. */
export const getViewerTeam = cache(async (userId: string): Promise<TeamMembership | null> => {
  const db = await getDb();
  const [row] = await db
    .select({
      teamId: teams.id,
      domain: teams.domain,
      name: teams.name,
      shareNetwork: teamMembers.shareNetwork,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  return row ? { ...row, shareNetwork: row.shareNetwork === 1 } : null;
});

/**
 * The signed-in person's primary email, only when Clerk has verified it. Request context
 * only (it is Clerk's backend read), so never call it from a job. Demo mode has no Clerk
 * and answers with the demo account's address.
 */
export async function verifiedWorkEmail(): Promise<string | null> {
  if (isDemoMode()) return "demo@orbit.local";
  const user = await currentUser().catch(() => null);
  const primary = user?.primaryEmailAddress;
  if (!primary || primary.verification?.status !== "verified") return null;
  return primary.emailAddress.trim().toLowerCase();
}

export type TeamEligibility =
  | { kind: "member"; membership: TeamMembership }
  | {
      kind: "eligible";
      domain: string;
      name: string;
      existing: { id: string; name: string; memberCount: number } | null;
    }
  | { kind: "ineligible"; reason: "no_verified_email" | "public_domain" };

async function describeTeam(domain: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: teams.id, name: teams.name, memberCount: count(teamMembers.id) })
    .from(teams)
    .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(eq(teams.domain, domain))
    .groupBy(teams.id, teams.name);
  return row ? { id: row.id, name: row.name, memberCount: Number(row.memberCount) } : null;
}

/** Members never pay the Clerk round trip; only a would-be joiner is verified. */
export async function eligibleTeamForUser(userId: string): Promise<TeamEligibility> {
  const membership = await getViewerTeam(userId);
  if (membership) return { kind: "member", membership };
  const email = await verifiedWorkEmail();
  if (!email) return { kind: "ineligible", reason: "no_verified_email" };
  const domain = teamDomainForEmail(email);
  if (!domain) return { kind: "ineligible", reason: "public_domain" };
  return { kind: "eligible", domain, name: teamNameForDomain(domain), existing: await describeTeam(domain) };
}

async function memberCountOf(teamId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: count(teamMembers.id) })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return Number(row?.n ?? 0);
}

/**
 * The write half of joining, with the domain already proven by the caller. Race-safe the
 * way `resolveCompany` is: the team insert is `ON CONFLICT DO UPDATE` with a no-op set so
 * `RETURNING` always yields the winner, and two colleagues joining a brand-new domain at
 * once land on one row. Rejoining restates the sharing choice; joining a second domain is
 * refused because a person has one verified primary email.
 */
export async function joinTeamWithDomain(
  userId: string,
  domain: string,
  opts: { shareNetwork: boolean }
): Promise<{ teamId: string; memberCount: number }> {
  const db = await getDb();
  const [current] = await db
    .select({ domain: teams.domain })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  if (current && current.domain !== domain) {
    throw new UserFacingError("You're already on another team. Leave it first.");
  }
  const [team] = await db
    .insert(teams)
    .values({ domain, name: teamNameForDomain(domain), createdBy: userId })
    .onConflictDoUpdate({ target: teams.domain, set: { domain: sql`excluded.domain` } })
    .returning({ id: teams.id });
  const shareNetwork = opts.shareNetwork ? 1 : 0;
  await db
    .insert(teamMembers)
    .values({ teamId: team.id, userId, shareNetwork, emailDomain: domain })
    .onConflictDoUpdate({
      target: teamMembers.userId,
      set: { shareNetwork, emailDomain: domain, updatedAt: new Date() },
    });
  return { teamId: team.id, memberCount: await memberCountOf(team.id) };
}

/** Join the team of the signed-in person's verified work email. */
export async function joinTeam(
  userId: string,
  opts: { shareNetwork: boolean }
): Promise<{ teamId: string; memberCount: number }> {
  const email = await verifiedWorkEmail();
  const domain = email ? teamDomainForEmail(email) : null;
  if (!domain) {
    throw new UserFacingError(
      "Teams are keyed by a verified work email. Add one in your account settings first."
    );
  }
  return joinTeamWithDomain(userId, domain, opts);
}

/** Leave; a team nobody is on any more is deleted. Per-contact `team_shared` values stay. */
export async function leaveTeam(userId: string): Promise<void> {
  const db = await getDb();
  const [gone] = await db
    .delete(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .returning({ teamId: teamMembers.teamId });
  if (!gone) return;
  await db
    .delete(teams)
    .where(
      and(
        eq(teams.id, gone.teamId),
        sql`not exists (select 1 from team_members tm where tm.team_id = teams.id)`
      )
    );
}

/** The per-team switch. False when the person is not on a team. */
export async function setTeamSharing(userId: string, on: boolean): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(teamMembers)
    .set({ shareNetwork: on ? 1 : 0, updatedAt: new Date() })
    .where(eq(teamMembers.userId, userId))
    .returning({ id: teamMembers.id });
  return rows.length > 0;
}

/** The per-contact exception. False when the contact is not this person's. */
export async function setContactTeamShared(
  userId: string,
  contactId: string,
  shared: boolean
): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(contacts)
    .set({ teamShared: shared ? 1 : 0, updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .returning({ id: contacts.id });
  return rows.length > 0;
}

export type TeamMemberRow = {
  userId: string;
  name: string;
  /** The mirrored work address, shown only to teammates (they share the domain). */
  email: string | null;
  sharing: boolean;
  joinedAt: Date;
};

export async function listTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      userId: teamMembers.userId,
      firstName: userSettings.firstName,
      lastName: userSettings.lastName,
      email: userSettings.email,
      shareNetwork: teamMembers.shareNetwork,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .leftJoin(userSettings, eq(userSettings.userId, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(teamMembers.joinedAt));
  return rows.map((r) => ({
    userId: r.userId,
    name: teammateDisplayName({ firstName: r.firstName, lastName: r.lastName, email: r.email }),
    email: r.email,
    sharing: r.shareNetwork === 1,
    joinedAt: r.joinedAt,
  }));
}
```

Note: `ensureUserSettings` in the smoke may leave `email` null for these synthetic users, which is what the "nameless account falls back" check relies on ("A teammate"). If `ensureUserSettings` writes an email for them, set `email: null` explicitly in the smoke with `db.update(userSettings)`.

- [ ] **Step 4: Run the smoke and the manifest check**

Run: `npx tsx scripts/smoke-team-lifecycle.ts && npx tsx scripts/run-smoke.ts --check`
Expected: every line `ok`, "All team lifecycle checks passed."

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npx tsc --noEmit && npx eslint src/lib/teams.ts scripts/smoke-team-lifecycle.ts`

```bash
git add src/lib/teams.ts scripts/smoke-team-lifecycle.ts scripts/run-smoke.ts
git commit -m "Add the team lifecycle: join by verified domain, leave, and the two sharing switches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Warm-path types, the ladder, and target parsing (pure)

**Files:**
- Create: `src/lib/leads/warm-path.ts`
- Create: `src/lib/leads/target-input.ts`
- Modify: `scripts/smoke-warm-path.ts` (new sections)

**Interfaces:**
- Consumes: `linkedinSlug`, `normalizePhone`, `normalizeXHandle` from `@/lib/duplicates`; `displayCompanyName`, `normalizeCompanyName` from `@/lib/company-name`.
- Produces: the types below; `rankWarmth(direct, account): Warmth`; `identityPairs(target): Array<{ kind: IdentityKind; value: string }>`; `parseTargetInput(raw): ParsedTarget`.

- [ ] **Step 1: Write the failing checks**

Add to `scripts/smoke-warm-path.ts` imports:

```ts
import { identityPairs, rankWarmth } from "../src/lib/leads/warm-path";
import { parseTargetInput } from "../src/lib/leads/target-input";
import { linkedinSlug, normalizePhone } from "../src/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "../src/lib/company-name";
```

and, before the client-bundle section, these sections:

```ts
  console.log("\nthe warmth ladder");
  {
    const t = (tier: "inner" | "mid" | "outer") => ({ tier });
    check("an inner-circle path is hot", rankWarmth([t("inner"), t("outer")], []) === "hot");
    check("one mid path is warm", rankWarmth([t("mid")], []) === "warm");
    check("two outer paths are warm", rankWarmth([t("outer"), t("outer")], []) === "warm");
    check("one outer path is cool", rankWarmth([t("outer")], []) === "cool");
    check("an account path alone is cool", rankWarmth([], [{}]) === "cool");
    check("nothing is cold", rankWarmth([], []) === "cold");
    const pairs = identityPairs({ email: "a@x.io", linkedinSlug: "ada", phoneE164: null, xHandle: undefined });
    check("identity pairs skip the blanks", pairs.length === 2 && pairs.every((p) => p.value));
  }

  console.log("\ntarget parsing");
  {
    const email = parseTargetInput("  Ada@Example.com ");
    check("an address is an email, lower-cased", email.kind === "email" && email.email === "ada@example.com");
    const li = parseTargetInput("https://www.linkedin.com/in/Ada-Lovelace/?trk=x");
    check("a profile URL is a slug", li.kind === "linkedin" && li.linkedinSlug === linkedinSlug("https://www.linkedin.com/in/Ada-Lovelace/"));
    const phone = parseTargetInput("+1 (415) 555-0123");
    check("a phone is E.164", phone.kind === "phone" && phone.phoneE164 === normalizePhone("+1 (415) 555-0123") && !!phone.phoneE164);
    const x = parseTargetInput("@adalovelace");
    check("a handle is an X handle", x.kind === "x" && !!x.xHandle);
    const both = parseTargetInput("Ada Lovelace, Analytical Engines Ltd");
    check(
      "\"Name, Company\" splits into a name and a company key",
      both.kind === "name_company" &&
        both.displayName === "Ada Lovelace" &&
        both.companyNormalized === normalizeCompanyName(displayCompanyName("Analytical Engines Ltd"))
    );
    const name = parseTargetInput("Ada Lovelace");
    check("a bare name carries no identity", name.kind === "name" && identityPairs(name).length === 0);
    check("blank is empty", parseTargetInput("   ").kind === "empty");
  }
```

Add `"src/lib/leads/warm-path.ts", "src/lib/leads/target-input.ts"` to the client-bundle file list.

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/leads/warm-path'`.

- [ ] **Step 3: Write the two modules**

Create `src/lib/leads/warm-path.ts`:

```ts
/**
 * The vocabulary of a warm-path lookup, and the one rule that turns paths into a word.
 * Pure and client-safe: chips and cards import from here.
 */
import type { ClosenessTier } from "@/db/schema";
import type { IdentityKind } from "@/lib/duplicates";

/** A person to look up, described by the identifiers `contact_identities` matches on. */
export type TargetIdentity = {
  email?: string | null;
  linkedinSlug?: string | null;
  phoneE164?: string | null;
  xHandle?: string | null;
  /** `companies.name_normalized` form, for "who knows anyone at this company". */
  companyNormalized?: string | null;
};

export type Teammate = { userId: string; name: string; email: string | null };

/** A teammate knows the target directly. Deliberately no contact id: it is another tenant's. */
export type DirectPath = {
  teammate: Teammate;
  tier: ClosenessTier;
  closeness: number | null;
  matchedOn: IdentityKind;
};

/** A teammate knows people at the target's company. */
export type AccountPath = { teammate: Teammate; count: number; bestTier: ClosenessTier };

export type Warmth = "hot" | "warm" | "cool" | "cold";

export type WarmPath = { warmth: Warmth; direct: DirectPath[]; account: AccountPath[] };

export type WarmPathLookup =
  | { status: "no_team" }
  | { status: "not_sharing" }
  | { status: "ok"; path: WarmPath };

export const TIER_RANK: Record<ClosenessTier, number> = { inner: 0, mid: 1, outer: 2 };
export const WARMTH_RANK: Record<Warmth, number> = { hot: 0, warm: 1, cool: 2, cold: 3 };

/**
 * hot = someone close knows them; warm = a real acquaintance, or two loose ones; cool = one
 * loose one, or only a way into the company; cold = nothing.
 */
export function rankWarmth(
  direct: ReadonlyArray<{ tier: ClosenessTier }>,
  account: ReadonlyArray<unknown>
): Warmth {
  const n = (tier: ClosenessTier) => direct.filter((d) => d.tier === tier).length;
  if (n("inner") >= 1) return "hot";
  if (n("mid") >= 1 || n("outer") >= 2) return "warm";
  if (n("outer") === 1 || account.length > 0) return "cool";
  return "cold";
}

/** The `(kind, value)` probes a target contributes, blanks dropped. */
export function identityPairs(target: TargetIdentity): Array<{ kind: IdentityKind; value: string }> {
  const pairs: Array<{ kind: IdentityKind; value: string }> = [];
  if (target.email) pairs.push({ kind: "email", value: target.email });
  if (target.linkedinSlug) pairs.push({ kind: "linkedin_slug", value: target.linkedinSlug });
  if (target.phoneE164) pairs.push({ kind: "phone_e164", value: target.phoneE164 });
  if (target.xHandle) pairs.push({ kind: "x_handle", value: target.xHandle });
  return pairs;
}
```

Create `src/lib/leads/target-input.ts`:

```ts
/**
 * One search box, several kinds of input. Turns what a person pastes into the identifiers
 * the who-knows-whom lookup can match — with the SAME normalisers `identityKeysFor` uses to
 * write `contact_identities`, or the equality probe would miss. Pure and client-safe.
 */
import { linkedinSlug, normalizePhone, normalizeXHandle } from "@/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";
import type { TargetIdentity } from "./warm-path";

export type ParsedTarget = TargetIdentity & {
  displayName: string | null;
  kind: "email" | "linkedin" | "phone" | "x" | "name_company" | "name" | "empty";
};

const EMPTY: ParsedTarget = { displayName: null, kind: "empty" };

export function parseTargetInput(raw: string): ParsedTarget {
  const s = raw.trim();
  if (!s) return EMPTY;
  if (/linkedin\.com\/in\//i.test(s)) {
    const slug = linkedinSlug(s);
    return slug ? { linkedinSlug: slug, displayName: null, kind: "linkedin" } : EMPTY;
  }
  if (s.includes("@") && !s.startsWith("@") && !/\s/.test(s)) {
    return { email: s.toLowerCase(), displayName: null, kind: "email" };
  }
  if (s.startsWith("@") && !/\s/.test(s)) {
    const handle = normalizeXHandle(s);
    return handle ? { xHandle: handle, displayName: null, kind: "x" } : EMPTY;
  }
  const digits = s.replace(/[\s().-]/g, "");
  if (/^\+?\d{7,15}$/.test(digits)) {
    const phone = normalizePhone(s);
    return phone ? { phoneE164: phone, displayName: null, kind: "phone" } : EMPTY;
  }
  const comma = s.indexOf(",");
  if (comma > 0) {
    const name = s.slice(0, comma).trim();
    const company = s.slice(comma + 1).trim();
    return {
      displayName: name || null,
      companyNormalized: company ? normalizeCompanyName(displayCompanyName(company)) : null,
      kind: "name_company",
    };
  }
  return { displayName: s, kind: "name" };
}
```

- [ ] **Step 4: Run the smoke**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/warm-path.ts src/lib/leads/target-input.ts scripts/smoke-warm-path.ts
git commit -m "Add the warm-path vocabulary, the warmth ladder, and target parsing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The SQL builders, guarded as text

**Files:**
- Create: `src/lib/leads/warm-path-sql.ts`
- Modify: `scripts/smoke-warm-path.ts` (new section)

**Interfaces:**
- Produces: `type IdentityTarget = { key: string; kind: IdentityKind; value: string }`, `type CompanyTarget = { key: string; company: string }`, `directPathsStatement(teamId, viewerUserId, targets: IdentityTarget[]): SQL`, `accountPathsStatement(teamId, viewerUserId, targets: CompanyTarget[]): SQL`. Row shapes: direct → `target_key, user_id, first_name, last_name, email, tier, closeness, matched_on`; account → `target_key, user_id, first_name, last_name, email, count, best_rank`.

- [ ] **Step 1: Write the failing guard**

Add to `scripts/smoke-warm-path.ts` imports `import { accountPathsStatement, directPathsStatement } from "../src/lib/leads/warm-path-sql";` and, before the client-bundle section:

```ts
  console.log("\nthe SQL is the privacy boundary");
  {
    const direct = dialect.sqlToQuery(
      directPathsStatement("team-1", "viewer-1", [
        { key: "k1", kind: "email", value: "ada@x.io" },
        { key: "k1", kind: "linkedin_slug", value: "ada" },
      ])
    );
    const account = dialect.sqlToQuery(
      accountPathsStatement("team-1", "viewer-1", [{ key: "k1", company: "acme" }])
    );
    for (const [label, q] of [["direct", direct], ["account", account]] as const) {
      const text = q.sql;
      check(`${label}: only sharing teammates`, /share_network\s*=\s*1/.test(text));
      check(`${label}: only shared contacts`, /team_shared\s*=\s*1/.test(text));
      check(`${label}: never the viewer`, /tm\.user_id\s*<>\s*\$\d+/.test(text));
      check(`${label}: every contact join is tenant-scoped`, /c\.user_id\s*=\s*(ci|co)\.user_id/.test(text));
      check(`${label}: no correlated exists`, !/exists\s*\(/i.test(text));
      const forbidden = /\bnotes\b|ai_summary|key_facts|\bc\.email\b|\bc\.phone\b|linkedin_url|\bc\.full_name\b/;
      check(`${label}: names no private column`, !forbidden.test(text), text.match(forbidden)?.[0]);
      check(`${label}: binds its inputs`, q.params.length >= 3);
    }
    check("direct paths collapse to one row per teammate", /distinct on \(t\.target_key, m\.user_id\)/.test(direct.sql));
    check("account paths group per teammate", /group by t\.target_key, m\.user_id/.test(account.sql));
  }
```

Add `"src/lib/leads/warm-path-sql.ts"` to the client-bundle file list.

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/leads/warm-path-sql'`.

- [ ] **Step 3: Write the builders**

Create `src/lib/leads/warm-path-sql.ts`:

```ts
/**
 * The who-knows-whom statements, as pure builders.
 *
 * These are raw statements on purpose. The rules they must keep are structural — every
 * join carries a tenant equality, the sharing switches are WHERE terms rather than a JS
 * filter, no correlated EXISTS (the hashed-SubPlan rewrite once stripped tenant scoping
 * from one), and the SELECT list is the whole privacy boundary — and a drizzle query
 * builder cannot hold a column interpolated into a projection qualified. Built without a
 * database so `scripts/smoke-warm-path.ts` can render them and grep for the columns that
 * must never appear.
 *
 * Reciprocity is decided by the CALLER before either runs: a viewer who is not sharing
 * never reaches these.
 */
import { sql, type SQL } from "drizzle-orm";
import type { IdentityKind } from "@/lib/duplicates";

export type IdentityTarget = { key: string; kind: IdentityKind; value: string };
export type CompanyTarget = { key: string; company: string };

/** The teammates whose networks are open to the viewer: same team, sharing, not the viewer. */
function mateCte(teamId: string, viewerUserId: string): SQL {
  return sql`mate as (
    select tm.user_id, us.first_name, us.last_name, us.email
    from team_members tm
    join user_settings us on us.user_id = tm.user_id
    where tm.team_id = ${teamId} and tm.share_network = 1 and tm.user_id <> ${viewerUserId})`;
}

const TIER_CASE = sql`case coalesce(c.closeness_tier, 'outer') when 'inner' then 0 when 'mid' then 1 else 2 end`;

/** Teammates who know a target directly: one row per (target, teammate), best contact first. */
export function directPathsStatement(
  teamId: string,
  viewerUserId: string,
  targets: IdentityTarget[]
): SQL {
  const values = sql.join(
    targets.map((t) => sql`(${t.key}::text, ${t.kind}::text, ${t.value}::text)`),
    sql`, `
  );
  return sql`with target(target_key, kind, value) as (values ${values}),
${mateCte(teamId, viewerUserId)}
select distinct on (t.target_key, m.user_id)
  t.target_key, m.user_id, m.first_name, m.last_name, m.email,
  coalesce(c.closeness_tier, 'outer') as tier, c.closeness, t.kind as matched_on
from target t
join contact_identities ci on ci.kind = t.kind and ci.value = t.value
join mate m on m.user_id = ci.user_id
join contacts c on c.id = ci.contact_id and c.user_id = ci.user_id and c.team_shared = 1
order by t.target_key, m.user_id, ${TIER_CASE}, c.closeness desc nulls last`;
}

/** Teammates who know anyone at a target's company: a count and the best tier, per teammate. */
export function accountPathsStatement(
  teamId: string,
  viewerUserId: string,
  targets: CompanyTarget[]
): SQL {
  const values = sql.join(
    targets.map((t) => sql`(${t.key}::text, ${t.company}::text)`),
    sql`, `
  );
  return sql`with target(target_key, company) as (values ${values}),
${mateCte(teamId, viewerUserId)}
select t.target_key, m.user_id, m.first_name, m.last_name, m.email,
  count(*)::int as count, min(${TIER_CASE})::int as best_rank
from target t
join mate m on true
join companies co on co.user_id = m.user_id and co.name_normalized = t.company
join contacts c on c.company_id = co.id and c.user_id = co.user_id and c.team_shared = 1
group by t.target_key, m.user_id, m.first_name, m.last_name, m.email`;
}
```

- [ ] **Step 4: Run the smoke**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: all `ok`. If `PgDialect` is not exported from `drizzle-orm/pg-core`, import it from `drizzle-orm/pg-core/dialect` instead.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/warm-path-sql.ts scripts/smoke-warm-path.ts
git commit -m "Build the who-knows-whom statements as pure SQL, guarded as text

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The query, against seeded teammates

**Files:**
- Create: `src/lib/leads/warm-path-query.ts`
- Create: `scripts/smoke-warm-paths.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pglite section)

**Interfaces:**
- Consumes: `getDb`, `rowsOf` from `@/db`; `getViewerTeam` from `@/lib/teams`; `teammateDisplayName` from `@/lib/team-domain`; the builders from Task 7; the types and `rankWarmth`, `identityPairs`, `TIER_RANK` from Task 6.
- Produces: `type KeyedTarget = TargetIdentity & { key: string }`; `warmPathsForTargets(viewerUserId, targets): Promise<{ status: "no_team" | "not_sharing" } | { status: "ok"; paths: Map<string, WarmPath> }>`; `findWarmPaths(viewerUserId, target): Promise<WarmPathLookup>`.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-warm-paths.ts`:

```ts
/**
 * The who-knows-whom lookup against a real database: what a sharing viewer learns, and —
 * every other line here — what they do not. A non-sharing viewer sees nothing; a
 * non-sharing teammate contributes nothing; a contact marked private is invisible; another
 * team is another world; the viewer's own contacts never come back as a path.
 *
 * Rows live under `smoke-warm-*` ids and are removed in `finally`. Do NOT run while
 * `next dev` holds `.data/pglite` — PGlite is single-writer.
 *
 * Run: npx tsx scripts/smoke-warm-paths.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, teamMembers, teams, userSettings } from "../src/db/schema";
import type { ClosenessTier } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { resolveCompany } from "../src/lib/companies";
import { identityKeysFor } from "../src/lib/duplicates";
import { findWarmPaths, warmPathsForTargets } from "../src/lib/leads/warm-path-query";
import { joinTeamWithDomain, setTeamSharing } from "../src/lib/teams";
import { ensureUserSettings } from "../src/lib/user-settings";

const V = "smoke-warm-viewer";
const A = "smoke-warm-alex";
const B = "smoke-warm-bee";
const C = "smoke-warm-chris";
const O = "smoke-warm-outsider";
const N = "smoke-warm-nobody";
const USERS = [V, A, B, C, O, N];
const DOMAIN = "smoke-warm.test";
const OTHER = "other-smoke-warm.test";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(companies).where(inArray(companies.userId, USERS));
  await db.delete(teamMembers).where(inArray(teamMembers.userId, USERS));
  await db.delete(teams).where(inArray(teams.domain, [DOMAIN, OTHER]));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function person(
  userId: string,
  fullName: string,
  opts: { email?: string; company?: string; tier?: ClosenessTier; closeness?: number; shared?: boolean }
) {
  const db = await getDb();
  const company = opts.company ? await resolveCompany(userId, opts.company) : null;
  const [row] = await db
    .insert(contacts)
    .values({
      userId,
      fullName,
      email: opts.email ?? null,
      company: company?.name ?? null,
      companyId: company?.id ?? null,
      closenessTier: opts.tier ?? null,
      closeness: opts.closeness ?? null,
      teamShared: opts.shared === false ? 0 : 1,
    })
    .returning({ id: contacts.id });
  await claimIdentities(userId, row.id, identityKeysFor({ email: opts.email }), "smoke");
  return row.id;
}

async function main() {
  const db = await getDb();
  await cleanup();
  try {
    for (const u of USERS) await ensureUserSettings(u);
    await db.update(userSettings).set({ firstName: "Alex", lastName: "Ng", email: "alex@smoke-warm.test" }).where(eq(userSettings.userId, A));
    await db.update(userSettings).set({ firstName: null, lastName: null, email: "chris@smoke-warm.test" }).where(eq(userSettings.userId, C));

    await joinTeamWithDomain(V, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(A, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(B, DOMAIN, { shareNetwork: false });
    await joinTeamWithDomain(C, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(O, OTHER, { shareNetwork: true });

    // Alex: knows Jane closely, two more at Acme, and one person marked private.
    await person(A, "Jane Doe", { email: "jane@target.test", company: "Acme", tier: "inner", closeness: 80 });
    await person(A, "Bob Ray", { email: "bob@target.test", company: "Acme", tier: "outer", closeness: 20 });
    await person(A, "Carol Wu", { email: "carol@target.test", company: "Acme", tier: "mid", closeness: 50 });
    await person(A, "Zed Private", { email: "zed@private.test", tier: "inner", closeness: 90, shared: false });
    // Chris: nameless in the mirror, knows Jane a little and Dan loosely; a never-scored contact.
    await person(C, "Jane Doe", { email: "jane@target.test", tier: "mid", closeness: 45 });
    await person(C, "Dan Lee", { email: "dan@target.test", tier: "outer", closeness: 10 });
    await person(C, "Eve Unscored", { email: "eve@target.test" });
    // Bee is not sharing; the outsider is on another team; the viewer's own contact is not a path.
    await person(B, "Jane Doe", { email: "jane@target.test", tier: "inner", closeness: 99 });
    await person(O, "Jane Doe", { email: "jane@target.test", tier: "inner", closeness: 99 });
    await person(V, "Jane Doe", { email: "jane@target.test", tier: "inner", closeness: 99 });

    console.log("\nreciprocity is decided before any query");
    check("no team → no_team", (await findWarmPaths(N, { email: "jane@target.test" })).status === "no_team");
    await setTeamSharing(V, false);
    check("not sharing → not_sharing", (await findWarmPaths(V, { email: "jane@target.test" })).status === "not_sharing");
    await setTeamSharing(V, true);

    console.log("\nwhat a sharing viewer learns");
    const jane = await findWarmPaths(V, { email: "jane@target.test", companyNormalized: "acme" });
    check("lookup ok", jane.status === "ok");
    if (jane.status === "ok") {
      const ids = jane.path.direct.map((d) => d.teammate.userId);
      check("Jane is hot", jane.path.warmth === "hot", jane.path.warmth);
      check("Alex (inner) then Chris (mid)", ids.join(",") === `${A},${C}`, ids.join(","));
      check("named from the mirror, with the mailbox fallback", jane.path.direct[0].teammate.name === "Alex Ng" && jane.path.direct[1].teammate.name === "chris");
      check("tier and score are carried", jane.path.direct[0].tier === "inner" && jane.path.direct[0].closeness === 80);
      check("matched on the email", jane.path.direct[0].matchedOn === "email");
      check("the non-sharing teammate is absent", !ids.includes(B));
      check("the other team is absent", !ids.includes(O));
      check("the viewer's own contact is not a path", !ids.includes(V));
      const acme = jane.path.account.find((a) => a.teammate.userId === A);
      check("Alex knows 3 people at Acme, best inner", acme?.count === 3 && acme.bestTier === "inner", JSON.stringify(acme));
      check("nobody else has an Acme path", jane.path.account.length === 1);
    }

    const zed = await findWarmPaths(V, { email: "zed@private.test" });
    check("a private contact is invisible: cold", zed.status === "ok" && zed.path.warmth === "cold" && zed.path.direct.length === 0);

    const dan = await findWarmPaths(V, { email: "dan@target.test" });
    check("one loose path is cool", dan.status === "ok" && dan.path.warmth === "cool");

    const eve = await findWarmPaths(V, { email: "eve@target.test" });
    check("a never-scored contact counts as outer", eve.status === "ok" && eve.path.direct[0]?.tier === "outer");

    const onlyCompany = await findWarmPaths(V, { companyNormalized: "acme" });
    check("a company alone is cool, with the account path", onlyCompany.status === "ok" && onlyCompany.path.warmth === "cool" && onlyCompany.path.account.length === 1);

    const nothing = await findWarmPaths(V, { email: "nobody@nowhere.test" });
    check("an unknown person is cold", nothing.status === "ok" && nothing.path.warmth === "cold");

    console.log("\nthe batched form agrees with the single one");
    const batch = await warmPathsForTargets(V, [
      { key: "jane", email: "jane@target.test", companyNormalized: "acme" },
      { key: "dan", email: "dan@target.test" },
      { key: "zed", email: "zed@private.test" },
    ]);
    check("batch ok", batch.status === "ok");
    if (batch.status === "ok" && jane.status === "ok" && dan.status === "ok" && zed.status === "ok") {
      const same = (k: string, single: typeof jane.path) => {
        const b = batch.paths.get(k);
        return !!b && b.warmth === single.warmth && b.direct.map((d) => d.teammate.userId).join() === single.direct.map((d) => d.teammate.userId).join() && b.account.length === single.account.length;
      };
      check("jane", same("jane", jane.path));
      check("dan", same("dan", dan.path));
      check("zed", same("zed", zed.path));
    }
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll warm-path query checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

Register it: in `scripts/run-smoke.ts` pglite section, next to `"smoke-team-lifecycle"`, add `"smoke-warm-paths": "pglite",`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/smoke-warm-paths.ts`
Expected: FAIL at import — `Cannot find module '../src/lib/leads/warm-path-query'`.

- [ ] **Step 3: Write the query module**

Create `src/lib/leads/warm-path-query.ts`:

```ts
/**
 * Runs the who-knows-whom statements for a viewer. Reciprocity first: a viewer with no team
 * or with sharing off gets a status, not a query. Then two statements for any number of
 * targets — the Leads pipeline must never issue one per row.
 */
import type { ClosenessTier } from "@/db/schema";
import { getDb, rowsOf } from "@/db";
import type { IdentityKind } from "@/lib/duplicates";
import { teammateDisplayName } from "@/lib/team-domain";
import { getViewerTeam } from "@/lib/teams";
import {
  identityPairs,
  rankWarmth,
  TIER_RANK,
  type TargetIdentity,
  type WarmPath,
  type WarmPathLookup,
} from "./warm-path";
import { accountPathsStatement, directPathsStatement } from "./warm-path-sql";

export type KeyedTarget = TargetIdentity & { key: string };

type MateRow = { user_id: string; first_name: string | null; last_name: string | null; email: string | null };
type DirectRow = MateRow & {
  target_key: string;
  tier: ClosenessTier;
  closeness: number | null;
  matched_on: IdentityKind;
};
type AccountRow = MateRow & { target_key: string; count: number; best_rank: number };

const RANK_TIER: ClosenessTier[] = ["inner", "mid", "outer"];

function teammate(r: MateRow) {
  return {
    userId: r.user_id,
    name: teammateDisplayName({ firstName: r.first_name, lastName: r.last_name, email: r.email }),
    email: r.email,
  };
}

export async function warmPathsForTargets(
  viewerUserId: string,
  targets: ReadonlyArray<KeyedTarget>
): Promise<{ status: "no_team" | "not_sharing" } | { status: "ok"; paths: Map<string, WarmPath> }> {
  const membership = await getViewerTeam(viewerUserId);
  if (!membership) return { status: "no_team" };
  if (!membership.shareNetwork) return { status: "not_sharing" };

  const paths = new Map<string, WarmPath>();
  for (const t of targets) paths.set(t.key, { warmth: "cold", direct: [], account: [] });

  const identityTargets = targets.flatMap((t) =>
    identityPairs(t).map((p) => ({ key: t.key, kind: p.kind, value: p.value }))
  );
  const companyTargets = targets.flatMap((t) =>
    t.companyNormalized ? [{ key: t.key, company: t.companyNormalized }] : []
  );

  const db = await getDb();
  if (identityTargets.length) {
    const rows = rowsOf<DirectRow>(
      await db.execute(directPathsStatement(membership.teamId, viewerUserId, identityTargets))
    );
    for (const r of rows) {
      paths.get(r.target_key)?.direct.push({
        teammate: teammate(r),
        tier: r.tier,
        closeness: r.closeness === null ? null : Number(r.closeness),
        matchedOn: r.matched_on,
      });
    }
  }
  if (companyTargets.length) {
    const rows = rowsOf<AccountRow>(
      await db.execute(accountPathsStatement(membership.teamId, viewerUserId, companyTargets))
    );
    for (const r of rows) {
      paths.get(r.target_key)?.account.push({
        teammate: teammate(r),
        count: Number(r.count),
        bestTier: RANK_TIER[Number(r.best_rank)] ?? "outer",
      });
    }
  }
  for (const path of paths.values()) {
    path.direct.sort(
      (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || (b.closeness ?? -1) - (a.closeness ?? -1)
    );
    path.account.sort((a, b) => b.count - a.count || TIER_RANK[a.bestTier] - TIER_RANK[b.bestTier]);
    path.warmth = rankWarmth(path.direct, path.account);
  }
  return { status: "ok", paths };
}

/** One target. */
export async function findWarmPaths(viewerUserId: string, target: TargetIdentity): Promise<WarmPathLookup> {
  const result = await warmPathsForTargets(viewerUserId, [{ ...target, key: "target" }]);
  if (result.status !== "ok") return result;
  return { status: "ok", path: result.paths.get("target")! };
}
```

Note the account count includes a directly-known person at that company; the UI reads it as "knows N people at Acme", which is true, with the direct path shown separately above it.

- [ ] **Step 4: Run the smoke and the manifest check**

Run: `npx tsx scripts/smoke-warm-paths.ts && npx tsx scripts/run-smoke.ts --check`
Expected: all `ok`. If `resolveCompany` produces `name_normalized` other than `"acme"` for "Acme", read `normalizeCompanyName(displayCompanyName("Acme"))` in the smoke and use that as `companyNormalized`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npx tsc --noEmit && npx eslint src/lib/leads scripts/smoke-warm-paths.ts`

```bash
git add src/lib/leads/warm-path-query.ts scripts/smoke-warm-paths.ts scripts/run-smoke.ts
git commit -m "Look up who on the team knows a person, and how well

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Server Actions

**Files:**
- Create: `src/actions/teams.ts`
- Modify: `scripts/smoke-warm-path.ts` (a structural section)

**Interfaces:**
- Consumes: everything from Tasks 4–8.
- Produces (all `async`, all gated by `requireLeadsUser()`): `getTeamEligibility()`, `joinTeamAction({ shareNetwork })`, `leaveTeamAction()`, `setTeamSharingAction(on)`, `setContactTeamSharedAction(contactId, shared)`, `listTeamMembersAction()`, `lookupWarmLead(raw)`.

- [ ] **Step 1: Write the failing structural check**

Add to `scripts/smoke-warm-path.ts`, before the client-bundle section:

```ts
  console.log("\nthe actions in front of it");
  {
    const source = code("src/actions/teams.ts");
    check("is a server module", /^\s*"use server";/m.test(readFileSync("src/actions/teams.ts", "utf8")));
    const exports = [...source.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)];
    check("every export is an async function", exports.length >= 7 && exports.every((m) => !!m[1]), String(exports.length));
    check("no type re-exports (they break a use-server module)", !/^export\s+type\s*\{/m.test(source));
    const bodies = source.split(/^export\s+async\s+function\s+/m).slice(1);
    check("every action gates on requireLeadsUser first", bodies.every((b) => /^[^{]*\{\s*const userId = await requireLeadsUser\(\);/.test(b)));
  }
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/smoke-warm-path.ts`
Expected: FAIL — `ENOENT: src/actions/teams.ts`.

- [ ] **Step 3: Write the actions**

Create `src/actions/teams.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { parseTargetInput, type ParsedTarget } from "@/lib/leads/target-input";
import type { WarmPathLookup } from "@/lib/leads/warm-path";
import { findWarmPaths } from "@/lib/leads/warm-path-query";
import { requireLeadsUser } from "@/lib/plan-guards";
import {
  eligibleTeamForUser,
  getViewerTeam,
  joinTeam,
  leaveTeam,
  listTeamMembers,
  setContactTeamShared,
  setTeamSharing,
  type TeamEligibility,
  type TeamMemberRow,
} from "@/lib/teams";

/*
 * Every action starts with `requireLeadsUser()`: Server Functions answer a direct POST, so
 * this — not the nav — is the boundary, and while Leads is coming soon it refuses everyone.
 * `UserFacingError`s come back as data through `asActionResult`; a throw would digest.
 */

export async function getTeamEligibility(): Promise<TeamEligibility> {
  const userId = await requireLeadsUser();
  return eligibleTeamForUser(userId);
}

export async function joinTeamAction(input: {
  shareNetwork: boolean;
}): Promise<ActionResult<{ teamId: string; memberCount: number }>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const joined = await joinTeam(userId, { shareNetwork: input.shareNetwork === true });
    revalidatePath("/leads");
    return joined;
  });
}

export async function leaveTeamAction(): Promise<ActionResult<{ left: true }>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    await leaveTeam(userId);
    revalidatePath("/leads");
    return { left: true as const };
  });
}

export async function setTeamSharingAction(on: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const changed = await setTeamSharing(userId, on === true);
    if (!changed) throw new UserFacingError("Join your team first.");
    revalidatePath("/leads");
    return { enabled: on === true };
  });
}

export async function setContactTeamSharedAction(
  contactId: string,
  shared: boolean
): Promise<ActionResult<{ shared: boolean }>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const changed = await setContactTeamShared(userId, String(contactId), shared === true);
    if (!changed) throw new UserFacingError("That contact isn't yours to change.");
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/leads");
    return { shared: shared === true };
  });
}

export async function listTeamMembersAction(): Promise<TeamMemberRow[]> {
  const userId = await requireLeadsUser();
  const membership = await getViewerTeam(userId);
  return membership ? listTeamMembers(membership.teamId) : [];
}

export async function lookupWarmLead(raw: string): Promise<{ parsed: ParsedTarget; lookup: WarmPathLookup }> {
  const userId = await requireLeadsUser();
  const parsed = parseTargetInput(String(raw ?? "").slice(0, 300));
  const lookup = await findWarmPaths(userId, parsed);
  return { parsed, lookup };
}
```

- [ ] **Step 4: Run the smoke, typecheck, lint**

Run: `npx tsx scripts/smoke-warm-path.ts && npx tsc --noEmit && npx eslint src/actions/teams.ts`
Expected: all `ok`; no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/actions/teams.ts scripts/smoke-warm-path.ts
git commit -m "Add the team and warm-lead Server Actions, gated on a released Leads page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Whole-branch verification and the PR

**Files:** none new.

- [ ] **Step 1: Rescan the schema number**

Run:
```bash
bash -c 'for r in $(git for-each-ref --format="%(refname)" refs/heads refs/remotes); do v=$(git show "$r:src/db/index.ts" 2>/dev/null | grep -oE "^export const SCHEMA_VERSION = [0-9]+" | grep -oE "[0-9]+$"); [ -n "$v" ] && echo "$v $r"; done | sort -rn | head -5; git worktree list --porcelain | grep "^worktree " | cut -d" " -f2 | while read w; do grep -hoE "^export const SCHEMA_VERSION = [0-9]+" "$w/src/db/index.ts" 2>/dev/null | sed "s|$| $w|"; done | sort -rn | head -5'
```
Expected: nothing other than this branch claims 90. If something does, take the next free number, update the changelog comment, and rerun `npx tsx scripts/smoke-schema-ddl.ts --update`.

- [ ] **Step 2: Run everything**

Run:
```bash
npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check && npm test && npm run build && rm -rf .next
```
Expected: tsc silent; eslint 0 errors; manifest ok; every smoke `ok` (rerun any admin-render/instrumentation timeout alone — they flake under load); build passes.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin claude/leads-p2-teams
gh pr create --base claude/coming-soon-leads-tab-93382b --title "Leads P2: teams and the who-knows-whom index (schema v90)" --body "$(cat <<'EOF'
## What

The team model behind Leads (docs/superpowers/specs/2026-09-22-leads-design.md, P2). A person with a verified work email joins their domain's team, chooses whether to share their network, and can look up a person to learn which sharing teammates know them and how closely — nothing else about those contacts leaves the database. No UI yet; that is P3.

## Changes

- `teams`, `team_members`, `contacts.team_shared`, `contact_identities(kind, value)`, `companies(name_normalized)` — schema v90.
- `src/lib/team-domain.ts` (pure): which emails form a team, team names, teammate display names.
- `src/lib/teams.ts`: join (race-safe, one team per person), leave (empty teams go), the two sharing switches, members.
- `src/lib/leads/`: the warmth ladder, target parsing, the SQL builders (pure, so a smoke greps the rendered statement for forbidden columns), and the query.
- `requireReleasedSurface` + `requireLeadsUser`: a coming-soon page's actions are refused the way its page is.
- The `leads` purge category.
- Smokes: `smoke-warm-path` (pure), `smoke-team-lifecycle` and `smoke-warm-paths` (pglite), plus seeds in the purge and surface-visibility smokes.

## Verification

tsc, eslint, `run-smoke --check`, the full suite, and `next build`.

Stacked on #264; retarget to `main` once it merges.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage:** Data model (Task 1), team lifecycle (Task 5), pure modules and the ladder (Tasks 2, 6), the warm-path query and its privacy rules (Tasks 7, 8), `requireReleasedSurface` (Task 4), purge category (Task 3), actions (Task 9). `rankPipeline` over the `leads` table is P3 (the table does not exist yet) — deliberately absent here. The demo-team seed is P3 with the page.
- **Placeholders:** none; every step carries its code.
- **Type consistency:** `TeamMembership`, `TeamEligibility`, `TeamMemberRow` (Task 5) are what Task 9 imports; `WarmPath`, `WarmPathLookup`, `TargetIdentity`, `identityPairs`, `rankWarmth`, `TIER_RANK` (Task 6) are what Tasks 8 and 9 use; the row column names in Task 8 (`tier`, `closeness`, `matched_on`, `count`, `best_rank`) match the SELECT lists in Task 7.

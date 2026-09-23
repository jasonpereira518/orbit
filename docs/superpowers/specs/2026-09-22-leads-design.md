# Leads: warm intros through your team, with Salesforce and HubSpot

**Status:** approved 2026-09-22. Built behind the coming-soon gate in seven stacked PRs (P0–P7 below). Each phase gets its own implementation plan under `docs/superpowers/plans/` when it starts.

## Problem

Salespeople keep two networks: the people they know, and the CRM their company runs. Orbit holds the first. A lead in the second is cold unless someone the seller knows already knows them. When several coworkers use Orbit, the overlap between their networks is exactly the map of warm paths — and nobody can see it.

Leads gives a salesperson one page that answers "who on my team already knows this person, and how well?", fed by three sources: the CRM pipeline (Salesforce, HubSpot), targets typed in by hand, and Apollo search. Clients and customers synced from the CRM become **work contacts** in Orbit; leads stay in a pipeline until they convert.

## Decisions

| Topic | Decision |
|---|---|
| Release | Everything ships behind `comingSoon: true` on a `page.leads` surface (the PR #211 pattern). Releasing is deleting that line |
| Team model | A team is a **verified email domain**. A user whose Clerk primary email is verified and not a public domain gets a one-click "Join the Acme team". One team per user |
| Disclosure | A teammate learns **who** on the team knows a person and their closeness tier (inner / mid / outer). Never notes, interactions, tags, contact details, or anyone else in the network |
| Share scope | All of a member's contacts count, gated by a per-team opt-in at join (`team_members.share_network`) and a per-contact "Hidden from team" opt-out (`contacts.team_shared`). Reciprocal: no sharing, no results. Live `EXISTS` predicates, never cached counts, so revoking is immediate — the Recruiters-pool shape |
| CRM depth | Read sync, continuous on the 30-minute scheduler, **and** write-back (log an Orbit interaction as a CRM activity; create a CRM contact on explicit action) through the connector outbox |
| Lead sources | CRM leads, manual targets (email / LinkedIn URL / phone / "Name, Company"), Apollo search |
| Entitlement | Joining a team and looking up warm paths are free. Connecting a CRM is paid via a new `crm` FeatureKey (its own denial copy and demand signal, not `sync`) |
| Leads vs contacts | CRM **customers** become Orbit contacts. CRM **leads** live in the Leads pipeline until converted or "Add to contacts", so a big pipeline never floods Contacts or the free-plan cap |
| Multi-org | One connection per provider per user (the spine's `(user_id, connector_id)` unique index stays) |
| Intro request v1 | "Ask Alex for an intro" opens a prefilled `mailto:` to the teammate's mirrored email and marks the lead `intro_requested`. An in-app request record is a later phase |

## Data model

Every new table: Drizzle in `src/db/schema.ts`; `CREATE TABLE IF NOT EXISTS` with its indexes in the DDL template (`applySchema` runs the template's `CREATE TABLE`s on every database, so `alters` is for columns and indexes on existing tables); new columns on existing tables also through `ensureColumn` in `migratePglite`; listed in `scripts/setup-db.ts` `EXPECTED_TABLES`; covered by a purge step in `src/lib/user-data.ts`. `SCHEMA_VERSION` is rescanned across every remote branch and local worktree at merge time — two branches writing the same number merge silently.

**`teams`** — `id`, `domain` (unique, lower-cased), `name`, `created_by` (Clerk id or the `TEAM_DELETED_CREATOR` sentinel after a purge; deliberately not named `user_id`), timestamps.

**`team_members`** — `id`, `team_id` (FK cascade), `user_id` (unique: one team per user), `share_network` integer default 0, `email_domain` (verified at join), `joined_at`, `updated_at`. Index `(team_id, share_network)`.

**`contacts.team_shared`** integer default 1 — per-contact opt-out, inert until the member shares, survives leave and rejoin.

**Indexes** — `contact_identities (kind, value)` (cross-user lookup; the existing unique index leads with `user_id`) and `companies (name_normalized)`.

**`leads`** — `id`, `user_id`, `source` (`crm` | `manual` | `apollo`), `crm_record_id` (FK set-null), `contact_id` (FK set-null; set on conversion, the lead stays as history), `display_name`, `email`, `email_normalized`, `linkedin_url`, `linkedin_slug`, `phone`, `phone_e164`, `company_name`, `company_normalized`, `title`, `apollo_id`, `status` (`open` | `intro_requested` | `converted` | `dismissed`), `notes` (private), timestamps. Indexes on `(user_id, status, updated_at desc)`, `(user_id, email_normalized)`, `(user_id, linkedin_slug)`, `(contact_id)`; partial uniques on `(user_id, apollo_id)` and `(user_id, crm_record_id)`. No unique on email: a manual lead and a later CRM lead for the same person merge. Identity columns use the same normalisers as `identityKeysFor`, so lookups are equality probes.

**`crm_records`** — the sync ledger and the contact↔CRM map in both directions. `id`, `user_id`, `connector_id`, `remote_type` (`contact` | `lead`), `remote_id`, `contact_id` (FK set-null), `lifecycle` (`lead` | `customer` | `other`), `stage` (raw provider value, never interpreted), `display_name`, `email`, `email_normalized`, `phone`, `linkedin_url`, `company_name`, `company_normalized`, `company_domain`, `title`, `remote_owner_ref`, `remote_url`, `last_activity_at`, `remote_created_at`, `remote_updated_at`, `properties` jsonb (whitelisted scalars only), `link_blocked_at` (contact creation refused by the plan cap; retried when headroom appears), `synced_at`, timestamps. Unique `(user_id, connector_id, remote_type, remote_id)`; indexes `(user_id, contact_id)`, `(contact_id)`, `(user_id, connector_id, lifecycle)`, partial on `link_blocked_at`.

Two tables rather than one because the sync upserts one shape per page regardless of lifecycle; a HubSpot contact moving lead → customer keeps its row and only flips `lifecycle`; `crm_records` is connection-derived (purged with `connections`, rebuilt on reconnect) while `leads` is user content. **Work contacts** = contacts with a `crm_records` row whose `contact_id` is set. `external_links` stays the outbox's own idempotency map.

## Modules

- `src/lib/team-domain.ts` (pure) — `teamDomainForEmail`, `teamNameForDomain`, via `publicEmailDomain()` in `src/lib/closeness-evidence.ts`.
- `src/lib/teams.ts` — `getViewerTeam` (request-cached), `verifiedWorkEmail` (reads Clerk's `primaryEmailAddress.verification.status`; demo mode short-circuits), `eligibleTeamForUser`, `joinTeam` (race-safe find-or-create like `resolveCompany`), `leaveTeam` (delete the team when empty), `setTeamSharing`, `setContactTeamShared`, `listTeamMembers`.
- `src/lib/leads/warm-path.ts` (pure) — `TargetIdentity`, `DirectPath` (tier and matched identity kind, no score), `AccountPath`, `Warmth`, `WarmPath`, `rankWarmth`, `teammateDisplayName`.
- `src/lib/leads/target-input.ts` (pure) — `parseTargetInput(raw)`.
- `src/lib/leads/warm-path-query.ts` — `findWarmPaths`, `warmPathsForTargets` (N targets, two statements), `rankPipeline` (LATERAL unnest over the viewer's open leads; the page never issues N queries).
- `src/lib/leads.ts` — `createLead`, `importApolloProspects`, `listLeads`, `setLeadStatus`, `convertLeadToContact` (via `createContactForUser`), `upsertCrmLeads`.
- `src/lib/crm/records.ts`, `src/lib/crm/hubspot/*`, `src/lib/crm/salesforce/*`, `src/lib/crm/write-back.ts` — pure `mapping.ts` per provider, fixture-tested; `sync.ts` hands records to `ingestPeople` / `ingestEvents`.
- `src/lib/connectors/token.ts` — `getConnectorAuth`, `withConnectorAuth` (proactive refresh, one reactive refresh on 401, then `markConnectorNeedsReauth`).
- `src/lib/connectors/syncs.ts` (server-only) — `CONNECTOR_SYNCS` + `resolveConnectorWithSync`. The registry stays free of sync functions and `@/db` so client components can import it.
- Guards in `src/lib/plan-guards.ts` — `requireLeadsUser()` = `requireUserId` + `requireReleasedSurface("page.leads")`; `requireCrmUser()` adds `requireEntitlement(userId, "crm")`. `requireReleasedSurface` is new: today's `isSurfaceVisible` consults `hidden` only, so a direct POST reaches a coming-soon page's actions.

## The warm-path query (the privacy boundary)

```sql
with target(target_key, kind, value) as (values ...),
mate as (
  select tm.user_id, us.first_name, us.last_name, us.email
  from team_members tm join user_settings us on us.user_id = tm.user_id
  where tm.team_id = $team and tm.share_network = 1 and tm.user_id <> $viewer)
select distinct on (t.target_key, m.user_id)
  t.target_key, m.user_id, m.first_name, m.last_name, m.email, c.closeness_tier, t.kind
from target t
join contact_identities ci on ci.kind = t.kind and ci.value = t.value
join mate m on m.user_id = ci.user_id
join contacts c on c.id = ci.contact_id and c.user_id = ci.user_id and c.team_shared = 1
order by t.target_key, m.user_id,
  case c.closeness_tier when 'inner' then 0 when 'mid' then 1 else 2 end, c.closeness desc nulls last
```

Account paths use the same `mate` CTE joined through `companies.name_normalized` → `contacts.company_id`, grouped by teammate, returning a count and best tier (the target person is excluded in SQL by an anti-join on the target's identities, so count and best tier describe other people at the company).

Rules, enforced by a pure smoke that greps the statement text: the viewer's own sharing is decided once at the top (`no_team` / `not_sharing` short-circuit before any query); every join carries a `user_id` equality; no correlated `EXISTS`; raw `sql` with explicit aliases, never a column interpolated inside a drizzle `.select()` projection; `share_network = 1`, `team_shared = 1` and `<> $viewer` live in SQL, never in a JS post-filter; the SELECT list never names `notes`, `ai_summary`, `c.email`, `c.phone`, `linkedin_url` or `key_facts`; the result type carries no teammate `contact_id`. The "Shared while you share / Never shared" list in the UI is kept in sync with this SELECT list by hand.

Warmth ladder: **hot** = at least one inner-tier direct path; **warm** = one mid, or two outer; **cool** = one outer, or account paths only; **cold** = none.

## CRM sync

Per connector `sync(conn)`: authenticate and identify the owner (cached in `sync_cursor.meta`) → page people modified since `sync_cursor.syncedThrough` that the user owns (HubSpot contact search on `hubspot_owner_id` + `hs_lastmodifieddate`, 100 per page, 10k cap handled by advancing the watermark; Salesforce SOQL over `Contact` and `Lead` with `OwnerId = me AND SystemModstamp >= watermark`) → pure mapping to `CrmPerson[]` with `lifecycle` → `upsertCrmRecords` → customers through `ingestPeople` with `reportResolutions`, then `linkCrmRecordsToContacts` (cap-blocked → `link_blocked_at`) → leads through `upsertCrmLeads` (merging into an existing manual or Apollo lead by identity; lead → customer marks the lead `converted`) → optional engagements through `ingestEvents` with `createsContacts: false` and external ids `crm:${connectorId}:${objectType}:${remoteId}` → `markConnectorSyncResult` with the cursor (the sync must write its own cursor; the scheduler's backstop never does). Non-retryable conditions disarm the connection with an actionable message.

## Write-back

Enqueue on `logInteractionForUser` / `settleWrittenInteraction` (best-effort; skipping bulk paths, empty notes, and any interaction whose external id starts with `crm:` — the echo guard) and on an explicit "Add to HubSpot / Salesforce" action. The remote contact id is looked up in `crm_records` at enqueue time, one outbox row per connector with `logActivity` enabled. `deliverOutboxItem` dispatches on `manifest.id` to per-provider `deliver` modules; a successful `writeContact` also upserts the `crm_records` row. Once payloads carry note text, `connector_outbox.payload` joins `NEVER_REVEALABLE`.

## Phases

| Phase | Ships | Schema | Depends on |
|---|---|---|---|
| P0 | Placeholder tab: surface, nav, dry-dock teaser, stub page, feedback area | — | fresh branch off main |
| P1 | Land the connector spine (`claude/orbit-integrations-strategy-0b8be6`): merge main, renumber 74–76, pass the claimed connection to `sync`, server-only sync resolver, cursor `meta` | 87–89 | PR #257 merged |
| P2 | `teams`, `team_members`, `contacts.team_shared`, the two indexes, `requireReleasedSurface`, warm-path query, team lifecycle, purge category | 90 | P0 |
| P3 | `leads` table, `/leads` page (team panel, find-a-path, pipeline, detail sheet), Apollo search, contact-page "Hidden from team" pill, demo team seed | 91 | P2 |
| P4 | HubSpot read sync, `crm_records`, `crm` entitlement, connect/callback routes, settings tabs, Contacts "Work" pill, `ingestPeople` resolutions | 92 | P1, P3 |
| P5 | Salesforce read sync: OAuth variants (sandbox), PKCE, `instance_url` capture, SOQL | — | P4 |
| P6 | Write-back for both providers | — | P5 |
| P7 | Release: delete `comingSoon`, nav placement, tour step | — | all |

## Risks

1. Schema-version collisions: rescan every remote and local worktree at each merge; P1 and P2 land sequentially.
2. PR #257 reshapes `IntegrationStatuses`; merge it before P1 and adapt the spine's flat type.
3. The identity-normalisation contract between the `leads` writer and `contact_identities`.
4. Contacts with null `company_id` are invisible to account paths; consider a backfill via `resolveCompany`.
5. Domain = team splits `eu.acme.com` from `acme.com`; accepted for v1 and said in the join card.
6. Provider API details (scopes, association type ids, edition limits, PKCE) are verified against current docs when P4/P5 start; OAuth app creation and listings are long poles.
7. The `crm:` external-id prefix is the whole write-back echo defence.
8. Who-knows-whom reveals a contact's existence and tier to teammates; reciprocity and `team_shared` are the only levers.

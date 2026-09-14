# Outreach revision

The revised campaign workflow is gated by `OUTREACH_V2_ENABLED=1`. Leave it off in production until the controlled account checks below pass. With the flag off, existing campaigns continue using the original workspace; v2 records are preserved but execution is disabled. No deployment, remote migration, or live message sends are part of the automated validation.

## Enable in a test environment

1. Install root and extension dependencies with `npm ci` and `npm --prefix extension ci`.
2. Apply the repository's normal schema migration process for schema version 34. Bootstrap DDL and Drizzle schema both contain the additive migration. Do not use `db:push:DANGEROUS`.
3. Set `OUTREACH_V2_ENABLED=1`, `BRAVE_SEARCH_API_KEY`, and `APOLLO_API_KEY`. Personal keys are stored encrypted: Brave under campaign research settings and Apollo in the existing Settings integration. A run never falls back to hosted keys if personal keys fail. The existing AI configuration supplies audience interpretation, extraction, drafts, and constrained visual recovery.
4. Connect Gmail with send/read permissions. Reconnect Outlook to grant the newly requested `Mail.Send` and `Mail.ReadWrite` permissions. Campaigns pin the connected account's actual address; reconnecting another identity stops sending from the old campaign.
5. Configure `CRON_SECRET` and the existing scheduler's `APP_URL`. `.github/workflows/ops.yml` calls `POST /api/outreach/run` every five minutes. The endpoint uses the existing internal secret check. Server actions also request an immediate drain after committing durable jobs. Scheduled execution remains necessary when a request or browser closes.
6. Build and load the Orbit extension using its normal environment configuration (`npm --prefix extension run build`). Browser execution is opt-in from the Outreach session panel. It requests the selected site's permission, shows the pinned account, and opens a dedicated visible tab. The added Chrome debugger permission supports input and screenshots. Closing the panel stops execution; reopening and starting resumes the queue. The extension never bypasses a login challenge or restriction.

`OUTREACH_PRO_CREDITS` defaults to 250 per UTC calendar month. `OUTREACH_LIFETIME_CREDITS` defaults to 100 for the lifetime bucket. One reserved credit covers a bounded person-research attempt, including up to two provider requests across interrupted retries. Unused reservations are released; partially completed research is retained. Daily email capacity is 50 across the user's accounts, including pending reservations, and resets at UTC midnight. Queued recipients above that ceiling wait for the next day.

`provider_calls` and nullable `provider_cost_micros` in the allowance ledger are separate from customer credits. `OUTREACH_RESEARCH_CALL_COST_MICROS` can supply a configured per-call cost estimate; it is not provider-reported billing. Without a configured tariff, monetary cost remains unknown. Reconcile provider invoices/usage reports before treating these estimates as actual spend. AI usage continues through Orbit's existing usage instrumentation.

## Execution and recovery

- Approval records the exact draft revision, recipient, sender, subject, body, and signature. Editing invalidates it; stale bulk approvals are rejected. The complete body used in the preview is the body sent, without a hidden footer.
- PostgreSQL atomic claims and leases serialize durable jobs. A stale send lease becomes `needs_verification`, never an automatic retry. Gmail uses a stable RFC message ID; Outlook saves an immutable draft ID before sending. Provider acceptance and confirmed sending are distinct, and neither claims delivery. Outlook confirmation checks the stored message's `isDraft` state; a still-visible draft does not establish that sending failed.
- Browser checkpoints persist before the final click. Account, recipient, and content must match before that checkpoint. After a crash, verify the result in Activity before approving another attempt. A browser confirmation can establish a sent message even when its thread URL cannot be resolved; tracking then stays stale until a supported conversation view is available.
- Gmail history and Outlook inbox/sent-folder delta cursors refresh incrementally. Expired cursors rebuild from provider state. Sync is leased, bounded, and scheduled for five-minute refreshes; provider throttling, mailbox size, and scheduler delays can extend that interval. Browser tracking only runs during an active extension session.
- Replies and follow-ups use the original conversation. Human replies and accepted LinkedIn connections trigger contact linking through Orbit's identity resolver; ambiguous identities require review. Timeline event IDs prevent duplicate interactions on repeated syncs. Human replies, automatic replies, bounces, and connection acceptance are stored separately.
- Seven-day follow-ups are suggestions. Drafting and sending require user action. Human replies, opt-outs, and closed conversations suppress suggestions. Pending LinkedIn invitations never generate another invitation.
- Legacy campaigns remain readable. The upgrade flow selects a sender and confirms criteria, clears approvals, pauses execution, retains historical content, and turns scheduled follow-ups into drafts requiring review. Historical SMS stays readable; new campaigns cannot use SMS or InMail.

## Automated validation

Run without remote database access:

```sh
node --import tsx scripts/smoke-outreach-v2.ts
node --import tsx scripts/smoke-outreach-providers.ts
node --import tsx scripts/smoke-outreach-browser.ts
node --import tsx scripts/smoke-schema-ddl.ts
node --import tsx scripts/smoke-sync-columns.ts
node --import tsx scripts/run-smoke.ts --check
npm run typecheck
npm --prefix extension run typecheck
npm --prefix extension run build
```

Database suites use isolated temporary PGlite databases and block or mock external requests. Coverage includes concurrent reservations and claims, quota exhaustion, versioned approvals, duplicate sends, expired leases, exact message composition, provider thread IDs, expired Gmail history, Outlook acceptance/confirmation, browser account/content checkpoints, interrupted clicks, duplicate events, contact history, and legacy upgrades. Browser DOM fixtures cover supported composer and invitation states. Desktop/mobile review was also exercised against synthetic local campaign data.

## Controlled acceptance before rollout

Use designated sender accounts and recipients controlled by the team. Confirm Gmail and Outlook sending, replies sent both inside and outside Orbit, token expiration, provider delays, cursor resets, bounces and automatic replies. Confirm LinkedIn invitations within the actual account limit (200 by default, never over 300), acceptance, messaging, pending invitations, and already-connected people. Exercise account switching, login challenges, restrictions, browser closure between click and verification, and stale tracking. Check recipient selection across multiple result pages and exact previews for each channel.

The browser adapters currently recognize specific English-language provider UI structures. Unrecognized controls, recipients, or message timestamps stop execution or leave tracking stale. Live provider account fixtures must establish selector coverage before rollout; automated fixtures alone cannot establish that every account variant works. LinkedIn explicitly prohibits third-party automation; the separate session notice requires acknowledgement and restrictions stop execution.

Protocol references: [Gmail threading](https://developers.google.com/workspace/gmail/api/guides/threads), [Graph draft replies](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0), [Graph send acceptance](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search), [Apollo enrichment](https://docs.apollo.io/docs/enrich-people-data).

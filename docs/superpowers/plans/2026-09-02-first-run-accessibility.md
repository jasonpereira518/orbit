# First-run accessibility: sign-up → useful Orbit for non-technical students

Approved plan (design rationale and target flow): `~/.claude/plans/plan-with-me-to-lucky-wolf.md`.
This file is the same plan cut into dispatchable tasks. Each `### Task N` section is a self-contained brief: read it as the requirements, use its values verbatim.

## Spec (decisions that bind every task)

- Scope: the first-run journey. Persona: a student recruiting, comfortable with apps, not with API keys, CSVs, or OAuth scopes.
- Bring-your-own AI key stays, but becomes a guided, verified, in-place flow. Orbit never pays for AI.
- Day-one import is Google Contacts, free on every plan via a contacts-only Google consent. Gmail mailbox scan, Gmail send, and calendar sync stay Pro.
- LinkedIn becomes a deferred "request now, remind me tomorrow" task that never blocks the session.
- The tour (`src/components/onboarding/onboarding-flow.tsx`, `tour-config.ts` behaviour) is untouched; only two copy strings in tour-config change.
- Final wizard step union: `intro | add-people | connect-google | manual | capture | import | linkedin-later | ai-key | triage | review`.
- Non-goals: sample data in-product, hosted AI, Google Calendar via OAuth, extension publishing, daily-loop UX.

## Global Constraints

- Work only in this worktree. Never push, never open a PR, never run `npm run db:push` (it drops the runtime-managed embedding column).
- `npx tsc --noEmit` must stay clean. `npx eslint .` must not exceed the baseline of 39 errors / 2 warnings measured before Task 1.
- Smoke scripts: `npx tsx scripts/<name>.ts`. Pattern: `import { config } from "dotenv"; config({ path: ".env.local" }); config();` then `delete process.env.DATABASE_URL;` BEFORE any `../src/db` import when the script writes; a `check(label, condition, detail?)` helper that throws; `main().then(() => process.exit(0)).catch((e) => { console.error("\nFAILED:", e); process.exit(1); })`. See `scripts/smoke-entitlements.ts` and `scripts/smoke-import-engine.ts:19-31`. Stop any dev server that uses this worktree's `.data/pglite` before running a writing script.
- Never import `next/server` (or a module that reaches it) into a `src/lib` module that a tsx script imports. `after()` belongs in actions/routes.
- In a `"use server"` file every export must be an async function.
- A `"use client"` component must never import a module that reaches `@/db`.
- `MISSING_AI_API_KEY_MESSAGE` (`src/lib/errors.ts:3`) and the rejected-key message at `src/lib/errors.ts:72` must keep the words "API key": `isMissingAiApiKeyError` is `/api key/i` and is re-run on those constants in `bulk-notes-panel.tsx`.
- New DB columns go in three places: `src/db/schema.ts`, the Neon `alters` list in `src/db/index.ts` (see `wizard_offered_at` at ~:1528), and the PGlite `ensureColumn` list (~:1089); bump `SCHEMA_VERSION` (`src/db/index.ts:694`); run `npx tsx scripts/smoke-schema-ddl.ts --update` then `npx tsx scripts/smoke-schema-ddl.ts`.
- UI: reuse `src/components/ui` primitives (Button, Input, Label, Badge, Sheet, Dialog, Tooltip). Card chrome is `rounded-2xl border border-border/70 bg-card p-6`. Copy strings given in a task are used verbatim.
- No new npm dependencies.
- One commit per task (more if natural). Commit messages end with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Google OAuth env vars are absent locally; every Google path must degrade when `isGmailConfigured()` is false.
- Next.js 16.2: read `node_modules/next/dist/docs/` before using an API you are unsure of; `revalidatePath`, `after`, `redirect` semantics may differ from training data.

---

### Task 1: Free `contactsImport` entitlement, gate swaps, pricing copy

**Goal.** Google and Outlook contacts import become free on every plan; mailbox scan, send, and calendar sync stay behind `sync`.

**Files.** `src/lib/entitlements.ts`, `src/lib/gate-events.ts`, `src/lib/plan-guards.ts`, `src/actions/settings.ts`, `src/app/(admin)/admin/users/[userId]/page.tsx`, `src/components/pricing/plan-comparison.tsx`, `src/actions/outlook.ts`, `src/actions/imports.ts`, `src/lib/plan-copy.ts`, `src/components/imports/import-hub.tsx`, `src/app/(marketing)/(docs)/privacy/page.tsx`, `scripts/smoke-entitlements.ts`.

**Steps.**
1. `src/lib/entitlements.ts`: add `"contactsImport"` to `FeatureKey` (:45-51); add `canUseContactsImport: boolean` to `Entitlements` with a doc comment: free on every plan, kept as a FeatureKey so it flows through the single resolver and gate-hit telemetry and can be gated later without touching callers; `entitlementsForPlan` sets `canUseContactsImport: true`; `FEATURE_DENIAL.contactsImport = "Contacts import is included on every plan."`; reword `FEATURE_DENIAL.sync` to `"Mailbox and calendar sync are available on Orbit Pro and Orbit Lifetime. Google and Outlook contacts import is free on every plan."`; `FEATURE_FLAG.contactsImport = "canUseContactsImport"`.
2. `src/lib/gate-events.ts:27-34`: add `"contactsImport"` to `GateFeature`.
3. `src/lib/plan-guards.ts`: add `export async function requireContactsImportUser()` mirroring `requireSyncUser` (:48-52) with the `"contactsImport"` key.
4. `src/actions/settings.ts:104-113` plan block: add `canUseContactsImport: entitlements.canUseContactsImport`.
5. `src/app/(admin)/admin/users/[userId]/page.tsx:105-112` `entitlementFlags`: add `["contacts import", ent.canUseContactsImport]` after "recruiters".
6. `src/components/pricing/plan-comparison.tsx`: update the doc comment (:28-31) so the ungated list mentions Google and Outlook contacts import; add row `{ label: "Google and Outlook contacts import", cells: [true, true, true] }` right after the "LinkedIn import" row; rename the "Gmail, Outlook, calendar sync" row to `"Gmail mailbox sync, sending, and calendar sync"`.
7. Gate swaps to `requireContactsImportUser()`: `startOutlookOAuth` (`src/actions/outlook.ts:50`); in `src/actions/imports.ts` replace `requireUserId()` with `requireContactsImportUser()` in `previewGoogleContacts` (:687), `confirmGoogleContactsImport` (:762), `previewOutlookContacts` (:829), `confirmOutlookContactsImport` (:895). Do NOT touch `startGmailOAuth` (Task 2 gates it by scope set), the recruiter scan actions, `sendRecruiterDrafts`, or calendar actions — they stay on `requireSyncUser`.
8. Copy: `src/lib/plan-copy.ts` free `features` (:96-105) insert `"Google and Outlook contacts import"` right after `"LinkedIn import"`; Pro (:126) and Lifetime (:145) `"Gmail, Outlook, and calendar sync"` → `"Gmail mailbox sync, sending, and calendar sync"`. `src/components/imports/import-hub.tsx:149,283` any string claiming Google/Outlook are paid becomes `"LinkedIn, Google, and Outlook contacts imports are free on every plan."` (read both spots; keep surrounding sentence grammatical). `src/app/(marketing)/(docs)/privacy/page.tsx:105`: add "Google and Outlook contacts" to the connected-accounts sentence.
9. `scripts/smoke-entitlements.ts`: add `delete process.env.DATABASE_URL;` after the two `config()` calls (safety, matches smoke-import-engine). Add checks: free → `canUseContactsImport === true`; lifetime and orbit → `true`; `await requireEntitlement(USER, "contactsImport")` resolves on free; `await requireEntitlement(USER, "sync")` on free throws (`isPaywallError`) and afterwards `gate_events` (`gateEvents` table in `src/db/schema.ts:1675`) holds exactly one row for `USER` with `feature === "sync"` (count rows for USER before and after; delete them in `reset()`).

**Verification.** `npx tsc --noEmit`; `npx eslint .` (≤ 39 errors); `npx tsx scripts/smoke-entitlements.ts` passes (stop any dev server first). Commit.

---

### Task 2: Contacts-only Google consent with incremental auth

**Goal.** Connecting Google for contacts asks only for contacts + email; mailbox scopes are requested only by Pro flows. Existing full-scope connections keep working.

**Files.** `src/lib/gmail.ts`, new `src/lib/gmail-oauth-state.ts`, `src/actions/gmail.ts`, `src/actions/recruiter-messages.ts`, `src/app/api/gmail/callback/route.ts`, `src/components/imports/google-contacts-import.tsx`, `src/components/recruiters/gmail-import-panel.tsx`, `src/components/recruiters/compose-workspace.tsx`, new `scripts/smoke-google-scopes.ts`.

**Steps.**
1. `src/lib/gmail.ts`: replace the single `GMAIL_SCOPES` string (:20-26) with
   ```ts
   export type GoogleScopeSet = "contacts" | "mailbox";
   const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
   const BASE_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", GOOGLE_CONTACTS_SCOPE];
   const GOOGLE_SCOPE_SETS: Record<GoogleScopeSet, string[]> = {
     contacts: BASE_SCOPES,
     mailbox: [...BASE_SCOPES, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
   };
   export function googleScopesFor(set: GoogleScopeSet): string  // space-joined
   export function hasMailboxScope(scopes: string | null | undefined): boolean  // includes gmail.readonly
   ```
   Keep `hasContactsScope` / `hasSendScope`. `buildGmailAuthUrl(state: string, scopeSet: GoogleScopeSet)` uses `googleScopesFor(scopeSet)` and adds `include_granted_scopes: "true"`; keep `prompt: "consent"` and `access_type: "offline"`. `upsertGmailConnection(userId, tokens, emailAddress, opts?: { requestedScopes?: string })`: the stored `scopes` becomes `tokens.scope || opts?.requestedScopes || existing?.scopes || null` (never the full set by default); in the refresh path (~:326) pass `{ requestedScopes: conn.scopes ?? undefined }`. Update the doc comment at :9-17 to say contacts is a sensitive scope and mailbox adds restricted ones.
2. New `src/lib/gmail-oauth-state.ts` (pure, no DB, no next imports): `encodeGmailOAuthState({ userId, nonce, returnTo, scopes }: { userId: string; nonce: string; returnTo: string; scopes: GoogleScopeSet }): string` producing `userId:nonce:encodeURIComponent(returnTo):scopes`, and `decodeGmailOAuthState(state: string): { userId: string; nonce: string; returnTo: string; scopes: GoogleScopeSet } | null` (null when malformed or scope set unknown; `returnTo` decoded, empty string when absent). Use them in `startGmailOAuth` and `consumeGmailOAuthState` (`src/actions/gmail.ts:106-118`), which now returns `{ userId, returnTo, scopes }`.
3. `src/actions/gmail.ts`: `startGmailOAuth(opts: { returnTo?: string; scopes: GoogleScopeSet })` (required `scopes`). Gate: `scopes === "contacts" ? await requireContactsImportUser() : await requireSyncUser()`. Keep the same-origin `returnTo` check. `GmailConnectionStatus` gains `canImportContacts: boolean` (`hasContactsScope`) and `canScanMailbox: boolean` (`hasMailboxScope`), computed like `canSend` (:62) in `getGmailConnectionStatus`. In `startGmailRecruiterScan` (:162-215) after the active-connection check add: `if (!hasMailboxScope(conn.scopes)) throw new Error("Grant Orbit mailbox access to scan — reconnect Gmail from this page.");`
4. `src/actions/recruiter-messages.ts` `sendRecruiterDrafts` (:250-254): add a server-side `hasSendScope(conn.scopes)` check throwing `"Grant Orbit permission to send from Gmail — reconnect Gmail from the compose page."`
5. `src/app/api/gmail/callback/route.ts:50-67`: read `scopes` from the consumed state and pass `{ requestedScopes: googleScopesFor(scopes) }` to `upsertGmailConnection`. Redirect and querystring behaviour unchanged.
6. Call sites: `google-contacts-import.tsx:117` → `startGmailOAuth({ returnTo: "/imports", scopes: "contacts" })`; drive the "Reconnect Google" branch from `status.canImportContacts` (drop the optimistic `contactsScopeGranted` state or keep it only as a post-preview override). `gmail-import-panel.tsx:192` → `{ scopes: "mailbox" }`; when `connection.connected && !connection.canScanMailbox` render a button "Grant mailbox access" (same OAuth call) in place of "Scan mailbox" with helper text `"Orbit only has contacts access to this account."` `compose-workspace.tsx:400,439` → `{ returnTo: "/recruiters/compose", scopes: "mailbox" }`; generalise the reconnect banner copy (:424-431) to `"Orbit has contacts-only access to this Google account. Sending needs mailbox permission — reconnect to grant it."`
7. New `scripts/smoke-google-scopes.ts` (no DB, no network; set `GOOGLE_CLIENT_ID=test` and `GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback` in-script before importing): `googleScopesFor("contacts")` excludes `gmail.readonly` and `gmail.send` and includes `contacts.readonly`; `googleScopesFor("mailbox")` includes all three; `buildGmailAuthUrl("s", "contacts")` has `include_granted_scopes=true` and the contacts scope string; truth table of `hasContactsScope`/`hasMailboxScope`/`hasSendScope` over both sets and `null`; `encode`/`decodeGmailOAuthState` round-trip including a `returnTo` of `/onboarding/wizard?x=a:b` and a malformed state → null.

**Verification.** tsc; eslint; `npx tsx scripts/smoke-google-scopes.ts`; `npx tsx scripts/smoke-recruiter-scan.ts` still passes if it exercises scan gating (read it; if it needs a connection row with scopes, give it the mailbox set). Commit.

---

### Task 3: Google-first setup wizard step

**Goal.** The wizard's first door is "Import Google Contacts": connect → consent → back in the wizard with the list loaded → import → triage.

**Files.** `src/components/imports/google-contacts-import.tsx`, new `src/components/onboarding/wizard/wizard-connect-google.tsx`, `src/components/onboarding/wizard/setup-wizard.tsx`, `setup-wizard-lazy.tsx`, `src/app/(app)/onboarding/wizard/page.tsx`, `src/actions/onboarding-wizard.ts`, `wizard-review.tsx`, `wizard-triage.tsx`, `src/components/layout/app-shell.tsx`, `src/components/onboarding/tour-config.ts`.

**Steps.**
1. `GoogleContactsImport` props (do not fork the component):
   ```ts
   export function GoogleContactsImport({
     returnTo = "/imports",
     compact = false,
     autoPreview = false,
     onImportStarted,
     onUnavailable,
   }: {
     returnTo?: string;          // passed to startGmailOAuth
     compact?: boolean;          // no outer card chrome / h2; caller supplies its own
     autoPreview?: boolean;      // call previewGoogleContacts() unprompted after ?google=connected and when already connected with contacts scope
     onImportStarted?: (count: number) => void;  // fired right after startImportJob
     onUnavailable?: () => void; // fired once when !status.configured
   })
   ```
   Replace both hard-coded `/imports` in the querystring cleanup (:59-79) with `window.location.pathname`. Empty result: instead of only toasting "Loaded 0 contacts", render `"No contacts in this Google account."` with a button "Use a different account" that re-runs the OAuth call. OAuth error: keep the toast; in `compact` mode also render the `reason` inline in a muted paragraph so it survives the toast. Update the `IntegrationUnavailable` blurb (:89) to `"Google isn't available on this deployment yet. Upload a LinkedIn export, or paste your notes into Capture and Orbit will pull the people out."`
2. New `wizard-connect-google.tsx`: renders a trust line `"Orbit asks only to read your contacts — never your email."`, `<GoogleContactsImport returnTo="/onboarding/wizard" compact autoPreview onImportStarted={…} onUnavailable={…} />`, a hint when the selected count exceeds `FREE_CONTACT_LIMIT` (import from `@/lib/plan-limits`; check that module is client-safe — it says server-only in its header, so instead accept `contactLimit: number | null` as a prop from the page via `getSettings().plan.contactLimit`): `"The free plan holds up to {limit} contacts; Orbit imports the first {limit} and skips the rest."`, and a footer ghost button "Skip for now". Props: `onImported(count)`, `onSkip()`, `contactLimit`.
3. `setup-wizard.tsx`: add `"connect-google"` to `WizardStep`; `STEP_TITLES["connect-google"] = "Import your Google contacts"`; replace `isValidStep` with `function isValidStep(step): step is WizardStep { return step != null && step in STEP_TITLES; }`; `PATHS` becomes, in order: `{ id: "connect-google", icon: Contact (lucide), title: "Import Google Contacts", description: "Two clicks. Orbit only reads your contacts, never your email." }`, then the existing capture (`description: "Paste meeting notes — Orbit pulls out the people. Needs a free AI key; we'll walk you through it."`), manual (unchanged), and LinkedIn (`title: "Upload a LinkedIn export"`, `description: "Takes about a day to arrive. Have the file already? Upload it here."`). New props `googleConfigured: boolean` and `contactLimit: number | null` threaded page → `SetupWizardLazy` → `SetupWizard`; when `!googleConfigured` filter the Google path out of `PATHS`. Step branch: `<WizardConnectGoogle contactLimit onImported={(count) => { addResult({ kind: "google", count }); goTo("triage"); }} onSkip={() => goTo("add-people")} />`. `IntroStep` copy → `"Two minutes. Start with the people already in your Google Contacts, paste notes from a coffee chat, or add one name. LinkedIn takes a day — kick it off now and Orbit will nudge you."`
4. `src/app/(app)/onboarding/wizard/page.tsx`: compute `googleConfigured` with `isGmailConfigured()` from `@/lib/gmail` (server), pass `contactLimit={settings.plan.contactLimit}`.
5. `src/actions/onboarding-wizard.ts` `WIZARD_STEP_IDS`: add `"connect-google": true`.
6. `wizard-review.tsx`: `WizardResult` gains `{ kind: "google"; count: number }` → `"Started importing N Google contacts."` (singular "1 Google contact").
7. `wizard-triage.tsx`: subscribe with `useImportJob()` from `@/lib/import-job-runner`; while `job?.status === "running"` show `"Importing {done}/{total} people — Orbit will ask about a few once they land."` instead of the empty state; when the status flips to `completed`, call the existing `retry()` once.
8. `src/components/layout/app-shell.tsx:71-76`: `showAskBar` must also be false when `pathname.startsWith("/onboarding")` (keep the exact-match `isOnboarding` chromeless branch for the tour as is).
9. `tour-config.ts:123,125`: mention Google Contacts before LinkedIn in those two strings (copy only; no behaviour change).

**Verification.** tsc; eslint. Manual with the dev server (`.claude/launch.json` preview on this worktree's port; demo mode is fine): `/onboarding/wizard` shows Google first when `GOOGLE_CLIENT_ID` is set to any value with a redirect URI, and hides it when unset; the Google step renders the trust line and Skip; picking Google then refreshing resumes on the same step; `/onboarding/wizard` has no floating ask bar. Commit.

---

### Task 4: AI key probe, throttle, and `verifyAndSaveAiKey`

**Goal.** A server action that verifies a pasted key against the provider before saving it, with human-readable failure reasons.

**Files.** new `src/lib/ai-key-probe.ts`, new `src/lib/rate-limit.ts`, `src/actions/settings.ts`, new `scripts/smoke-ai-key-probe.ts`.

**Steps.**
1. `src/lib/ai-key-probe.ts` (no `"use server"`; may import provider SDKs exactly as `src/lib/ai.ts` constructs clients — read :460-510 first):
   ```ts
   export type ProbeReason = "invalid" | "no_access" | "network" | "throttled";
   export type ProbeResult = { ok: true } | { ok: false; reason: ProbeReason; message: string };
   export function probeReasonFromError(err: unknown): Exclude<ProbeReason, "throttled">;  // pure
   export async function probeAiKey(provider: AiProvider, apiKey: string, model: string): Promise<ProbeResult>;
   ```
   Per provider make the cheapest authenticated call: prefer a model-retrieve call for `model` (check the installed SDKs in `node_modules/@google/genai`, `node_modules/openai`, `node_modules/@anthropic-ai/sdk` for the method — do not assert from memory); fall back to a 1-output-token generation only if the SDK has no such call. Map with `classifyAiError` (`src/lib/errors.ts:102`): `auth` → `invalid` ("That key was rejected by {Provider}. Check you copied the whole thing."); `model_unavailable` → `no_access` ("The key works, but it can't use {model}. Pick another model under Advanced."); `timeout`/network → `network` ("Couldn't reach {Provider}. Try again in a moment."); **`rate_limit` → `{ ok: true }`** (a 429 proves the key authenticates; Gemini free tier rate-limits constantly). Never log or include the key in any message.
2. `src/lib/rate-limit.ts`: `export function takeToken(key: string, opts: { max: number; windowMs: number }): boolean` — in-memory `Map<string, number[]>` sliding window; doc comment states it is per-instance and therefore soft.
3. `src/actions/settings.ts`: extract the body of `saveAiSettings` (:165-235) into a non-exported `async function persistAiSettings(userId: string, input: { provider: AiProvider; model?: string; apiKey?: string })` returning the same shape; `saveAiSettings` calls it. Add `revalidatePath("/capture")` and `revalidatePath("/onboarding/wizard")` next to the existing revalidations in the persist path. Add:
   ```ts
   export async function verifyAndSaveAiKey(input: { provider: AiProvider; apiKey: string; model?: string }):
     Promise<{ ok: true; provider: AiProvider; model: string; embeddingReset: boolean }
           | { ok: false; reason: ProbeReason; message: string }>
   ```
   Steps: `requireUserId`; validate with zod (provider enum via `resolveAiProvider`, key trimmed length 8–512) → `{ ok:false, reason:"invalid", message:"That doesn't look like an API key." }`; `takeToken(\`verify:${userId}\`, { max: 6, windowMs: 60_000 })` else `{ ok:false, reason:"throttled", message:"Too many attempts — wait a minute and try again." }`; `probeAiKey(provider, key, resolveAiModel(provider, input.model))`; on ok call `persistAiSettings`. Never persist on failure.
4. `scripts/smoke-ai-key-probe.ts` (no DB, no network): feed synthetic errors shaped like the SDKs' 401/403, 404, ECONNREFUSED/timeout to `probeReasonFromError` and assert `invalid`, `no_access`, `network`; assert a synthetic 429 through the same classification path yields the ok branch (export a small pure helper if needed so the 429→ok rule is testable without network); assert `takeToken` allows `max` calls then refuses, and allows again after the window (use a small `windowMs`).

**Verification.** tsc; eslint; `npx tsx scripts/smoke-ai-key-probe.ts`. Commit.

---

### Task 5: `GeminiKeyGuide`, `AiKeyPanel`, and the walls

**Goal.** One reusable key panel, shown inline wherever the user hits the AI wall, and in Settings.

**Files.** new `src/components/settings/gemini-key-guide.tsx`, new `src/components/settings/ai-key-panel.tsx`, `src/components/settings/ai-settings.tsx`, `src/components/chat/bulk-notes-panel.tsx`, `src/app/(app)/(main)/chat/page.tsx`, `src/components/chat/chat-panel-lazy.tsx`, `src/components/chat/chat-panel.tsx`, `src/lib/errors.ts`, `src/lib/ai.ts`.

**Steps.**
1. `gemini-key-guide.tsx`: copy the structure of `src/components/imports/linkedin-export-guide.tsx` (Dialog, numbered `<ol>`, `GuideImage` with `onError` that hides a missing image, footer external link). Export `GEMINI_KEY_URL`. Verify the Google AI Studio API-key page URL with a WebFetch; if you cannot verify, use `https://aistudio.google.com/apikey` and say so in your report. Steps: (1) "Open Google AI Studio and sign in with any Google account." (2) "Click Create API key. Pick any project — the default is fine." (3) "Copy the key and paste it into Orbit. It stays encrypted and only your account uses it." Image paths `/guides/gemini/key-1.png` … `key-3.png`; do not add image files — the component must degrade to text when they are missing.
2. `ai-key-panel.tsx` (`"use client"`):
   ```ts
   export function AiKeyPanel(props: {
     variant: "settings" | "inline" | "wizard";
     initialProvider?: AiProvider;   // default "gemini"
     initialModel?: string;
     providers?: Array<{ id: AiProvider; label: string; hasPersonalKey: boolean; usingEnv: boolean }>; // settings variant status line
     onVerified?: (r: { provider: AiProvider; model: string }) => void;
     onSkip?: () => void;            // wizard variant renders a ghost "Skip for now"
     className?: string;
   })
   ```
   Heading: settings → "AI key"; inline/wizard → "Turn on AI". Sub-line: `"Gemini is free to get and takes about a minute."` A "Show me how" button opening `GeminiKeyGuide`. Password `Input` (`autoComplete="off"`, placeholder from `AI_PROVIDERS`). Primary button "Verify and save" with states: checking (spinner, disabled) → saved (check icon, "Saved") → error (reason message under the input, `role="alert"`). `<details>` "Advanced" containing the provider `<select>` and the model select/custom input lifted from `ai-settings.tsx:44-141`, plus the Anthropic embeddings note (:77-82) reworded to `"Anthropic can't power search. Keep a Gemini or OpenAI key too so Chat can find people."` Calls `verifyAndSaveAiKey`; on ok → `toast.success("AI is on")`, `onVerified?.()`, `router.refresh()`. Inline/wizard variants use the card chrome `rounded-2xl border border-border/70 bg-card p-5`.
3. `ai-settings.tsx`: render `<AiKeyPanel variant="settings" providers={settings.providers} initialProvider initialModel onVerified={() => refetch getSettings()} />` and keep only the "Saved keys" list and "Clear personal key" button (:177-202) below it. Status string `Using local ${envVar} (dev only)` (:72) stays dev-only but reads `"Using a local key (dev only)"`.
4. Capture wall: replace the amber banner in `bulk-notes-panel.tsx:322-338` with `<AiKeyPanel variant="inline" onVerified={() => setHasApiKey(true)} />` (the state setter already exists; the `useEffect` at :130-134 re-syncs from the server prop after refresh).
5. Chat wall: `src/app/(app)/(main)/chat/page.tsx` becomes async, calls `getSettings()` and passes `hasApiKey={settings.hasApiKey}` through `chat-panel-lazy.tsx` to `ChatPanel`. In `ChatPanel` hold `const [hasApiKey, setHasApiKey] = useState(props.hasApiKey)` (re-sync from the prop in an effect); render `<AiKeyPanel variant="inline" onVerified={() => setHasApiKey(true)} />` inside the empty state (:453-463) when `!hasApiKey`, above the suggestion chips; in the `askNetwork` catch and `!res.ok` branch (:292-298), `if (isMissingAiApiKeyError(message)) setHasApiKey(false)`.
6. Copy: `src/lib/errors.ts:3` → `"Orbit needs an AI key for this — add a free Gemini API key (about a minute)."`; `:72` → keep meaning, must contain "API key". `src/lib/ai.ts:229,280,290,308,800` "Add your own key in Settings" phrasing → `"Add a free Gemini API key under Settings → AI key"` (read each; keep "API key").

**Verification.** tsc; eslint. Manual: `/capture` with no key shows the panel; a bad key shows the rejected message and nothing persists; a real key (if you have one in env — otherwise stop at the rejected case and say so) flips the extract button without reload; `/chat` empty state shows the panel; `/settings` AI section renders the panel plus Saved keys. Commit.

---

### Task 6: Optional `ai-key` wizard step

**Files.** `src/components/onboarding/wizard/setup-wizard.tsx`, new `wizard-ai-key.tsx`, `src/actions/onboarding-wizard.ts`, `wizard-review.tsx`, `wizard-capture.tsx`.

**Steps.**
1. Add `"ai-key"` to `WizardStep`, `STEP_TITLES["ai-key"] = "Turn on AI (optional)"`, and `WIZARD_STEP_IDS`.
2. In `SetupWizard` hold `const [aiOn, setAiOn] = useState(hasApiKey)`. `WizardTriage onDone={() => goTo(aiOn ? "review" : "ai-key")}`.
3. New `wizard-ai-key.tsx`: pitch paragraph `"So Orbit can draft follow-ups and answer questions about the people you just added."` then `<AiKeyPanel variant="wizard" onVerified={() => { setAiOn(true); addResult({ kind: "ai-key" }); goTo("review"); }} onSkip={() => goTo("review")} />` (wire through props).
4. `WizardCapture` gets an `onKeyVerified` prop forwarded into `BulkNotesPanel`'s inline panel `onVerified` so the Capture path also calls `setAiOn(true)` (add a passthrough prop `onApiKeyVerified?: () => void` to `BulkNotesPanel`).
5. `wizard-review.tsx`: `{ kind: "ai-key" }` → `"AI is on."`

**Verification.** tsc; eslint. Manual: wizard with no key → after triage the AI step appears with Skip; with a key it is skipped. Commit.

---

### Task 7: LinkedIn deferral — request now, remind me tomorrow

**Files.** `src/db/schema.ts`, `src/db/index.ts`, new `src/actions/linkedin-export.ts`, new `src/lib/reminder-links.ts`, `src/actions/reminders.ts`, `src/components/reminders/reminder-card.tsx`, `src/components/dashboard/reminder-row.tsx`, new `src/components/onboarding/wizard/wizard-linkedin-later.tsx`, `setup-wizard.tsx`, `src/actions/onboarding-wizard.ts`, `wizard-review.tsx`, new `src/components/imports/linkedin-export-nudge.tsx`, `src/app/(app)/(main)/imports/page.tsx`, `src/components/dashboard/dashboard-sections.tsx`.

**Steps.**
1. Column `linkedin_export_requested_at timestamptz` on `user_settings`: schema (`linkedinExportRequestedAt: timestamp("linkedin_export_requested_at", { withTimezone: true })` next to `wizardOfferedAt`), Neon alters, PGlite `ensureColumn`, `SCHEMA_VERSION = 19`, `npx tsx scripts/smoke-schema-ddl.ts --update` then plain.
2. `src/actions/linkedin-export.ts` (`"use server"`): `markLinkedInExportRequested(): Promise<{ requestedAt: string }>` (stamps now if null; returns the existing stamp otherwise); `scheduleLinkedInExportReminder(): Promise<{ reminderId: string; dueDate: string }>` — idempotent: return the existing pending reminder with `reminderType === "linkedin_export"` for the user if one exists, else insert (`userId`, `listId: await getInboxListId(userId)` — import from wherever `createReminder` gets it, `title: "Upload your LinkedIn export to Orbit"`, `description: "LinkedIn emails a download link within about a day. Open Imports and drop the ZIP in."`, `dueDate: now + 24h`, `reminderType: "linkedin_export"`, `actionKind: "task"` if that kind exists in `ReminderActionKind` else the closest task-like kind, `createdBy: "user"`, `status: "pending"`), also stamp `requestedAt` if null, then `revalidateReminderPaths()` and `revalidatePath("/imports")`; `getLinkedInExportStatus(): Promise<{ requestedAt: string | null; hasLinkedInImport: boolean }>` where `hasLinkedInImport` = an `imports` row for the user with `importType` in `[LINKEDIN_IMPORT_TYPE, LINKEDIN_MESSAGES_IMPORT_TYPE]` (`src/lib/import-adapters/linkedin-connections.ts:12`, `linkedin-messages.ts:13`); `dismissLinkedInExportNudge(): Promise<void>` nulls the column and revalidates `/imports` and `/dashboard`.
3. `src/lib/reminder-links.ts` (pure): `export function reminderHref(r: { reminderType?: string | null; contactId?: string | null }): string` → `"linkedin_export"` → `/imports`; contactId → `/contacts/{id}`; else `/reminders`. Use it in `listNotificationPanel` (`src/actions/reminders.ts:766`), in `reminder-card.tsx` (add an "Open Imports" link action for this type), and in `dashboard/reminder-row.tsx` wherever it builds the contact link.
4. `wizard-linkedin-later.tsx`: buttons "Request export on LinkedIn" (`<a target="_blank" rel="noopener noreferrer" href={LINKEDIN_DATA_URL}>` from `linkedin-export-guide.tsx`, onClick → `markLinkedInExportRequested()`), "Remind me tomorrow" (→ `scheduleLinkedInExportReminder()` → `toast.success("We'll remind you tomorrow")`), "I already have the file" (→ `goTo("import")`), and "Continue" (→ triage). Include the one-line explanation `"LinkedIn builds the export in the background and emails you a link, usually within a day."`
5. `setup-wizard.tsx`: add `"linkedin-later"` (`STEP_TITLES`: "LinkedIn (takes a day)"); `PATHS` LinkedIn entry now routes to `linkedin-later` with `title: "LinkedIn (takes a day)"`, `description: "Request your export now; Orbit reminds you to upload it tomorrow."`; the `import` step stays reachable from "I already have the file". Update `WIZARD_STEP_IDS`. `wizard-review.tsx`: `{ kind: "linkedin-requested" }` → `"LinkedIn export requested — reminder set for tomorrow."` (added when "Remind me tomorrow" succeeds; "Request export" alone adds `{ kind: "linkedin-requested-no-reminder" }` → `"LinkedIn export requested."`).
6. `linkedin-export-nudge.tsx` (client, takes `requestedAt: string`): card `"LinkedIn export requested {date} — upload it here when it arrives."` with a Dismiss button calling `dismissLinkedInExportNudge()`. Render in `imports/page.tsx` above the hub and in `dashboard-sections.tsx` `StatsSection` after the empty-state block, in both cases only when `requestedAt && !hasLinkedInImport && requestedAt` is less than 30 days old (compute on the server with `getLinkedInExportStatus()`).

**Verification.** tsc; eslint; `npx tsx scripts/smoke-schema-ddl.ts`. Manual: wizard LinkedIn path → "Remind me tomorrow" → `/reminders` shows the task due tomorrow whose link opens `/imports`; nudge visible on dashboard and imports; Dismiss hides it. Commit.

---

### Task 8: ZIP everywhere

**Files.** new `src/lib/csv-archive.ts`, `src/components/imports/import-utils.tsx`, `src/components/imports/linkedin-connections-import.tsx`, `src/components/imports/linkedin-export-guide.tsx`, new `scripts/smoke-csv-archive.ts`.

**Steps.**
1. `src/lib/csv-archive.ts` (client-safe; dynamic `import("jszip")` as today):
   ```ts
   export const CONNECTIONS_ENTRY = /(^|\/)connections\.csv$/i;
   export const MESSAGES_ENTRY = /(^|\/)messages\.csv$/i;
   export async function readCsvFromArchive(file: File, opts: { entryPattern: RegExp; fallbackName: string; missingMessage: string }):
     Promise<{ text: string; fileName: string; siblingCsvs: string[] }>
   ```
   Non-ZIP files return `file.text()`. When no entry matches, throw `Error(\`${missingMessage} This ZIP has: ${csvNames.join(", ") || "no CSV files"}. LinkedIn splits big archives into parts — Connections is usually in Part 1.\`)`.
2. `import-utils.tsx`: `readCsvOrZipMessages` becomes a one-line wrapper over the new reader with `MESSAGES_ENTRY`, fallback `"messages.csv"`, message `"No messages.csv found in ZIP. Export Messages from LinkedIn."`
3. `linkedin-connections-import.tsx`: `accept=".csv,.zip,text/csv,application/zip"` (:86); replace `file.text()` (~:98) with `readCsvFromArchive(file, { entryPattern: CONNECTIONS_ENTRY, fallbackName: "Connections.csv", missingMessage: "No Connections.csv found in that ZIP." })`; if `siblingCsvs` contains a messages.csv, `toast.message("Also found messages.csv — upload the same ZIP on the Messages tab to see who you actually talk to.")`. Update the picker's helper copy to say the ZIP works.
4. `linkedin-export-guide.tsx`: add a `CONNECTIONS_FINAL` step `"Upload the ZIP LinkedIn emailed you — Orbit finds Connections.csv inside."` beside `MESSAGES_FINAL` (:50-53) and use it for the connections variant.
5. `scripts/smoke-csv-archive.ts` (no DB): build ZIPs with `JSZip.generateAsync` and wrap them in `new File([...], "a.zip")` (Node ≥ 20 has `File`): connections only → text returned; messages only with the connections pattern → error message names messages.csv; both → `siblingCsvs` includes messages.csv; a plain `.csv` File → text passthrough.

**Verification.** tsc; eslint; `npx tsx scripts/smoke-csv-archive.ts`; `npx tsx scripts/smoke-parsers.ts`. Commit.

---

### Task 9: Progressive nav until the first contact

**Files.** `src/lib/surfaces.ts`, `src/lib/onboarding.ts`, `src/app/(app)/layout.tsx`, `src/components/layout/app-shell.tsx`, `scripts/smoke-surface-visibility.ts`.

**Steps.**
1. `src/lib/surfaces.ts` (pure, client-safe): `export const QUIET_UNTIL_FIRST_CONTACT = ["page.graph", "page.outreach", "page.knowledge"] as const;` with a comment: hidden from the nav (not blocked) until the account has a contact; empty the array to disable.
2. `src/lib/onboarding.ts`: `export const hasAnyContacts = cache(async (userId: string) => Boolean(await db.query.contacts.findFirst({ where: eq(contacts.userId, userId), columns: { id: true } })))` and reuse it inside `needsOnboarding` (:41-44) so the two share one request-cached lookup.
3. `src/app/(app)/layout.tsx:92-95`: add `hasAnyContacts(userId)` to the `Promise.all`; pass `quiet={seeded ? [] : [...QUIET_UNTIL_FIRST_CONTACT]}` to `AppShell`.
4. `app-shell.tsx`: new prop `quiet: string[]`; `navHidden = new Set([...hidden, ...quiet])` passed as `hidden` to `AppSidebar` (:115-122) and `MobileNav` (~:177-181) only. Keep `hiddenSet` for `showAskBar` and everything else. Do not touch `hiddenForUsers`, the route guard in `(main)/layout.tsx`, or `ViewAsUserBanner`.
5. `scripts/smoke-surface-visibility.ts`: extend its registry checks — every `QUIET_UNTIL_FIRST_CONTACT` key resolves via `getSurface` to a `page` surface, none is `alwaysVisible`, and none maps to an href in `MOBILE_BOTTOM_NAV`. Read the script's SAFETY banner and obey it (no remote DB).

**Verification.** tsc; eslint; `npx tsx scripts/smoke-surface-visibility.ts`. Manual: an account with 0 contacts sees no Constellation/Outreach/Knowledge in the sidebar or mobile More; `/graph` by URL still renders; after adding a contact and refreshing, the items return. Commit.

---

### Task 10: One `EmptyOrbit` block and per-surface one-liners

**Files.** new `src/components/empty-orbit.tsx`, `src/components/dashboard/dashboard-sections.tsx`, `src/components/contacts/contacts-list.tsx`, `src/app/(app)/(main)/contacts/page.tsx`, `src/app/(app)/(main)/chat/page.tsx`, `src/components/chat/chat-panel-lazy.tsx`, `src/components/chat/chat-panel.tsx`, `src/components/knowledge/knowledge-base-view.tsx`, `src/components/graph/network-graph.tsx` (find the real path), `src/components/reminders/reminders-view.tsx`, `src/components/dashboard/suggested-outreach-card.tsx`, `src/components/dashboard/reminders-dashboard-card.tsx`.

**Steps.**
1. `empty-orbit.tsx` (no `"use client"`, no hooks; `Link` + `buttonVariants`): `export const EMPTY_ORBIT_ACTIONS = [{ href: "/imports", label: "Import from Google", primary: true }, { href: "/capture", label: "Paste notes" }, { href: "/contacts/new", label: "Add one person" }] as const;` and `export function EmptyOrbit({ compact, hint, showSetupLink }: { compact?: boolean; hint?: string; showSetupLink?: boolean })`. Default heading `"Your orbit is empty"`, body `"Bring in the people you already know. Orbit remembers them and tells you when to reach out."`, the three actions, and when `showSetupLink` a tertiary link "Run guided setup" → `/onboarding/wizard`. `compact` drops the heading size and padding. Card: `rounded-2xl border border-dashed border-border/70`.
2. `dashboard-sections.tsx:65-98` → `<EmptyOrbit showSetupLink />`; the "Recently updated" empty block (~:314-337) keeps only the hint `"People you add will show up here."`
3. `contacts/page.tsx` passes `hasContacts={await hasAnyContacts(userId)}` (from `@/lib/onboarding`); `contacts-list.tsx:365-378`: when `!hasContacts` render `<EmptyOrbit compact />`, otherwise keep the filtered-empty message and change "import LinkedIn" → "import people".
4. Chat: `chat/page.tsx` (already async after Task 5) also passes `hasContacts`; `ChatPanel` renders `<EmptyOrbit compact hint="Chat answers from your own contacts — add a few people first." />` in the empty state when `!hasContacts` (the AI-key panel from Task 5 still shows when `!hasApiKey`; order: EmptyOrbit first).
5. `knowledge-base-view.tsx:126-137` → `<EmptyOrbit compact hint="Notes, messages, and summaries about your people will appear here." />`; `:128,136` "Import LinkedIn" → "Import contacts".
6. `network-graph.tsx` empty sky (~:1428-1444): keep the dark card; copy `"Your sky is empty — add people and they appear as stars."`; render the first two `EMPTY_ORBIT_ACTIONS` with the card's existing light-on-dark classes.
7. `reminders-view.tsx:~113` → `"Nothing here yet. Set a reminder, or let Orbit suggest follow-ups once you've logged a few conversations."`; `suggested-outreach-card.tsx:~61` → `"No one to reach out to yet — once you add people, Orbit watches for who's gone quiet."`; `reminders-dashboard-card.tsx:~53` → `"Nothing due. Follow-ups Orbit suggests will land here."`

**Verification.** tsc; eslint. Manual on a 0-contact account: dashboard, contacts, chat, knowledge, graph, reminders all show the new copy; Google is the primary CTA everywhere. Commit.

---

### Task 11: Imports page — Google first, drop zone, user-facing Retry

**Files.** `src/components/imports/import-hub.tsx`, `src/app/(app)/(main)/imports/page.tsx`, `src/components/imports/import-utils.tsx`, `src/lib/import-job-dispatch.ts`, `src/lib/admin-operations.ts`, `src/actions/imports.ts`, `src/components/imports/import-history.tsx`.

**Steps.**
1. `import-hub.tsx:239-251` connections panel order: `GoogleContactsImport`, `OutlookContactsImport`, then a disclosure (`<button aria-expanded aria-controls>` + `ChevronDown`, `useState`) titled `"Have a LinkedIn export?"` with sub-copy `"Upload the ZIP or Connections.csv LinkedIn emailed you — exports take about a day."` wrapping `LinkedInConnectionsImport`; `defaultOpen` when `job?.kind === "connections"`. Tab label "Connections" → "People" (:56). `imports/page.tsx:34-40` header sub-copy → `"Bring in the people you already know — from Google, Outlook, or a LinkedIn export."`
2. `ImportFilePicker` (`import-utils.tsx:51-101`): the root becomes a dashed drop zone (`rounded-xl border border-dashed border-border/70 p-4`, `data-dragging` → `border-primary/60 bg-accent/50`) with `onDragOver/onDragLeave/onDrop`; on drop validate `dataTransfer.files[0]` against `accept` (extension or MIME) → `onFile`, else `toast.error("That file type isn't supported here.")`; caption `"or drop a file here"` (`hidden sm:inline`). The existing Button remains the only focusable control; the wrapper is a `div`.
3. Retry: `src/lib/import-job-dispatch.ts` add `export function isResumableImportType(type: string): boolean` and `export async function rearmImportJob(importId: string): Promise<void>` (the `status: "processing", errorMessage: null, updatedAt` update now inline at `admin-operations.ts:210-213`); `admin-operations.ts retryImport` uses both after its audit. `src/actions/imports.ts` add `export async function retryImport(importId: string): Promise<{ ok: true } | { ok: false; error: string }>`: `requireUserId` → `imports.findFirst` by id + userId → require `status === "failed"` and `isResumableImportType` → `rearmImportJob` → `after(() => runImportJobById(importId).catch(() => {}))` (same shape as `startLinkedInImport`) → `revalidatePath("/imports")`. `imports/page.tsx` maps history rows to add `canRetry: status === "failed" && isResumableImportType(importType)` server-side.
4. `import-history.tsx`: Retry button (`RotateCw`, outline sm, `useTransition`) on rows with `canRetry` → `toast.success("Retrying — Orbit picks up where it stopped.")` + `router.refresh()`; `SOURCE_META` gains human labels + icons for `google_contacts` ("Google Contacts") and `outlook_contacts` ("Outlook Contacts") so :100 never prints a raw type id; status badges → "In progress" / "Done" / "Failed" / "Stopped"; empty copy (:73-76) → `"No imports yet. Connect Google or Outlook above, or upload a LinkedIn export."`

**Verification.** tsc; eslint; `npx tsx scripts/smoke-import-resumption-auth.ts` and `smoke-import-engine.ts` still pass. Manual: People tab shows Google first and LinkedIn collapsed; dragging a CSV onto the picker loads it; Tab reaches "Choose file"; a failed resumable import shows Retry and flips to In progress. Commit.

---

### Task 12: Calendar, extension promo, settings placement, leaked internals

**Files.** `src/components/imports/calendar-import-section.tsx`, `src/components/imports/calendar-subscribe-panel.tsx`, `src/components/notifications/extension-promo.tsx`, `src/components/settings/sections.ts`, `src/app/(app)/settings/page.tsx`, `src/components/knowledge/knowledge-base-view.tsx`, `src/components/dashboard/dashboard-header.tsx`.

**Steps.**
1. Calendar (Pro users only reach it): in `calendar-import-section.tsx` wrap `CalendarSubscribePanel` in a collapsed disclosure titled `"Advanced: keep a calendar in sync"` (same disclosure pattern as Task 11). Rewrite `calendar-subscribe-panel.tsx:55-65` without `<code>` fragments: `"Paste your calendar's secret iCal link. In Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format. Orbit checks it for 1:1 and networking meetings and skips standups."` Leave the free-plan `LockedFeature` in `import-hub.tsx` as is.
2. `extension-promo.tsx:19-21`: `const STORE_URL = process.env.NEXT_PUBLIC_EXTENSION_URL;` and render `null` when it is unset (in addition to the existing dismissed check). Remove the Web Store search fallback.
3. Settings: `sections.ts` label "AI provider" → "AI key" and move that entry to index 1 (right after Profile); move the matching `<Section id="settings-ai">` in `settings/page.tsx` to the same position (JSX order is manual and must match the rail).
4. `knowledge-base-view.tsx:~107` "Searchable chunks" → "Search index".
5. `dashboard-header.tsx:12-17`: wrap the ⌘K hint in `hidden md:inline`.

**Verification.** tsc; eslint; `npx tsx scripts/smoke-surface-visibility.ts` (surface keys derive from section ids and must be unchanged). Manual: Settings rail shows AI key second and scrolls correctly; no extension promo in the notifications panel with the env unset; the calendar panel is collapsed on the Calendar tab. Commit.

---

### Task 13: In-app Help

**Files.** new `src/components/help/help-faq.ts`, new `src/components/help/help-sheet.tsx`, `src/components/layout/app-sidebar.tsx`, `src/components/layout/mobile-nav.tsx`, `src/components/settings/help-settings.tsx`.

**Steps.**
1. `help-faq.ts`: `export const HELP_FAQ: Array<{ q: string; a: string; href?: string; cta?: string }>` with exactly:
   - "How do I get people into Orbit?" / "Connect Google Contacts or Outlook on Imports, paste notes into Capture, or add one person by hand. LinkedIn exports work too but take about a day." / `/imports` / "Open Imports"
   - "Why does Orbit ask for an AI key?" / "Orbit uses your own AI account to read notes, draft follow-ups, and answer questions. Your data goes to a provider you chose, and Orbit never bills you for it. Most people spend under a dollar a month." / `/settings#settings-ai` / "Add a key"
   - "What does Orbit do with my data?" / "Contacts stay in your account, keys are encrypted, and you can export or delete everything under Data and privacy." / `/settings#settings-data` / "Data and privacy"
   - "I imported a file and nothing happened." / "Imports run in the background — check Import history at the bottom of Imports. A failed import has a Retry button." / `/imports` / "Open Imports"
   - "Can I see the tour again?" / "Yes — replay it any time from Settings → Help." / `/settings#settings-help` / "Open Help settings"
2. `help-sheet.tsx` (`"use client"`): a `?` icon `Button` (`aria-label="Help"`, `HelpCircle` icon) opening a `Sheet` (side right) titled "Help" listing the FAQ as `<details>` items with the CTA link. Export `HelpSheet` and a `HelpFaqList` used by `HelpSettings`.
3. Mount `HelpSheet` in the sidebar footer (`app-sidebar.tsx:~179-196`, beside the account control, icon-only at the narrow width) and in the mobile More sheet footer (`mobile-nav.tsx:~404-420`). `HelpSettings` renders `<HelpFaqList />` under its two buttons.

**Verification.** tsc; eslint. Manual: `?` opens the sheet on desktop and from mobile More; each CTA navigates; Settings → Help shows the list. Commit.

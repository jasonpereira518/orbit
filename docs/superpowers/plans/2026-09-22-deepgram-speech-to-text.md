# Deepgram Speech-to-Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deepgram the first speech-to-text engine for meetings, the chat mic and voice notes — on Orbit's key, metered per plan — with Whisper and Gemini kept as fallbacks on the user's own key, and meetings restricted to Pro and Lifetime.

**Architecture:** One server module owns the Deepgram key and mints 30-second tokens; the browser opens its own live Deepgram connection for meetings and dictation, and the server calls Deepgram's file API for voice notes and recovery. A `speech_usage` table meters audio seconds against two monthly caps. Nothing goes through the LLM key gate (`ai-access.ts`), which is BYOK-only and switched off for managed keys.

**Tech Stack:** Next.js App Router (server actions + route handlers), Drizzle ORM on Postgres/Neon (PGlite locally), React 19 client components, Web Audio (`AudioWorklet`) capture, `tsx` smoke scripts as the test suite.

**Spec:** `docs/superpowers/specs/2026-09-22-deepgram-speech-to-text-design.md` — read it before Task 1. Every task below argues from it.

## Global Constraints

- **Branch:** `claude/deepgram-speech`, cut from `main` at `5e892e2d`. Commit after every task.
- **Schema version:** bump `SCHEMA_VERSION` in `src/db/index.ts` from `86` to **87** exactly once (Task 4). Before bumping, re-scan every remote branch and local worktree for a rival claim: `for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "$b:src/db/index.ts" 2>/dev/null | grep -m1 -E '^export const SCHEMA_VERSION' ; done | sort -u`. If 87 is taken, use the next free integer and say so in the changelog comment.
- **New DB columns must appear in BOTH** `ensureColumn(...)` in `migratePglite` and the `alters` array. `scripts/smoke-schema-ddl.ts` enforces this. Entries in `alters` must be single-statement, single-line backticked strings.
- **No backticks and no semicolons inside comments** in the `CREATE TABLE` template literal in `src/db/index.ts` — it is split on `;` by a quote-unaware splitter.
- **Every new smoke script must be registered** in the `MANIFEST` in `scripts/run-smoke.ts` with tier `"pure"`, `"pglite"` or `"manual"`, or `npm run test:check` fails. Any `pglite`-tier script must begin with `import "./smoke/_env";` as its first import.
- **Every `process.env.X` added under `src/` must appear in `.env.example`** as `X=` or `#X=`, enforced by `scripts/smoke-env-documented.ts`.
- **Error copy** goes through `friendlyError` / `UserFacingError`; never surface `err.message` raw. `scripts/smoke-toast-copy.ts` enforces the voice repo-wide.
- **Plan ids** are `"free" | "orbit" | "lifetime"` (`orbit` is Pro). Meetings are for `orbit` and `lifetime`.
- **Limits (audio seconds):** meeting — free `0`, orbit `18_000`, lifetime `36_000`. shortform — free `3_600`, orbit `18_000`, lifetime `18_000`.
- **Deepgram request defaults:** `model=nova-3`, `smart_format=true`, `punctuate=true`, `encoding=linear16`, `sample_rate=16000`, `channels=1`; meetings add `diarize=true`, `interim_results=true`, `utterance_end_ms=1000`, `vad_events=true`, `tag=meeting:<sessionId>`.
- **Keyterms:** at most 50 terms and 500 Deepgram tokens per request; estimate one token per 4 characters and cut whole terms.
- **Verification before any "done" claim:** `npx tsc --noEmit`, `npx eslint <changed files>`, and the smoke scripts named in the task. Baseline is 0 eslint errors (~44 warnings), so any error is yours.
- **Never run smoke scripts against Neon.** `scripts/smoke/_env.ts` strips `DATABASE_URL` and provider keys; do not bypass it.
- **Stop any dev server for this worktree before running a `pglite`-tier script** — overlapping writers corrupt `.data/pglite`.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `src/lib/deepgram.ts` | Server-only. The only reader of `DEEPGRAM_API_KEY`. Token minting, file transcription. |
| `src/lib/deepgram-params.ts` | Pure. Query-string builder + keyterm shaping. No network, no env. |
| `src/lib/speech-limits.ts` | Pure. Per-plan caps and threshold maths (90%/100%). Client-safe. |
| `src/lib/speech-quota.ts` | Server. Reads/writes `speech_usage`, answers "how many seconds are left". |
| `src/lib/deepgram-live.ts` | Browser. Wraps one live Deepgram socket: open with token, push PCM, emit results. |
| `src/lib/speaker-map.ts` | Pure. Mic-vs-call loudness timeline + Deepgram word timings → speaker labels. |
| `src/app/api/speech/token/route.ts` | Dictation token endpoint. |
| `src/app/api/speech/usage/route.ts` | Records a finished dictation session's seconds (beacon). |
| `src/app/api/capture/meetings/[id]/stream-token/route.ts` | Meeting token endpoint (ownership + plan + quota). |
| `src/app/api/capture/meetings/[id]/segments/route.ts` | Live segment writes. |
| `src/app/api/ops/speech-usage/route.ts` | Nightly reconciliation against Deepgram's usage API. |
| `scripts/smoke-deepgram-params.ts` | pure |
| `scripts/smoke-speech-limits.ts` | pure |
| `scripts/smoke-speaker-map.ts` | pure |
| `scripts/smoke-speech-quota.ts` | pglite |
| `scripts/smoke-meeting-gate.ts` | pglite |
| `scripts/dev/deepgram-spike.ts` + `public/dev-deepgram-spike.html` | Task 1 only, deleted at the end of Task 1 |

**Modified files (by the task that owns the change)**

`src/lib/env.ts`, `.env.example`, `scripts/smoke-ai-access.ts` (Task 3) · `src/db/index.ts`, `src/db/schema.ts`, `src/lib/user-data.ts` (Task 4) · `src/lib/ai.ts`, `src/lib/ai-access.ts`, `src/lib/usage-events.ts`, `src/lib/ai-pricing.ts`, `scripts/smoke-friendly-error.ts` (Task 6) · `src/lib/rate-limit.ts` (Task 7) · `src/lib/use-dictation.ts` (Task 9) · `src/lib/entitlements.ts`, `src/lib/plan-guards.ts`, `src/actions/meetings.ts`, `src/app/api/capture/meetings/[id]/chunks/route.ts`, `src/app/(clerk)/(app)/(main)/capture/page.tsx`, `src/components/capture/meeting-capture-tab.tsx` (Task 10) · `src/lib/meeting-sessions.ts` (Tasks 11, 12) · `src/lib/use-meeting-recorder.ts` (Task 13) · `src/components/capture/meeting-capture-panel.tsx` (Task 14) · `src/lib/meeting-digest.ts` (Task 15) · `src/lib/public-routes.ts`, `.github/workflows/ops.yml` (Task 16) · `src/app/(site)/(docs)/privacy/page.tsx`, `src/components/pricing/plan-comparison.tsx`, `src/components/settings/ai-settings.tsx`, `docs/RUNBOOK.md`, `scripts/eval-ai.ts` (Task 17).

---

## Task 1: Spike — prove the token mechanics (THROWAWAY)

Everything else assumes three unknowns are resolved. Answer them first, with code that is deleted at the end of this task.

**Files:**
- Create (temporary): `scripts/dev/deepgram-spike.ts`, `public/dev-deepgram-spike.html`
- Modify: `docs/superpowers/specs/2026-09-22-deepgram-speech-to-text-design.md` (replace "Open questions" with the answers)

**Interfaces:**
- Consumes: nothing.
- Produces: written answers in the spec that Tasks 3, 8 and 14 depend on — specifically **how a browser WebSocket presents the token** (subprotocol array vs query parameter) and **whether a grant token authenticates the pre-recorded REST API**.

- [ ] **Step 1: Get a Deepgram key into the environment**

Ask the user for a Deepgram API key (they create it at console.deepgram.com) and have them put it in `.env.local` as `DEEPGRAM_API_KEY=...`. Do not print it, commit it, or pass it to a subagent.

- [ ] **Step 2: Write the spike script**

```ts
// scripts/dev/deepgram-spike.ts — THROWAWAY, deleted at the end of Task 1.
import { config } from "dotenv";
config({ path: ".env.local" });

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) { console.error("DEEPGRAM_API_KEY missing from .env.local"); process.exit(1); }

async function grant(ttlSeconds = 30) {
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });
  const body = await res.json();
  console.log("grant:", res.status, JSON.stringify(body));
  return body as { access_token: string; expires_in: number };
}

async function main() {
  const token = (await grant()).access_token;

  // Q1: does a grant token work on the pre-recorded REST API?
  const wav = Buffer.from(
    "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=", "base64",
  );
  const rest = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "audio/wav" }, body: wav },
  );
  console.log("rest with grant token:", rest.status, (await rest.text()).slice(0, 300));

  // Q2: node WebSocket with the subprotocol form the browser is limited to.
  const ws = new WebSocket("wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000", [
    "token", token,
  ]);
  ws.onopen = () => { console.log("ws open via subprotocol"); ws.close(); };
  ws.onerror = (e) => console.log("ws error via subprotocol:", String(e));
  ws.onclose = (e) => { console.log("ws close:", e.code, e.reason); process.exit(0); };
  setTimeout(() => { console.log("ws timed out"); process.exit(1); }, 15_000);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Run it and record the answers**

Run: `npx tsx scripts/dev/deepgram-spike.ts`
Record verbatim: the grant response shape, whether REST accepted the grant token, and whether the subprotocol form opened the socket (and with what close code if not).

- [ ] **Step 4: Prove it from a real browser**

Write `public/dev-deepgram-spike.html` with a button that fetches a token from a temporary inline route (or a pasted token), opens `new WebSocket(url, ["token", token])`, sends 2 s of silence as `Int16Array`, and logs every message. Start the dev server with `mcp__Claude_Browser__preview_start`, open the page, click the button, and read the console with `read_console_messages`. A browser cannot set an `Authorization` header on a WebSocket, so this step is what actually settles Q2. If the subprotocol form fails, try the `?access_token=` query form and record which one works.

- [ ] **Step 5: Answer the retention question**

Fetch `https://developers.deepgram.com/docs/data-privacy-compliance` and confirm what Deepgram retains by default for pay-as-you-go API requests, and whether any account setting is required to keep retention off. Record the answer and the URL.

- [ ] **Step 6: Write the answers into the spec and delete the spike**

Replace the spec's "Open questions" section with a "Spike findings (2026-xx-xx)" section stating: the exact browser auth form to use, whether REST accepts grant tokens (if it does not, `transcribeFile` uses the raw key server-side, which is already the plan), and Deepgram's retention default.

```bash
rm scripts/dev/deepgram-spike.ts public/dev-deepgram-spike.html
git add docs/superpowers/specs/2026-09-22-deepgram-speech-to-text-design.md
git commit -m "docs: record Deepgram spike findings"
```

---

## Task 2: Deepgram request parameters (pure)

**Files:**
- Create: `src/lib/deepgram-params.ts`, `scripts/smoke-deepgram-params.ts`
- Modify: `scripts/run-smoke.ts` (manifest)

**Interfaces:**
- Consumes: `collectVocabularyTerms` from `src/lib/transcription-vocabulary.ts` (not imported here; callers pass terms in).
- Produces:
  - `export const DEEPGRAM_MODEL = "nova-3"`
  - `export const MAX_KEYTERMS = 50`, `export const KEYTERM_TOKEN_BUDGET = 500`
  - `export function keytermsFor(terms: readonly string[]): string[]`
  - `export type ListenOptions = { live: boolean; diarize?: boolean; keyterms?: readonly string[]; tag?: string }`
  - `export function listenParams(opts: ListenOptions): URLSearchParams`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/smoke-deepgram-params.ts
/**
 * The Deepgram request shape, as pure data. No network, no env.
 * Run: npx tsx scripts/smoke-deepgram-params.ts
 */
import { keytermsFor, listenParams, MAX_KEYTERMS } from "../src/lib/deepgram-params";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

console.log("\nkeytermsFor");
check("no terms is an empty list", keytermsFor([]).length === 0);
check("keeps order", keytermsFor(["Priya Raman", "Stripe"])[0] === "Priya Raman");
check("caps the count", keytermsFor(Array.from({ length: 200 }, (_, i) => `Person${i}`)).length === MAX_KEYTERMS);
{
  const long = Array.from({ length: 50 }, () => "x".repeat(80));
  const out = keytermsFor(long);
  const tokens = out.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
  check("stays inside the token budget", tokens <= 500, `${tokens} tokens`);
  check("cuts whole terms", out.every((t) => t.length === 80));
}
check("drops blanks", keytermsFor(["", "  ", "Sara"]).length === 1);

console.log("\nlistenParams");
{
  const p = listenParams({ live: false });
  check("model is nova-3", p.get("model") === "nova-3");
  check("16k linear16 mono", p.get("encoding") === "linear16" && p.get("sample_rate") === "16000" && p.get("channels") === "1");
  check("smart formatting on", p.get("smart_format") === "true");
  check("a file request asks for no interim results", p.get("interim_results") === null);
  check("no diarization unless asked", p.get("diarize") === null);
}
{
  const p = listenParams({ live: true, diarize: true, keyterms: ["Priya Raman"], tag: "meeting:abc" });
  check("live asks for interim results", p.get("interim_results") === "true");
  check("live asks for utterance ends", p.get("utterance_end_ms") === "1000" && p.get("vad_events") === "true");
  check("diarization on", p.get("diarize") === "true");
  check("keyterms are repeated params", p.getAll("keyterm").join("|") === "Priya Raman");
  check("the tag rides along", p.get("tag") === "meeting:abc");
}
{
  const p = listenParams({ live: true, keyterms: ["A", "B"] });
  check("every keyterm gets its own param", p.getAll("keyterm").length === 2);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll Deepgram parameter checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-deepgram-params.ts`
Expected: FAIL — `Cannot find module '../src/lib/deepgram-params'`.

- [ ] **Step 3: Implement the module**

```ts
// src/lib/deepgram-params.ts
/**
 * How Orbit asks Deepgram to listen — as pure data, so the live path (browser)
 * and the file path (server) cannot drift apart.
 *
 * Keyterm prompting is the reason names come back spelled right. Deepgram caps a
 * request at 500 tokens across all keyterms and recommends 20-50 terms; we cut whole
 * terms rather than sending a truncated name, which would bias toward a word nobody said.
 */

export const DEEPGRAM_MODEL = "nova-3";
export const MAX_KEYTERMS = 50;
export const KEYTERM_TOKEN_BUDGET = 500;

/** Deepgram counts tokens, not characters. Four characters per token, rounded up, is the usual approximation. */
function tokenCost(term: string): number {
  return Math.ceil(term.length / 4);
}

export function keytermsFor(terms: readonly string[]): string[] {
  const out: string[] = [];
  let spent = 0;
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    if (out.length >= MAX_KEYTERMS) break;
    const cost = tokenCost(term);
    if (spent + cost > KEYTERM_TOKEN_BUDGET) break;
    out.push(term);
    spent += cost;
  }
  return out;
}

export type ListenOptions = {
  /** A websocket request; a file request otherwise. */
  live: boolean;
  diarize?: boolean;
  keyterms?: readonly string[];
  /** Rides into Deepgram's usage records, so a nightly job can reconcile one meeting. */
  tag?: string;
};

export function listenParams(opts: ListenOptions): URLSearchParams {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    smart_format: "true",
    punctuate: "true",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });
  if (opts.live) {
    params.set("interim_results", "true");
    params.set("utterance_end_ms", "1000");
    params.set("vad_events", "true");
  }
  if (opts.diarize) params.set("diarize", "true");
  for (const term of keytermsFor(opts.keyterms ?? [])) params.append("keyterm", term);
  if (opts.tag) params.set("tag", opts.tag);
  return params;
}
```

- [ ] **Step 4: Register the smoke script**

In `scripts/run-smoke.ts`, add to `MANIFEST` beside the other pure entries:

```ts
  "smoke-deepgram-params": "pure",
```

- [ ] **Step 5: Run it green, plus the registration check**

Run: `npx tsx scripts/smoke-deepgram-params.ts` → expect PASS.
Run: `npx tsx scripts/run-smoke.ts --check` → expect no missing-manifest error.
Run: `npx tsc --noEmit` and `npx eslint src/lib/deepgram-params.ts scripts/smoke-deepgram-params.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/deepgram-params.ts scripts/smoke-deepgram-params.ts scripts/run-smoke.ts
git commit -m "feat: Deepgram request parameters and keyterm shaping"
```

---

## Task 3: The Deepgram client and its key

**Files:**
- Create: `src/lib/deepgram.ts`
- Modify: `src/lib/env.ts`, `.env.example`, `scripts/smoke-ai-access.ts`

**Interfaces:**
- Consumes: `listenParams`, `keytermsFor` (Task 2).
- Produces:
  - `export function deepgramConfigured(): boolean`
  - `export function deepgramEnabled(): boolean` — false when `ORBIT_DEEPGRAM=off` or no key
  - `export async function mintStreamToken(opts: { ttlSeconds?: number }): Promise<{ accessToken: string; expiresIn: number }>`
  - `export type DeepgramFileResult = { text: string; seconds: number; requestId: string | null }`
  - `export async function transcribeFile(audio: { bytes: Uint8Array; mimeType: string }, opts: { keyterms?: readonly string[] }): Promise<DeepgramFileResult>`

- [ ] **Step 1: Write the module**

```ts
// src/lib/deepgram.ts
/**
 * Deepgram — Orbit's own speech-to-text key.
 *
 * THIS IS THE ONLY FILE THAT READS `DEEPGRAM_API_KEY`. The browser never sees it: live
 * transcription runs on 30-second grant tokens minted here (`mintStreamToken`), which are
 * good for opening one connection and nothing else.
 *
 * Deliberately NOT part of `ai-access.ts`. That gate arbitrates LLM provider keys, where the
 * rule is bring-your-own and Orbit's managed keys are Lifetime-only and currently switched
 * off. Deepgram is a hosted service Orbit pays for on every plan, like hosted Apollo
 * enrichment: entitlement plus quota, checked by the caller, recorded in `speech_usage`.
 */
import { listenParams } from "@/lib/deepgram-params";
import { UserFacingError } from "@/lib/errors";

const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_TTL_SECONDS = 30;
const FILE_TIMEOUT_MS = 90_000;

function apiKey(): string | null {
  return process.env.DEEPGRAM_API_KEY?.trim() || null;
}

export function deepgramConfigured(): boolean {
  return Boolean(apiKey());
}

/** The kill switch: `ORBIT_DEEPGRAM=off` reverts every surface to the Whisper/Gemini chain. */
export function deepgramEnabled(): boolean {
  if (process.env.ORBIT_DEEPGRAM?.trim().toLowerCase() === "off") return false;
  return deepgramConfigured();
}

function requireKey(): string {
  const key = apiKey();
  if (!key) throw new UserFacingError("Transcription isn't configured on this deployment.");
  return key;
}

export async function mintStreamToken(
  opts: { ttlSeconds?: number } = {},
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(GRANT_URL, {
    method: "POST",
    headers: { Authorization: `Token ${requireKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Deepgram grant failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Deepgram grant returned no token");
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? DEFAULT_TTL_SECONDS };
}

export type DeepgramFileResult = { text: string; seconds: number; requestId: string | null };

export async function transcribeFile(
  audio: { bytes: Uint8Array; mimeType: string },
  opts: { keyterms?: readonly string[] } = {},
): Promise<DeepgramFileResult> {
  const params = listenParams({ live: false, keyterms: opts.keyterms });
  const res = await fetch(`${LISTEN_URL}?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${requireKey()}`, "content-type": audio.mimeType || "audio/wav" },
    body: audio.bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Deepgram transcription failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    metadata?: { duration?: number; request_id?: string };
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return {
    text: body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "",
    seconds: Math.ceil(body.metadata?.duration ?? 0),
    requestId: body.metadata?.request_id ?? null,
  };
}
```

- [ ] **Step 2: Declare the environment variables**

In `src/lib/env.ts`, add to `EXPECTED_IN_PRODUCTION` with a comment in the style of its neighbours:

```ts
  // Unset, every voice note, meeting and dictation falls back to the user's own OpenAI or
  // Gemini key, and an account with neither cannot transcribe at all.
  "DEEPGRAM_API_KEY",
```

In `.env.example`, beside the other server keys:

```bash
# Speech-to-text on Orbit's key: voice notes, meeting transcription and the chat mic.
# Metered per plan (src/lib/speech-limits.ts). Without it, transcription falls back to the
# user's own OpenAI or Gemini key. Keys: console.deepgram.com
# DEEPGRAM_API_KEY=
# ORBIT_DEEPGRAM=off            # kill switch: revert every surface to Whisper/Gemini
```

- [ ] **Step 3: Extend the source guard so no other file can reach the key**

In `scripts/smoke-ai-access.ts`, inside `sourceGuard()`, add a constant beside `GATE` and extend two regexes:

```ts
const DEEPGRAM_CLIENT = "src/lib/deepgram.ts";
```

Add `DEEPGRAM_API_KEY` to the `envKey` alternation and `api\.deepgram\.com` to `providerHost`, then exempt the client itself in the two `if` lines that push offenders:

```ts
    if (envKey.test(code) && file !== "scripts/smoke-contact-brief.ts" && file !== DEEPGRAM_CLIENT)
      offenders.push(`${file}: reads an AI key from the environment`);
    if (providerHost.test(code) && file !== TYPESAFE_TRANSPORT && file !== DEEPGRAM_CLIENT)
      offenders.push(`${file}: talks to a provider host directly`);
```

- [ ] **Step 4: Prove the guard actually bites**

Temporarily add `const leak = process.env.DEEPGRAM_API_KEY;` to `src/lib/capture-ingest.ts`.
Run: `npx tsx scripts/smoke-ai-access.ts` → expect FAIL naming `src/lib/capture-ingest.ts`.
Remove the line. Re-run → expect PASS. This is the only evidence that the exemption is narrow rather than universal.

- [ ] **Step 5: Verify**

Run: `npx tsx scripts/smoke-env-documented.ts` → PASS (the key is in `.env.example`).
Run: `npx tsx scripts/smoke-ai-access.ts` → PASS.
Run: `npx tsc --noEmit` and `npx eslint src/lib/deepgram.ts src/lib/env.ts scripts/smoke-ai-access.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/deepgram.ts src/lib/env.ts .env.example scripts/smoke-ai-access.ts
git commit -m "feat: Deepgram client, key gating and source guard"
```

---

## Task 4: Schema 87 — usage table, speaker column, Wispr column dropped

**Files:**
- Modify: `src/db/schema.ts`, `src/db/index.ts`, `src/lib/user-data.ts`

**Interfaces:**
- Produces: `speechUsage` Drizzle table; `meetingTranscriptSegments.speaker`; `MeetingSegmentEngine` including `"deepgram"`; `usageEvents.provider` including `"deepgram"`.

- [ ] **Step 1: Re-check the version claim**

Run the branch scan from Global Constraints. Confirm 87 is unclaimed; if not, use the next free integer everywhere below.

- [ ] **Step 2: Add the Drizzle definitions**

In `src/db/schema.ts`, add beside the other capture tables:

```ts
/**
 * Metered speech-to-text on Orbit's key. One row per meeting session (updated as segments
 * land) or per short-form recording. Seconds, not requests: Deepgram bills per second and
 * the plan caps are hours.
 */
export const speechUsage = pgTable(
  "speech_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").$type<"meeting" | "shortform">().notNull(),
    seconds: integer("seconds").default(0).notNull(),
    source: text("source").$type<"stream" | "file">().notNull(),
    sessionId: uuid("session_id"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("speech_usage_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("speech_usage_session_uidx").on(t.sessionId),
  ]
);

export type SpeechUsageRow = typeof speechUsage.$inferSelect;
```

The unique index on `session_id` is what makes a meeting's usage one row that grows, rather than a row per segment batch. Postgres treats NULLs as distinct, so voice-note rows (with `session_id` null) are unaffected.

In the same file: add `speaker: text("speaker")` to `meetingTranscriptSegments`, change `MeetingSegmentEngine` to `"deepgram" | "whisper" | "gemini" | "silent"`, and add `"deepgram"` to the `usageEvents.provider` `$type<>` union. Delete nothing else.

- [ ] **Step 3: Add the DDL**

In `src/db/index.ts`'s schema template literal, add (no backticks, no semicolons in comments):

```sql
CREATE TABLE IF NOT EXISTS speech_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  kind text NOT NULL,
  seconds integer NOT NULL DEFAULT 0,
  source text NOT NULL,
  session_id uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

In `migratePglite`, beside the other `ensureColumn` calls:

```ts
  await ensureColumn(client, "meeting_transcript_segments", "speaker", "text");
```

In the `alters` array, as single lines:

```ts
  `CREATE TABLE IF NOT EXISTS speech_usage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, kind text NOT NULL, seconds integer NOT NULL DEFAULT 0, source text NOT NULL, session_id uuid, request_id text, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS speech_usage_user_created_idx ON speech_usage(user_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS speech_usage_session_uidx ON speech_usage(session_id)`,
  `ALTER TABLE meeting_transcript_segments ADD COLUMN IF NOT EXISTS speaker text`,
  `ALTER TABLE user_settings DROP COLUMN IF EXISTS wispr_api_key_encrypted`,
```

Remove the three surviving Wispr DDL sites: the `wispr_api_key_encrypted text` line in the `CREATE TABLE user_settings` block, its `ensureColumn` call, and its `ADD COLUMN IF NOT EXISTS` entry. Leave the `// 36 = …` changelog line alone — it is history.

- [ ] **Step 4: Bump the version with a changelog entry**

Immediately above `export const SCHEMA_VERSION = 86;`, in the established format:

```ts
// 87 = speech_usage, meeting_transcript_segments.speaker, and the Deepgram engine value;
// also drops user_settings.wispr_api_key_encrypted, retired with Wispr in #245 and kept
// until now so the removal and its migration were one version, not two. Rescanned against
// every remote branch and every local worktree on 2026-09-22: 87 was unclaimed.
```

Then `export const SCHEMA_VERSION = 87;`.

- [ ] **Step 5: Register the table for deletion**

In `src/lib/user-data.ts`, add `speechUsage` to the `activity` category: `own(speechUsage)` in `exports`, `speechUsage` in `counts`, and in `run`:

```ts
      await db.delete(speechUsage).where(eq(speechUsage.userId, userId));
```

- [ ] **Step 6: Run the schema tests**

Stop any dev server for this worktree first.
Run: `npx tsx scripts/run-smoke.ts --only smoke-schema-ddl smoke-schema-upgrade smoke-schema-fingerprint smoke-purge` → all PASS.
Run: `npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/index.ts src/lib/user-data.ts
git commit -m "feat(db): schema 87 — speech_usage, segment speakers, drop the Wispr column"
```

---

## Task 5: Quota — limits (pure) and accounting (DB)

**Files:**
- Create: `src/lib/speech-limits.ts`, `src/lib/speech-quota.ts`, `scripts/smoke-speech-limits.ts`, `scripts/smoke-speech-quota.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `Plan` from `@/lib/plan-limits`; `speechUsage` (Task 4).
- Produces:
  - `export type SpeechKind = "meeting" | "shortform"`
  - `export const SPEECH_LIMITS: Record<SpeechKind, Record<Plan, number>>`
  - `export function limitFor(kind: SpeechKind, plan: Plan): number`
  - `export function quotaState(used: number, limit: number): { remaining: number; fraction: number; warn: boolean; exhausted: boolean }`
  - `export function monthWindow(now: Date): { start: Date; resetsAt: Date }`
  - `export async function speechAllowance(userId: string, kind: SpeechKind): Promise<{ limit: number; used: number; remaining: number; resetsAt: Date; warn: boolean; exhausted: boolean }>`
  - `export async function recordSpeechSeconds(input: { userId: string; kind: SpeechKind; seconds: number; source: "stream" | "file"; sessionId?: string | null; requestId?: string | null }): Promise<void>`

- [ ] **Step 1: Write the failing pure test**

```ts
// scripts/smoke-speech-limits.ts
/**
 * Plan caps and threshold maths for Deepgram minutes. Pure: no DB, no clock beyond what is
 * passed in. Run: npx tsx scripts/smoke-speech-limits.ts
 */
import { SPEECH_LIMITS, limitFor, monthWindow, quotaState } from "../src/lib/speech-limits";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

console.log("\nlimits");
check("free gets no meeting minutes", limitFor("meeting", "free") === 0);
check("Pro gets 5 meeting hours", limitFor("meeting", "orbit") === 18_000);
check("Lifetime gets 10 meeting hours", limitFor("meeting", "lifetime") === 36_000);
check("free short-form is 60 minutes", limitFor("shortform", "free") === 3_600);
check("paid short-form is 300 minutes", limitFor("shortform", "orbit") === 18_000 && limitFor("shortform", "lifetime") === 18_000);
check("every plan is covered", Object.keys(SPEECH_LIMITS.meeting).length === 3);

console.log("\nquotaState");
{
  const fresh = quotaState(0, 18_000);
  check("nothing used is not a warning", fresh.remaining === 18_000 && !fresh.warn && !fresh.exhausted);
  const most = quotaState(16_300, 18_000);
  check("90.5% warns", most.warn && !most.exhausted, `${most.fraction}`);
  check("89% does not warn", !quotaState(16_000, 18_000).warn);
  const done = quotaState(18_000, 18_000);
  check("exactly at the cap is exhausted", done.exhausted && done.remaining === 0);
  check("over the cap never goes negative", quotaState(20_000, 18_000).remaining === 0);
  const none = quotaState(0, 0);
  check("a zero limit is exhausted, not a division by zero", none.exhausted && none.fraction === 1);
}

console.log("\nmonthWindow");
{
  const w = monthWindow(new Date("2026-09-22T18:30:00.000Z"));
  check("starts at the first of the month, UTC", w.start.toISOString() === "2026-09-01T00:00:00.000Z");
  check("resets on the first of the next month", w.resetsAt.toISOString() === "2026-10-01T00:00:00.000Z");
  const dec = monthWindow(new Date("2026-12-31T23:59:59.000Z"));
  check("december rolls into january", dec.resetsAt.toISOString() === "2027-01-01T00:00:00.000Z");
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll speech limit checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-speech-limits.ts` → FAIL, module not found.

- [ ] **Step 3: Implement the pure module**

```ts
// src/lib/speech-limits.ts
/**
 * What a plan may spend on Deepgram, in audio seconds.
 *
 * Seconds rather than requests, because Deepgram bills per second and the promise to the
 * user is hours. Two meters, not one: a meeting can run three hours and would otherwise eat
 * a shared pool that voice notes and the chat mic depend on.
 *
 * Client-safe: no DB, no env, no server imports.
 */
import type { Plan } from "@/lib/plan-limits";

export type SpeechKind = "meeting" | "shortform";

/** Warn once the month is this far gone. */
const WARN_AT = 0.9;

export const SPEECH_LIMITS: Record<SpeechKind, Record<Plan, number>> = {
  // Meetings are a paid feature: 5 h on Pro, 10 h on Lifetime.
  meeting: { free: 0, orbit: 18_000, lifetime: 36_000 },
  // Voice notes and the chat mic. Generous on purpose — this is an abuse ceiling, not a meter
  // anyone should watch.
  shortform: { free: 3_600, orbit: 18_000, lifetime: 18_000 },
};

export function limitFor(kind: SpeechKind, plan: Plan): number {
  return SPEECH_LIMITS[kind][plan];
}

export function quotaState(used: number, limit: number) {
  const remaining = Math.max(0, limit - used);
  const fraction = limit <= 0 ? 1 : Math.min(1, used / limit);
  return { remaining, fraction, warn: fraction >= WARN_AT && limit > 0, exhausted: remaining <= 0 };
}

/** The calendar month in UTC, matching how the managed-AI allowance already counts. */
export function monthWindow(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, resetsAt };
}
```

- [ ] **Step 4: Run it green**

Run: `npx tsx scripts/smoke-speech-limits.ts` → PASS.

- [ ] **Step 5: Write the failing DB test**

```ts
// scripts/smoke-speech-quota.ts
/**
 * Speech usage accounting against a throwaway PGlite database.
 * Run: npx tsx scripts/smoke-speech-quota.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { speechUsage, userSettings } from "../src/db/schema";
import { recordSpeechSeconds, speechAllowance } from "../src/lib/speech-quota";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

async function main() {
  const db = await getDb();
  await db.delete(speechUsage).where(eq(speechUsage.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER });

  console.log("\na free account");
  let allowance = await speechAllowance(USER, "meeting");
  check("has no meeting seconds", allowance.limit === 0 && allowance.exhausted);
  allowance = await speechAllowance(USER, "shortform");
  check("has 60 short-form minutes", allowance.limit === 3_600 && allowance.remaining === 3_600);

  console.log("\nrecording usage");
  await recordSpeechSeconds({ userId: USER, kind: "shortform", seconds: 90, source: "file" });
  allowance = await speechAllowance(USER, "shortform");
  check("spends what it recorded", allowance.used === 90 && allowance.remaining === 3_510);

  await recordSpeechSeconds({ userId: USER, kind: "shortform", seconds: 30, source: "file" });
  allowance = await speechAllowance(USER, "shortform");
  check("adds up across recordings", allowance.used === 120);

  console.log("\na meeting is one growing row");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  await recordSpeechSeconds({ userId: USER, kind: "meeting", seconds: 600, source: "stream", sessionId });
  await recordSpeechSeconds({ userId: USER, kind: "meeting", seconds: 900, source: "stream", sessionId });
  const rows = await db.select().from(speechUsage).where(eq(speechUsage.sessionId, sessionId));
  check("one row per session", rows.length === 1, `${rows.length} rows`);
  check("the row holds the high-water mark", rows[0]?.seconds === 900);

  await recordSpeechSeconds({ userId: USER, kind: "meeting", seconds: 400, source: "stream", sessionId });
  const after = await db.select().from(speechUsage).where(eq(speechUsage.sessionId, sessionId));
  check("a late, smaller report never lowers it", after[0]?.seconds === 900);

  console.log("\nanother user's usage is invisible");
  await recordSpeechSeconds({ userId: "someone-else", kind: "shortform", seconds: 3_000, source: "file" });
  allowance = await speechAllowance(USER, "shortform");
  check("still only this user's seconds", allowance.used === 120);

  await db.delete(speechUsage).where(eq(speechUsage.userId, "someone-else"));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll speech quota checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx tsx scripts/smoke-speech-quota.ts` → FAIL, `src/lib/speech-quota` not found.

- [ ] **Step 7: Implement the accounting module**

```ts
// src/lib/speech-quota.ts
/**
 * How many Deepgram seconds this account has left this month, and the recording of what it
 * spent.
 *
 * A meeting is ONE row that grows: segments arrive every few seconds and each carries the
 * meeting's audio position, so the row holds a high-water mark rather than a running sum. A
 * browser that dies mid-meeting therefore still counts the audio it used, and a retried
 * segment batch never double-charges. Voice notes get their own row each.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { speechUsage } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { limitFor, monthWindow, quotaState, type SpeechKind } from "@/lib/speech-limits";

export type SpeechAllowance = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: Date;
  warn: boolean;
  exhausted: boolean;
};

export async function speechAllowance(userId: string, kind: SpeechKind): Promise<SpeechAllowance> {
  const [db, entitlements] = await Promise.all([getDb(), getEntitlements(userId)]);
  const { start, resetsAt } = monthWindow(new Date());
  const rows = await db
    .select({ used: sql<number>`coalesce(sum(${speechUsage.seconds}), 0)` })
    .from(speechUsage)
    .where(
      and(
        eq(speechUsage.userId, userId),
        eq(speechUsage.kind, kind),
        gte(speechUsage.createdAt, start),
      ),
    );
  const used = Number(rows[0]?.used ?? 0);
  const limit = limitFor(kind, entitlements.plan);
  return { limit, used, resetsAt, ...quotaState(used, limit) };
}

export async function recordSpeechSeconds(input: {
  userId: string;
  kind: SpeechKind;
  seconds: number;
  source: "stream" | "file";
  sessionId?: string | null;
  requestId?: string | null;
}): Promise<void> {
  const seconds = Math.max(0, Math.round(input.seconds));
  if (!seconds) return;
  const db = await getDb();
  if (!input.sessionId) {
    await db.insert(speechUsage).values({
      userId: input.userId,
      kind: input.kind,
      seconds,
      source: input.source,
      requestId: input.requestId ?? null,
    });
    return;
  }
  await db
    .insert(speechUsage)
    .values({
      userId: input.userId,
      kind: input.kind,
      seconds,
      source: input.source,
      sessionId: input.sessionId,
      requestId: input.requestId ?? null,
    })
    .onConflictDoUpdate({
      target: speechUsage.sessionId,
      // A high-water mark, not a sum: every report carries the meeting's total so far.
      set: { seconds: sql`greatest(${speechUsage.seconds}, ${seconds})` },
    });
}
```

- [ ] **Step 8: Register both scripts and run them green**

In `scripts/run-smoke.ts`: `"smoke-speech-limits": "pure",` and `"smoke-speech-quota": "pglite",`.
Run: `npx tsx scripts/smoke-speech-limits.ts` and `npx tsx scripts/smoke-speech-quota.ts` → PASS.
Run: `npx tsx scripts/run-smoke.ts --check`, `npx tsc --noEmit`, `npx eslint` on the four files.

- [ ] **Step 9: Commit**

```bash
git add src/lib/speech-limits.ts src/lib/speech-quota.ts scripts/smoke-speech-limits.ts scripts/smoke-speech-quota.ts scripts/run-smoke.ts
git commit -m "feat: per-plan speech quotas and usage accounting"
```

---

## Task 6: Voice notes transcribe on Deepgram first

**Files:**
- Modify: `src/lib/ai.ts` (`transcribeAudioWithAI`, `TranscriptionEngine`), `src/lib/ai-access.ts` (`canTranscribe`, `AiAccessStatus`), `src/lib/usage-events.ts` (`UsageProvider`), `src/lib/ai-pricing.ts`, `scripts/smoke-friendly-error.ts`
- Test: `scripts/smoke-ai-access.ts` (existing expectations)

**Interfaces:**
- Consumes: `deepgramEnabled`, `transcribeFile` (Task 3); `speechAllowance`, `recordSpeechSeconds` (Task 5); `loadNetworkVocabulary` (existing).
- Produces: `TranscriptionEngine = "deepgram" | "whisper" | "gemini"`; `transcribeAudioWithAI` unchanged in signature.

- [ ] **Step 1: Widen the engine and provider types**

In `src/lib/ai.ts`: `export type TranscriptionEngine = "deepgram" | "whisper" | "gemini";`
In `src/lib/usage-events.ts`: `export type UsageProvider = AiProvider | "typesafe" | "deepgram";`
In `src/lib/ai-pricing.ts`: add a Deepgram entry priced per second so `estimateCostMicros` never treats it as free — `$0.0043/min` for files, i.e. `72` micros per minute of audio; follow the file's existing shape for unpriced-by-token services.

- [ ] **Step 2: Put Deepgram in front of the chain**

In `transcribeAudioWithAI`, after `const vocabulary = await loadNetworkVocabulary(userId);` and before `const grant = await access.transcription(operation);`:

```ts
  // Deepgram first, on Orbit's key, while the account has short-form seconds left. It is the
  // only engine most accounts can reach: Whisper and Gemini below need a key the user pasted.
  if (deepgramEnabled()) {
    const allowance = await speechAllowance(userId, "shortform");
    if (!allowance.exhausted) {
      try {
        const result = await transcribeFile(
          { bytes: Buffer.from(input.base64, "base64"), mimeType: input.mimeType || "audio/wav" },
          { keyterms: vocabulary },
        );
        recordUsage({
          userId, operation, provider: "deepgram", model: DEEPGRAM_MODEL,
          kind: "transcription", keyOwner: "orbit", success: true, errorKind: null,
        });
        await recordSpeechSeconds({
          userId, kind: "shortform", seconds: result.seconds, source: "file",
          requestId: result.requestId,
        });
        if (!result.text) return empty("deepgram");
        return { text: result.text, engine: "deepgram" };
      } catch (err) {
        // Never fail a capture over Orbit's own service: fall through to the user's key.
        recordUsage({
          userId, operation, provider: "deepgram", model: DEEPGRAM_MODEL,
          kind: "transcription", keyOwner: "orbit", success: false, errorKind: classifyAiError(err),
        });
      }
    }
  }
```

Re-import `recordUsage` at the top of `ai.ts` (Task "remove Wispr" deleted it) alongside `withUsage`, and import `deepgramEnabled`, `transcribeFile`, `DEEPGRAM_MODEL`, `speechAllowance`, `recordSpeechSeconds`.

- [ ] **Step 3: Teach the gate that Deepgram counts as an engine**

In `src/lib/ai-access.ts`, `canTranscribe()` currently answers from personal/managed LLM keys only. Deepgram availability is per-account (quota), so resolve it in the status builder instead: in `getAiAccessStatus`, compute

```ts
  const deepgram = deepgramEnabled() ? !(await speechAllowance(userId, "shortform")).exhausted : false;
```

and return `canTranscribe: deepgram || access.canTranscribe()`. Leave `AiAccess.canTranscribe()` itself alone — it is the key-presence answer and other callers rely on it.

- [ ] **Step 4: Update the copy test**

`scripts/smoke-friendly-error.ts` pins the no-key sentence. The message in `ai.ts` stays "Voice capture needs an OpenAI or Gemini API key in Settings for transcription." — confirm the test still lists it verbatim; if the sentence changed, change both together.

- [ ] **Step 5: Verify**

Run: `npx tsx scripts/run-smoke.ts --only smoke-ai-access smoke-friendly-error smoke-ai-operations smoke-usage-events` → PASS.
Run: `npx tsc --noEmit`, `npx eslint` on the changed files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai.ts src/lib/ai-access.ts src/lib/usage-events.ts src/lib/ai-pricing.ts scripts/smoke-friendly-error.ts
git commit -m "feat: voice notes transcribe on Deepgram, with Whisper and Gemini as fallbacks"
```

---

## Task 7: The dictation token route

**Files:**
- Create: `src/app/api/speech/token/route.ts`
- Modify: `src/lib/rate-limit.ts`

**Interfaces:**
- Produces: `POST /api/speech/token` → `200 {accessToken, expiresIn, keyterms: string[], remainingSeconds}` · `402 {error}` when the quota is gone · `503 {error}` when Deepgram is off · `429` with `Retry-After`.

- [ ] **Step 1: Add the rate-limit bucket**

In `src/lib/rate-limit.ts`, in `RATE_LIMITS`:

```ts
  /** One token per connection attempt; a stuck reconnect loop must not mint endlessly. */
  speechToken: { limit: 30, windowSec: 300 },
```

and in `BUCKET_LABELS`: `speechToken: "speech transcription",`.

- [ ] **Step 2: Write the route**

```ts
// src/app/api/speech/token/route.ts
import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { isPaywallError } from "@/lib/entitlements";
import { friendlyError } from "@/lib/errors";
import { deepgramEnabled, mintStreamToken } from "@/lib/deepgram";
import { keytermsFor } from "@/lib/deepgram-params";
import { loadNetworkVocabulary } from "@/lib/transcription-vocabulary";
import { speechAllowance } from "@/lib/speech-quota";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportedFailure } from "@/lib/error-events";

export const dynamic = "force-dynamic";

/**
 * A 30-second Deepgram token for the chat mic. The browser opens its own connection with it,
 * so Orbit's key never reaches a client and a leaked token buys one short session.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.chat");
  } catch (err) {
    const status = isPaywallError(err) ? 403 : 401;
    return NextResponse.json({ error: friendlyError(err, "Sign in to dictate") }, { status });
  }

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  try {
    await consumeBucket("speechToken", userId, RATE_LIMITS.speechToken);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: friendlyError(err, "Too many dictation sessions just now — try again shortly") },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } },
      );
    }
    throw err;
  }

  if (!deepgramEnabled()) {
    return NextResponse.json({ error: "Live transcription is unavailable right now" }, { status: 503 });
  }

  const allowance = await speechAllowance(userId, "shortform");
  if (allowance.exhausted) {
    return NextResponse.json(
      { error: "You've used this month's transcription minutes" },
      { status: 402 },
    );
  }

  try {
    const [{ accessToken, expiresIn }, vocabulary] = await Promise.all([
      mintStreamToken(),
      loadNetworkVocabulary(userId),
    ]);
    return NextResponse.json(
      { accessToken, expiresIn, keyterms: keytermsFor(vocabulary), remainingSeconds: allowance.remaining },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const failure = reportedFailure(err, "Couldn't start dictation", { where: "route.speech-token", userId });
    return NextResponse.json({ error: failure.error, ref: failure.ref }, { status: 502 });
  }
}
```

Check `reportedFailure`'s exact import path and signature against `src/app/api/capture/meetings/[id]/chunks/route.ts` before writing; copy whatever that route does.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`, `npx eslint src/app/api/speech/token/route.ts src/lib/rate-limit.ts`.
Run: `npx tsx scripts/run-smoke.ts --only smoke-rate-limit smoke-public-routes` → PASS (this route is authenticated, so it must NOT be in `PUBLIC_ROUTES`).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/speech/token/route.ts src/lib/rate-limit.ts
git commit -m "feat: dictation token endpoint"
```

---

## Task 8: The live Deepgram socket (browser)

**Files:**
- Create: `src/lib/deepgram-live.ts`
- Modify: `src/lib/security-headers.ts`

**Interfaces:**
- Consumes: `listenParams` (Task 2); the token routes (Tasks 7, 12).
- Produces:
  - `export type LiveWord = { word: string; start: number; end: number; speaker: number | null }`
  - `export type LiveResult = { text: string; final: boolean; startMs: number; endMs: number; words: LiveWord[] }`
  - `export type LiveHandle = { send: (pcm: Int16Array) => void; finish: () => Promise<void>; close: () => void; readonly openedAt: number }`
  - `export async function openDeepgramLive(opts: { token: string; params: URLSearchParams; onResult: (r: LiveResult) => void; onClose: (code: number) => void; onError: () => void; socketFactory?: (url: string, protocols: string[]) => WebSocket }): Promise<LiveHandle>`

- [ ] **Step 1: Write the module**

Use the auth form Task 1 proved. The `socketFactory` parameter exists so Task 9's tests can inject a fake socket.

```ts
// src/lib/deepgram-live.ts
/**
 * One live Deepgram connection, from the browser.
 *
 * The token comes from our server and is good for opening this socket and nothing else; the
 * socket then outlives the token (Deepgram checks it only at the handshake), which is why a
 * meeting holds ONE connection rather than reconnecting on a timer — a reconnect restarts
 * Deepgram's speaker numbering.
 */
import { DEEPGRAM_MODEL } from "@/lib/deepgram-params";

const LISTEN_URL = "wss://api.deepgram.com/v1/listen";

export type LiveWord = { word: string; start: number; end: number; speaker: number | null };
export type LiveResult = { text: string; final: boolean; startMs: number; endMs: number; words: LiveWord[] };

export type LiveHandle = {
  send: (pcm: Int16Array) => void;
  /** Flush Deepgram's buffer and wait for the last final result. */
  finish: () => Promise<void>;
  close: () => void;
  readonly openedAt: number;
};

export async function openDeepgramLive(opts: {
  token: string;
  params: URLSearchParams;
  onResult: (result: LiveResult) => void;
  onClose: (code: number) => void;
  onError: () => void;
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
}): Promise<LiveHandle> {
  const url = `${LISTEN_URL}?${opts.params.toString()}`;
  const make = opts.socketFactory ?? ((u, p) => new WebSocket(u, p));
  const socket = make(url, ["token", opts.token]);
  socket.binaryType = "arraybuffer";

  let finished: (() => void) | null = null;

  socket.onmessage = (event: MessageEvent) => {
    let payload: unknown;
    try { payload = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    const message = payload as {
      type?: string;
      is_final?: boolean;
      start?: number;
      duration?: number;
      channel?: { alternatives?: { transcript?: string; words?: { word: string; start: number; end: number; speaker?: number }[] }[] };
    };
    if (message.type === "Metadata") { finished?.(); return; }
    if (message.type && message.type !== "Results") return;
    const alt = message.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim() ?? "";
    if (!text) return;
    const startMs = Math.round((message.start ?? 0) * 1000);
    opts.onResult({
      text,
      final: Boolean(message.is_final),
      startMs,
      endMs: startMs + Math.round((message.duration ?? 0) * 1000),
      words: (alt?.words ?? []).map((w) => ({
        word: w.word,
        start: Math.round(w.start * 1000),
        end: Math.round(w.end * 1000),
        speaker: typeof w.speaker === "number" ? w.speaker : null,
      })),
    });
  };
  socket.onerror = () => opts.onError();
  socket.onclose = (event: CloseEvent) => { finished?.(); opts.onClose(event.code); };

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    const failed = () => reject(new Error(`Deepgram socket closed before opening (${DEEPGRAM_MODEL})`));
    socket.addEventListener("close", failed, { once: true });
    setTimeout(() => reject(new Error("Deepgram socket timed out")), 10_000);
  });

  return {
    openedAt: Date.now(),
    send(pcm: Int16Array) {
      if (socket.readyState === WebSocket.OPEN) socket.send(pcm.buffer as ArrayBuffer);
    },
    async finish() {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "Finalize" }));
      socket.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise<void>((resolve) => {
        finished = resolve;
        setTimeout(resolve, 5_000);
      });
    },
    close() {
      try { socket.close(); } catch { /* already closing */ }
    },
  };
}
```

- [ ] **Step 2: Let the browser reach Deepgram at all**

Without this the socket is blocked by the content security policy and every live feature fails in production while working in dev. In `src/lib/security-headers.ts`, add to the `connect-src` list (the file must stay alias-free — no `@/` imports):

```ts
      "wss://api.deepgram.com",
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`, `npx eslint src/lib/deepgram-live.ts src/lib/security-headers.ts`.
Run: `npx tsx scripts/run-smoke.ts --only smoke-security-headers` → PASS.
Confirm the header really carries it: start the dev server and run
`curl -sI localhost:3000/chat | grep -i content-security-policy` → the value contains `wss://api.deepgram.com`.
Socket behaviour is tested through Task 9's fake socket; this task only proves types and policy.

- [ ] **Step 4: Commit**

```bash
git add src/lib/deepgram-live.ts src/lib/security-headers.ts
git commit -m "feat: live Deepgram socket wrapper"
```

---

## Task 9: The chat mic runs on Deepgram

**Files:**
- Modify: `src/lib/use-dictation.ts`
- Test: `scripts/smoke-dictation.ts` (must pass **unchanged**)

**Interfaces:**
- Consumes: `openDeepgramLive` (Task 8); `POST /api/speech/token` (Task 7); `dictationReducer` and its effects (unchanged).
- Produces: `DictationHandle` unchanged, plus one added field `engine: "deepgram" | "browser" | null`.

- [ ] **Step 1: Confirm the contract you must not break**

Run: `npx tsx scripts/smoke-dictation.ts` → PASS (baseline). Read `src/components/chat/chat-panel.tsx`'s two `useDictation` call sites. Nothing there may change in this task.

- [ ] **Step 2: Add the Deepgram engine behind the existing effects**

In `use-dictation.ts`, keep `dictationReducer` as the brain. Replace only what `start-recognition`, `restart-recognition`, `stop-recognition` and `abort-recognition` *do*:

- Add `const engineRef = useRef<"deepgram" | "browser" | null>(null);`
- On `start-recognition`: `POST /api/speech/token`. On `200`, set `engineRef.current = "deepgram"`, capture mic audio through the same `AudioWorklet` + `createDownsampler` path the voice recorder uses (`TARGET_SAMPLE_RATE`), open the socket with `listenParams({ live: true, keyterms })`, and dispatch `{t:"audiostart"}` when it opens. On `402`, `503`, a network failure, or `!isDictationSupported()`-style Deepgram unavailability, set `engineRef.current = "browser"` and run today's `SpeechRecognition` path untouched.
- Map Deepgram results onto the existing callback: accumulate finals into the committed span, treat the newest non-final as interim, and call `cb.current.onTranscript(span, { hasInterim, interimStart })` exactly as now. Dispatch `{t:"result"}` on every result so the reducer's pause and restart logic keeps working.
- On socket close or error: dispatch `{t:"error", code:"network", now: Date.now()}` — the reducer already handles one silent retry and the `toast-network` effect.
- `stop-recognition` → `handle.finish()` then `close()`. `abort-recognition` → `close()` without finishing.
- Report usage at session end: create `src/app/api/speech/usage/route.ts` in this task, mirroring Task 7's auth and same-origin checks. It accepts `{seconds: number}`, clamps it to `MAX_SESSION_MS / 1000` (300) so a tampered client cannot under- or over-report beyond one session, and calls `recordSpeechSeconds({userId, kind: "shortform", seconds, source: "stream"})`. The client sends it from the `stop-recognition` and `abort-recognition` effects with `navigator.sendBeacon("/api/speech/usage", new Blob([JSON.stringify({seconds})], {type: "application/json"}))`, measuring seconds from the socket's `openedAt`. A dropped beacon under-counts one session, which is the right way to fail.
- Expose `engine: engineRef.current` on the returned handle.

- [ ] **Step 3: Test the mapping with a fake socket**

Create `scripts/smoke-dictation-deepgram.ts` (pure, registered in the manifest) that imports the pure mapping helper you extracted in Step 2 — export `export function foldResults(prev: {committed: string; interim: string}, r: LiveResult)` from `use-dictation.ts` or a small sibling module so it can be tested without React:

```ts
check("a final result commits", foldResults({ committed: "", interim: "" }, final("Met Priya")).committed === "Met Priya");
check("an interim does not commit", foldResults({ committed: "Met Priya", interim: "" }, interim("at")).committed === "Met Priya");
check("a later interim replaces the earlier one", foldResults({ committed: "", interim: "at" }, interim("at Stripe")).interim === "at Stripe");
check("a final clears the interim", foldResults({ committed: "", interim: "at" }, final("at Stripe")).interim === "");
check("finals join with a space", foldResults({ committed: "Met Priya", interim: "" }, final("at Stripe")).committed === "Met Priya at Stripe");
```

- [ ] **Step 4: Run every dictation test**

Run: `npx tsx scripts/smoke-dictation.ts` → PASS, **unchanged**. If it needed editing, the reducer contract was broken; revert and rework Step 2.
Run: `npx tsx scripts/smoke-dictation-deepgram.ts` → PASS.

- [ ] **Step 5: Verify in a real browser**

Start the dev server (`mcp__Claude_Browser__preview_start`), open `/chat`, click the mic, speak into the composer. Confirm words appear while speaking, the composer's caret splice behaves as before, and `read_console_messages` shows no errors. Then set `ORBIT_DEEPGRAM=off`, reload, and confirm the browser engine still works.

- [ ] **Step 6: Commit**

```bash
git add src/lib/use-dictation.ts src/app/api/speech/usage/route.ts scripts/smoke-dictation-deepgram.ts scripts/run-smoke.ts
git commit -m "feat: chat dictation runs on Deepgram, falling back to the browser engine"
```

---

## Task 10: Meetings become a paid feature

**Files:**
- Modify: `src/lib/entitlements.ts`, `src/lib/plan-guards.ts`, `src/actions/meetings.ts`, `src/app/api/capture/meetings/[id]/chunks/route.ts`, `src/app/(clerk)/(app)/(main)/capture/page.tsx`, `src/components/capture/meeting-capture-tab.tsx`
- Create: `scripts/smoke-meeting-gate.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Produces: `canUseMeetings: boolean` on `Entitlements`; `FeatureKey` gains `"meetings"`; `export async function requireMeetingsUser(): Promise<string>`.

- [ ] **Step 1: Write the failing gate test**

```ts
// scripts/smoke-meeting-gate.ts
/**
 * Meetings are Pro and Lifetime only — at every entry point, not just in the UI.
 * Run: npx tsx scripts/smoke-meeting-gate.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { entitlementsForPlan, FEATURE_DENIAL } from "../src/lib/entitlements";
import { createMeetingSession } from "../src/actions/meetings";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

async function setPlan(plan: "free" | "orbit" | "lifetime") {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER,
    ...(plan === "lifetime" ? { lifetimeGrantedAt: new Date() } : {}),
    ...(plan === "orbit" ? { subscriptionStatus: "active", subscriptionPlan: "orbit" } : {}),
  });
}

async function main() {
  console.log("\nentitlements");
  check("free cannot meet", entitlementsForPlan("free", "free").canUseMeetings === false);
  check("Pro can meet", entitlementsForPlan("orbit", "subscription").canUseMeetings === true);
  check("Lifetime can meet", entitlementsForPlan("lifetime", "lifetime").canUseMeetings === true);
  check("the denial names both paid plans", /Pro/.test(FEATURE_DENIAL.meetings) && /Lifetime/.test(FEATURE_DENIAL.meetings));

  console.log("\ncreateMeetingSession");
  await setPlan("free");
  const refused = await createMeetingSession({ includesMic: true, recorderId: "r1" });
  check("a free account is refused", refused.ok === false);

  await setPlan("orbit");
  const allowed = await createMeetingSession({ includesMic: true, recorderId: "r2" });
  check("a Pro account is allowed", allowed.ok === true, JSON.stringify(allowed));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll meeting gate checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Check the real column names for a Pro/Lifetime account in `src/lib/entitlements.ts`'s `resolvePlan` before writing `setPlan`, and match them exactly.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-meeting-gate.ts` → FAIL on `canUseMeetings` being undefined.

- [ ] **Step 3: Add the entitlement in all four places**

In `src/lib/entitlements.ts`: add `canUseMeetings: boolean` to `Entitlements`; `canUseMeetings: paid` in `entitlementsForPlan`; `"meetings"` to `FeatureKey`; to `FEATURE_DENIAL`:

```ts
  meetings: "Meeting transcription is available on Orbit Pro and Orbit Lifetime.",
```

and to `FEATURE_FLAG`: `meetings: "canUseMeetings",`.

- [ ] **Step 4: Add the guard and use it everywhere**

In `src/lib/plan-guards.ts`:

```ts
export async function requireMeetingsUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "meetings");
  await requireVisibleSurface(userId, "page.capture");
  return userId;
}
```

Replace `requireUserId()` with `requireMeetingsUser()` in `createMeetingSession`, `resumeMeetingSession`, `endMeetingSession` and `analyzeMeetingSession` in `src/actions/meetings.ts` (leave `loadMeetingTranscript` and `discardMeetingSession` on `requireUserId`, so a downgraded account can still read and delete what it already recorded). In the chunk route, replace `requireUserForSurface("page.capture")` with `requireMeetingsUser()` — its catch already maps `PaywallError` to 403.

- [ ] **Step 5: Gate the UI**

In `capture/page.tsx`, read `getEntitlements(userId)` and pass `canUseMeetings` into the meeting tab. In `meeting-capture-tab.tsx`, when it is false, render an upgrade prompt in place of the recorder, using the existing paywall-notice component that other gated surfaces use (find it by searching for another `FEATURE_DENIAL` consumer) and `FEATURE_DENIAL.meetings` as the copy.

- [ ] **Step 6: Run it green**

Run: `npx tsx scripts/smoke-meeting-gate.ts` → PASS. Register it as `"smoke-meeting-gate": "pglite",`.
Run: `npx tsx scripts/run-smoke.ts --only smoke-entitlements smoke-surface-visibility smoke-plan-comparison` (whichever exist) → PASS.
Run: `npx tsc --noEmit`, `npx eslint` on changed files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/entitlements.ts src/lib/plan-guards.ts src/actions/meetings.ts "src/app/api/capture/meetings/[id]/chunks/route.ts" "src/app/(clerk)/(app)/(main)/capture/page.tsx" src/components/capture/meeting-capture-tab.tsx scripts/smoke-meeting-gate.ts scripts/run-smoke.ts
git commit -m "feat: meetings require Orbit Pro or Lifetime"
```

---

## Task 11: Live segments land on the server

**Files:**
- Create: `src/app/api/capture/meetings/[id]/segments/route.ts`
- Modify: `src/lib/meeting-sessions.ts`
- Test: extend `scripts/smoke-meeting-sessions.ts`

**Interfaces:**
- Consumes: `recordSpeechSeconds` (Task 5); `requireMeetingsUser` (Task 10).
- Produces: `export async function recordLiveSegments(userId, sessionId, input: { recorderId: string; segments: LiveSegmentInput[] }): Promise<{ ok: true; written: number; durationMs: number } | { ok: false; status: 400|404|409|410; error: string }>` where `LiveSegmentInput = { seq: number; startMs: number; endMs: number; speaker: string | null; text: string }`.

- [ ] **Step 1: Write the failing test**

Add to the meeting smoke:

```ts
console.log("\nlive segments");
{
  const session = await createMeetingSessionRow(USER, { includesMic: true, recorderId: "rec-1" });
  const first = await recordLiveSegments(USER, session.id, {
    recorderId: "rec-1",
    segments: [
      { seq: 0, startMs: 0, endMs: 4_000, speaker: "you", text: "Met Priya from Stripe." },
      { seq: 1, startMs: 4_000, endMs: 9_000, speaker: "speaker-1", text: "We talked about pricing." },
    ],
  });
  check("both segments are written", first.ok && first.written === 2);
  check("duration follows the last segment", first.ok && first.durationMs === 9_000);

  const again = await recordLiveSegments(USER, session.id, {
    recorderId: "rec-1",
    segments: [{ seq: 1, startMs: 4_000, endMs: 9_000, speaker: "speaker-1", text: "We talked about pricing." }],
  });
  check("a retried batch writes nothing new", again.ok && again.written === 0);

  const stolen = await recordLiveSegments(USER, session.id, {
    recorderId: "rec-2",
    segments: [{ seq: 2, startMs: 9_000, endMs: 12_000, speaker: null, text: "Later." }],
  });
  check("another recorder is refused", !stolen.ok && stolen.status === 409);

  const rows = await db.select().from(meetingTranscriptSegments).where(eq(meetingTranscriptSegments.sessionId, session.id));
  check("speakers are stored", rows.find((r) => r.seq === 0)?.speaker === "you");
  check("the engine is deepgram", rows.every((r) => r.engine === "deepgram"));

  const usage = await db.select().from(speechUsage).where(eq(speechUsage.sessionId, session.id));
  check("usage is metered once, in seconds", usage.length === 1 && usage[0]?.seconds === 9);
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-meeting-sessions.ts` → FAIL, `recordLiveSegments` is not exported.

- [ ] **Step 3: Implement it**

In `meeting-sessions.ts`, beside `ingestMeetingChunk`, write `recordLiveSegments`. Reuse that function's existing checks in the same order: `getMeetingSession` → 404; status in `ACCEPTS_CHUNKS` → else 410; `status === "recording" && session.recorderId && input.recorderId !== session.recorderId` → 409. Then insert all segments in one statement with `.onConflictDoNothing({ target: [meetingTranscriptSegments.sessionId, meetingTranscriptSegments.seq] }).returning()`, with `engine: "deepgram"`. Update the session exactly as `ingestMeetingChunk` does (`greatest(...)` on `lastSeq` and `durationMs`), then:

```ts
  await recordSpeechSeconds({
    userId, kind: "meeting", source: "stream", sessionId: session.id,
    seconds: Math.ceil(maxEndMs / 1000),
  });
```

Validate input first: reject a batch over 200 segments, any `text` over 5_000 characters, `seq` outside `0..MAX_SEQ`, or `endMs` over `MAX_CHUNK_OFFSET_MS`, returning `{ok:false, status:400}`.

- [ ] **Step 4: Write the route**

Copy the chunk route's structure exactly — `requireMeetingsUser()`, the same-origin check, the `x-orbit-recorder` header requirement, `consumeBucket("meetingChunk", userId, RATE_LIMITS.meetingChunk)` — then parse JSON and call `recordLiveSegments`. Return `result.status` on failure, `{written, durationMs}` on success. `export const dynamic = "force-dynamic";`.

- [ ] **Step 5: Run it green and verify**

Run: `npx tsx scripts/smoke-meeting-sessions.ts` → PASS.
Run: `npx tsc --noEmit`, `npx eslint` on the changed files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/meeting-sessions.ts "src/app/api/capture/meetings/[id]/segments/route.ts" scripts/smoke-meeting-sessions.ts
git commit -m "feat: live meeting segments with speakers and metered seconds"
```

---

## Task 12: The meeting token route

**Files:**
- Create: `src/app/api/capture/meetings/[id]/stream-token/route.ts`

**Interfaces:**
- Produces: `POST /api/capture/meetings/[id]/stream-token` → `200 {accessToken, expiresIn, keyterms, remainingSeconds, warn}` · `402` when meeting seconds are gone · `403` for the wrong plan or a stolen session · `503` when Deepgram is off.

- [ ] **Step 1: Write the route**

Same shape as Task 7, with three differences: `requireMeetingsUser()` instead of `requireUserForSurface`; the session is loaded and checked (`getMeetingSession` → 404; `status === "recording" && session.recorderId && header !== session.recorderId` → 409); and the allowance is `speechAllowance(userId, "meeting")`, returning `warn: allowance.warn` so the browser can show the 90% banner without a second call.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`, `npx eslint` on the new file.
Run: `npx tsx scripts/run-smoke.ts --only smoke-public-routes` → PASS (authenticated, so absent from `PUBLIC_ROUTES`).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/capture/meetings/[id]/stream-token/route.ts"
git commit -m "feat: meeting stream-token endpoint"
```

---

## Task 13: Who is "You" — loudness timeline and speaker mapping

**Files:**
- Create: `src/lib/speaker-map.ts`, `scripts/smoke-speaker-map.ts`
- Modify: `src/lib/use-meeting-recorder.ts`, `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: the recorder's existing analyser polling (`rmsLevel` every `METER_EVERY_FRAMES`).
- Produces:
  - `export type LoudnessSample = { atMs: number; mic: number; call: number }`
  - `export class LoudnessTimeline { push(s: LoudnessSample): void; micDominantShare(startMs: number, endMs: number): number | null; }`
  - `export function labelSpeakers(words: readonly LiveWord[], timeline: { micDominantShare(a: number, b: number): number | null }, opts?: { minWords?: number; threshold?: number }): Map<number, string>`
  - On the recorder handle: `loudness: LoudnessTimeline`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/smoke-speaker-map.ts
/**
 * "You" is decided locally: Deepgram says WHICH speaker, the mic says WHO.
 * Run: npx tsx scripts/smoke-speaker-map.ts
 */
import { LoudnessTimeline, labelSpeakers } from "../src/lib/speaker-map";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

function word(w: string, start: number, speaker: number | null) {
  return { word: w, start, end: start + 300, speaker };
}

console.log("\nLoudnessTimeline");
{
  const t = new LoudnessTimeline();
  for (let ms = 0; ms < 2_000; ms += 32) t.push({ atMs: ms, mic: 0.6, call: 0.05 });
  for (let ms = 2_000; ms < 4_000; ms += 32) t.push({ atMs: ms, mic: 0.03, call: 0.7 });
  check("mic-dominant stretch reads as 1", t.micDominantShare(0, 1_900) === 1);
  check("call-dominant stretch reads as 0", t.micDominantShare(2_100, 3_900) === 0);
  check("a half-and-half span is in between", Math.abs((t.micDominantShare(0, 4_000) ?? 0) - 0.5) < 0.1);
  check("a span with no samples is unknown", t.micDominantShare(60_000, 61_000) === null);
  check("silence on both sides is not mic-dominant", (() => {
    const q = new LoudnessTimeline();
    for (let ms = 0; ms < 1_000; ms += 32) q.push({ atMs: ms, mic: 0.001, call: 0.001 });
    return q.micDominantShare(0, 900) === 0;
  })());
}

console.log("\nlabelSpeakers");
{
  const mine = { micDominantShare: () => 1 };
  const theirs = { micDominantShare: () => 0 };
  const words = Array.from({ length: 25 }, (_, i) => word("hello", i * 400, 0));
  check("a consistently mic-dominant speaker is you", labelSpeakers(words, mine).get(0) === "you");
  check("a call-dominant speaker is numbered", labelSpeakers(words, theirs).get(0) === "speaker-1");
  check("too few words means no claim", labelSpeakers(words.slice(0, 5), mine).get(0) === "speaker-1");

  const mixed = [...Array.from({ length: 25 }, (_, i) => word("a", i * 400, 0)), ...Array.from({ length: 25 }, (_, i) => word("b", 10_000 + i * 400, 1))];
  const map = labelSpeakers(mixed, { micDominantShare: (start) => (start < 10_000 ? 1 : 0) });
  check("only one speaker becomes you", [...map.values()].filter((v) => v === "you").length === 1);
  check("the other keeps a number", map.get(1) === "speaker-1");
  check("numbering follows order of appearance", labelSpeakers(mixed, theirs).get(0) === "speaker-1" && labelSpeakers(mixed, theirs).get(1) === "speaker-2");
  check("unknown loudness never claims you", labelSpeakers(words, { micDominantShare: () => null }).get(0) === "speaker-1");
  check("words with no speaker are ignored", labelSpeakers([word("x", 0, null)], mine).size === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll speaker mapping checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-speaker-map.ts` → FAIL, module not found.

- [ ] **Step 3: Implement the pure module**

```ts
// src/lib/speaker-map.ts
/**
 * Deepgram tells us THAT two people spoke. It cannot tell us which one is the user, and for a
 * networking CRM that is the label that matters: what you promised versus what they said.
 *
 * The recorder already meters the microphone and the call audio separately, before they are
 * mixed. So we keep that as a timeline and ask, for each of Deepgram's speakers, how much of
 * their speech landed while the microphone was the loud one. One speaker crossing the
 * threshold is "you"; everyone else is numbered.
 */
import type { LiveWord } from "@/lib/deepgram-live";

export type LoudnessSample = { atMs: number; mic: number; call: number };

/** Below this, both sides are effectively silent and the comparison means nothing. */
const SILENCE = 0.02;
/** How long a meeting's samples are kept: three hours at ~32 ms. */
const MAX_SAMPLES = 340_000;

export class LoudnessTimeline {
  private samples: LoudnessSample[] = [];

  push(sample: LoudnessSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** The share of samples in this span where the mic was louder. Null when nothing was recorded. */
  micDominantShare(startMs: number, endMs: number): number | null {
    let total = 0;
    let mic = 0;
    for (const s of this.samples) {
      if (s.atMs < startMs) continue;
      if (s.atMs > endMs) break;
      total++;
      if (s.mic > SILENCE && s.mic > s.call) mic++;
    }
    return total === 0 ? null : mic / total;
  }
}

export function labelSpeakers(
  words: readonly LiveWord[],
  timeline: { micDominantShare(startMs: number, endMs: number): number | null },
  opts: { minWords?: number; threshold?: number } = {},
): Map<number, string> {
  const minWords = opts.minWords ?? 20;
  const threshold = opts.threshold ?? 0.7;

  const order: number[] = [];
  const stats = new Map<number, { words: number; micWords: number }>();
  for (const w of words) {
    if (w.speaker === null) continue;
    if (!stats.has(w.speaker)) { stats.set(w.speaker, { words: 0, micWords: 0 }); order.push(w.speaker); }
    const stat = stats.get(w.speaker)!;
    stat.words++;
    const share = timeline.micDominantShare(w.start, w.end);
    if (share !== null && share >= 0.5) stat.micWords++;
  }

  let you: number | null = null;
  let best = 0;
  for (const [speaker, stat] of stats) {
    if (stat.words < minWords) continue;
    const share = stat.micWords / stat.words;
    if (share >= threshold && share > best) { you = speaker; best = share; }
  }

  const labels = new Map<number, string>();
  let n = 0;
  for (const speaker of order) {
    labels.set(speaker, speaker === you ? "you" : `speaker-${++n}`);
  }
  return labels;
}
```

- [ ] **Step 4: Run it green**

Run: `npx tsx scripts/smoke-speaker-map.ts` → PASS. Register `"smoke-speaker-map": "pure",`.

- [ ] **Step 5: Feed the timeline from the recorder**

In `use-meeting-recorder.ts`, where the two analysers are already polled every `METER_EVERY_FRAMES` frames for the meters, also push a sample:

```ts
      loudnessRef.current.push({
        atMs: chunker.elapsedMs,
        mic: micActiveRef.current ? micRms : 0,
        call: callRms,
      });
```

Use the raw `rmsLevel` values, not the smoothed motion-value ones — smoothing is for the eye. Create `const loudnessRef = useRef(new LoudnessTimeline());`, reset it in `start()`, and expose `loudness: loudnessRef.current` on `MeetingRecorderHandle`. Do not touch the worklet or the PCM path.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`, `npx eslint src/lib/speaker-map.ts src/lib/use-meeting-recorder.ts scripts/smoke-speaker-map.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/speaker-map.ts scripts/smoke-speaker-map.ts src/lib/use-meeting-recorder.ts scripts/run-smoke.ts
git commit -m "feat: identify the user's own voice from mic loudness"
```

---

## Task 14: The meeting panel goes live

**Files:**
- Modify: `src/components/capture/meeting-capture-panel.tsx`, `src/lib/meeting-upload-queue.ts`

**Interfaces:**
- Consumes: Tasks 8, 11, 12, 13.
- Produces: no new exports; the panel's props are unchanged except `canUseMeetings` from Task 10.

- [ ] **Step 1: Hold chunks instead of uploading them**

In `MeetingUploadQueue`, add `setLiveWatermark(endMs: number): void`. While a watermark is set, `enqueue` still writes the chunk to IndexedDB but does not upload it; chunks with `endMs <= watermark` are deleted from the outbox instead. Add `uploadFrom(startMs: number): void`, which re-arms uploading for chunks at or after `startMs` (the recovery path). Default behaviour with no watermark set must stay exactly as today, because that is the fallback when Deepgram is off.

- [ ] **Step 2: Open the live connection when the session exists**

In `handleStarted`, after `createMeetingSession`/`resumeMeetingSession` returns an id, `POST /api/capture/meetings/${id}/stream-token` with the `x-orbit-recorder` header. On 200, `openDeepgramLive({ token, params: listenParams({ live: true, diarize: true, keyterms, tag: \`meeting:${id}\` }), ... })`. On 402/403/503 or any failure, skip the live path entirely and leave the queue in today's chunk-upload mode with one notice ("Live transcription is unavailable — this meeting will still be transcribed").

- [ ] **Step 3: Feed audio and render results**

In `handleChunk`, keep calling `enqueue` (now watermarked), and additionally send PCM to the socket. The recorder currently hands over completed chunks; send `chunk.samples` directly in `onChunk`, which is ~60 s of latency. **That defeats the point**, so instead add an `onFrame?: (pcm: Int16Array) => void` option to `useMeetingRecorder` and call it from the existing worklet message handler right after `downsample(frame)` — one line, no change to chunking. Wire `onFrame: (pcm) => liveRef.current?.send(pcm)`.

Accumulate results: non-final text renders as a greyed live line; on `final`, append to a pending batch with `{seq: nextSeq++, startMs, endMs, speaker: labels.get(word.speaker) ?? null, text}` where `labels` comes from `labelSpeakers(allWordsSoFar, recorder.loudness)` recomputed every ~10 s (it is cheap and labels improve as evidence accumulates). Post the batch to the segments route every 10 s or on `UtteranceEnd`, and call `queue.setLiveWatermark(lastFinalEndMs)`.

- [ ] **Step 4: Handle the drop**

On `onClose` or `onError` from the socket: mark a reconnect boundary in the rendered transcript ("Reconnected — speakers renumbered"), call `queue.uploadFrom(watermark)` so the gap is transcribed through the chunk route, then retry the token + socket with backoff (2 s, 4 s, 8 s, capped at 60 s, 6 attempts). A 402 response stops the meeting via the 100% path below.

- [ ] **Step 5: Quota banners and the stop**

From the token response, keep `remainingSeconds` and `warn`. Show the 90% banner once per session when `warn` is true. Track elapsed audio against `remainingSeconds`; when it is spent, call `recorder.stop()`, `live.finish()`, then the existing `finishMeeting` path, and show: "Recording stopped — you've used this month's meeting hours. Resets {date}."

- [ ] **Step 6: Verify in a real browser**

Start the dev server. On `/capture`, share a tab playing speech, with the mic on. Confirm: words appear within a second or two; the transcript shows `You` for your own speech; stopping produces a digest; `read_network_requests` shows segment posts but no chunk uploads while the socket is healthy. Then kill the network briefly (`javascript_tool`: `window.dispatchEvent(new Event("offline"))` is not enough — close the socket directly via a debug handle or toggle Wi-Fi) and confirm chunks upload for the gap and the transcript continues.

- [ ] **Step 7: Verify the fallback**

Set `ORBIT_DEEPGRAM=off`, restart, record a short meeting, and confirm it still transcribes through the chunk route on the user's own key exactly as before this project.

- [ ] **Step 8: Commit**

```bash
git add src/components/capture/meeting-capture-panel.tsx src/lib/meeting-upload-queue.ts src/lib/use-meeting-recorder.ts
git commit -m "feat: live meeting transcription with speaker labels"
```

---

## Task 15: The digest reads speakers

**Files:**
- Modify: `src/lib/meeting-digest.ts`, and wherever `loadMeetingTranscript` shapes rows for the UI (`src/actions/meetings.ts`)

**Interfaces:**
- Consumes: `meetingTranscriptSegments.speaker` (Task 4).
- Produces: transcript paragraphs prefixed with `You:` / `Speaker N:` when a speaker is known.

- [ ] **Step 1: Prefix the transcript text**

Where the digest assembles paragraphs, render each segment as `${label}: ${text}` when `speaker` is set (`you` → `You`, `speaker-2` → `Speaker 2`), and as bare text when it is null. Keep the existing 30k-character map-reduce untouched.

- [ ] **Step 2: Replace the "no speaker labels" instruction**

At `src/lib/meeting-digest.ts:354`, replace the sentence with one that matches reality:

> How the transcript was made — this matters: it is machine speech-to-text of the meeting's audio. Lines may be prefixed with a speaker: "You:" is the user; "Speaker 2:", "Speaker 3:" and so on are other people, identified by voice, and the same person may be renumbered after a line saying the recording reconnected. Unprefixed lines come from a stretch where speakers were not identified. Names may be misspelled.

Then relax the rule at `:365`: `"owner"` may now be `"me"` when the commitment was spoken on a `You:` line, and stays null when the line has no speaker. Keep "never guess an owner" for unprefixed lines.

- [ ] **Step 3: Test the digest still parses**

Run: `npx tsx scripts/run-smoke.ts --only smoke-meeting-digest` → PASS. If the fixture transcripts have no speakers, add one fixture that does, asserting `owner: "me"` is extracted from a `You:` line.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit`, `npx eslint` on changed files.

```bash
git add src/lib/meeting-digest.ts src/actions/meetings.ts
git commit -m "feat: the meeting digest reads speaker labels"
```

---

## Task 16: Nightly reconciliation

**Files:**
- Create: `src/app/api/ops/speech-usage/route.ts`
- Modify: `src/lib/public-routes.ts`, `.github/workflows/ops.yml`, `src/lib/deepgram.ts`

**Interfaces:**
- Produces: `export async function fetchDeepgramUsage(opts: { since: Date; until: Date }): Promise<{ tag: string | null; seconds: number }[]>` in `deepgram.ts`; `POST /api/ops/speech-usage` returning `{checked, overreported}`.

- [ ] **Step 1: Add the usage reader**

In `deepgram.ts`, add `fetchDeepgramUsage` calling Deepgram's project requests/usage endpoint with the raw key, paging as needed, returning per-`tag` totals in seconds. Confirm the exact endpoint and response shape from `https://developers.deepgram.com/reference/management-api/usage/list-requests` before writing it.

- [ ] **Step 2: Write the route**

Copy `src/app/api/ops/sweep/route.ts`'s head exactly: `isInternalRequest(request)` → 401, `export const dynamic = "force-dynamic"; export const maxDuration = 60;`. Then: read yesterday's Deepgram usage, group by `meeting:<id>` tag, compare each against the `speech_usage` row for that session, and for any meeting where Deepgram reports more than 110% of what we recorded, send an ops alert through the existing alert helper (find it in `src/lib/ops-alerts.ts`) naming the session, the user and both numbers. Never suspend anyone. Return `{checked, overreported}` with `Cache-Control: no-store`.

- [ ] **Step 3: Register the public route and the schedule**

Add `/api/ops/speech-usage` to the internal-job block in `src/lib/public-routes.ts`. In `.github/workflows/ops.yml`, add a daily cron (`"41 5 * * *"`) and a step gated on `github.event.schedule == '41 5 * * *'` that curls the route with `Authorization: Bearer $CRON_SECRET`, copying the existing steps exactly.

- [ ] **Step 4: Verify**

Run: `npx tsx scripts/run-smoke.ts --only smoke-public-routes smoke-internal-auth` → PASS.
Run: `npx tsc --noEmit`, `npx eslint` on changed files.
Test the auth locally: `curl -i -X POST localhost:3000/api/ops/speech-usage` → 401, and with the right bearer token → 200.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ops/speech-usage/route.ts src/lib/public-routes.ts .github/workflows/ops.yml src/lib/deepgram.ts
git commit -m "feat: nightly reconciliation of Deepgram usage"
```

---

## Task 17: Copy, pricing, docs and the accuracy gate

**Files:**
- Modify: `src/app/(site)/(docs)/privacy/page.tsx`, `src/components/pricing/plan-comparison.tsx`, `src/components/settings/ai-settings.tsx`, `docs/RUNBOOK.md`, `scripts/eval-ai.ts`, `scripts/lib/eval-ai-tasks.ts`

- [ ] **Step 1: Privacy page**

Add to the processor list, in the established shape:

```tsx
  { name: "Deepgram", badge: "Always", body: "Speech-to-text for voice notes, meetings and the chat microphone. Receives your audio and a list of your recent contact names so it spells them correctly." },
```

Bump `LEGAL_LAST_UPDATED` in `src/lib/legal.ts` to today's date. **Do not touch `TERMS_VERSION`** — the user decided against re-prompting everyone.

- [ ] **Step 2: Pricing and settings**

In the plan comparison, add a meetings row: Free "—", Pro "5 hours a month", Lifetime "10 hours a month". In Settings, under the AI section, show remaining minutes for both meters, read from `speechAllowance` on the server and passed down.

- [ ] **Step 3: Runbook**

Add a Deepgram section to `docs/RUNBOOK.md`: where the key lives, what `ORBIT_DEEPGRAM=off` does, how the nightly reconciliation alerts, and the two caps with the code that owns them (`src/lib/speech-limits.ts`).

- [ ] **Step 4: Extend the accuracy eval**

In `scripts/lib/eval-ai-tasks.ts`'s `runTranscribeTask`, run each fixture through Deepgram as well as the existing engines and report WER per engine plus name accuracy. Add a threshold entry for Deepgram in `scripts/eval-fixtures/ai-eval-thresholds.json` matching the existing `transcribe` shape.

- [ ] **Step 5: Run the gate**

Run: `npx tsx scripts/eval-ai.ts --task transcribe` with a real Deepgram key in `ORBIT_EVAL_*` form. Record the WER and name accuracy for Deepgram, Whisper and Gemini in the PR description. **If Deepgram loses on name accuracy, stop and report it** — the whole premise of putting it first is that names come back right.

- [ ] **Step 6: Full verification**

Run: `npx tsc --noEmit` → clean.
Run: `npx eslint` over every file this plan touched → 0 errors.
Run: `npm test` (the full CI smoke suite) → all pass. Reruns of individual scripts are allowed when machine load is high; note any that needed it.
Run: `npm run build` → succeeds.

- [ ] **Step 7: Commit and open the PR**

```bash
git add -A
git commit -m "feat: Deepgram copy, pricing, docs and the transcription eval"
git push -u origin claude/deepgram-speech
```

Open the PR with a body covering: what changed per surface, the two caps and their costs, the eval numbers from Step 5, the manual browser checks from Tasks 9 and 14, the schema version used, and the manual step the operator must take — **set `DEEPGRAM_API_KEY` in Vercel for Production and Preview before merging**, since `check:env` lists it as expected in production and transcription silently falls back without it.

---

## Manual steps for the user (not doable from here)

1. Create a Deepgram account and API key; put it in `.env.local` (Task 1) and in Vercel for Production and Preview (before merge).
2. Confirm Deepgram's data-retention setting on the account matches what the privacy page will say (Task 1, Step 5).
3. Review the eval numbers from Task 17 before merging.

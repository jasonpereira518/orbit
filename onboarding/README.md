# onboarding/

Drafts and evidence for the onboarding audit. Nothing here is product code. Phase 1 changed nothing in `src/`; the first Phase 2 batch is described in the plan's [Implementation status](../ONBOARDING_PLAN.md#implementation-status-first-batch).

| File | What it is |
|---|---|
| [`../ONBOARDING_AUDIT.md`](../ONBOARDING_AUDIT.md) | Flow maps, ranked friction findings (F1–F19), edge cases, what works, and what couldn't be verified |
| [`../ONBOARDING_PLAN.md`](../ONBOARDING_PLAN.md) | Proposed first session, changes by impact and effort (R1–R24), copy deck (C1–C12), events, experiments, and decisions (D1–D11) |
| [`mockups.html`](mockups.html) | Static phone mockups of the four key proposed screens, using the tokens from `src/app/theme.css`. Open it in a browser |
| [`evidence/`](evidence/) | Screenshots E01–E19 cited by the audit |
| [`evidence/after/`](evidence/after/) | Screenshots A01–A15 of the first Phase 2 batch, taken the same way (hosted credits A01–A07, AI paused A08–A15) |

## How the evidence was gathered

- **Environment:** `next dev` in demo mode, with a fresh throwaway PGlite per scenario (`ORBIT_PGLITE_DIR`) and `ORBIT_DEMO_DATA=off`.
- **Real accounting:** `ORBIT_DEMO_MANAGED_AI=off`, so each account behaves like a real Free account with metered credits.
- **The two AI states:**
  - "AI unavailable": no provider keys.
  - "Hosted credits": a local Gemini stub on `GOOGLE_GEMINI_BASE_URL`, a richer copy of `e2e/ai-stub-server.mjs`.
- **How it was driven:** Playwright at 1440×900, and at an iPhone 13 profile with throttled network.
- **Data:** all people are synthetic. No production systems or real user data were touched.
- **In the screenshots:** the round "N" bottom-left is the Next.js dev badge. The name "Met Priya" in the capture screens is an artifact of the stub's name matching, not product behaviour.
